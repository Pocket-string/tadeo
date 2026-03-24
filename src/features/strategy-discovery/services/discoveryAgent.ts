import { createClient } from '@supabase/supabase-js'
import { buildAnalysisContext } from '@/features/ai-analyst/services/aiAnalyst'
import { simulateOnCandles, scoreResult } from '@/features/paper-trading/services/turboSimulator'
import type { SimResult } from '@/features/paper-trading/services/turboSimulator'
import { generateHypotheses } from './hypothesisGenerator'
import { collectPaperFeedback, formatFeedbackForPrompt } from './feedbackCollector'
import type { DiscoveryResult, StrategyHypothesis } from '../types'
import type { OHLCVCandle } from '@/features/market-data/types'
import type { Timeframe } from '@/features/market-data/types'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface DiscoveryConfig {
  symbols: string[]
  timeframes: Timeframe[]
  /** Explicit symbol+timeframe pairs (overrides cross-product of symbols × timeframes) */
  symbolTimeframePairs?: { symbol: string; timeframe: Timeframe }[]
  userId: string
  hypothesesPerMarket?: number
  minScore?: number
  monthsBack?: number
  /** Failure context from a retired session — passed to AI to avoid repeating mistakes */
  failureContext?: string
}

/**
 * Main discovery loop: SCAN → ANALYZE → HYPOTHESIZE → BACKTEST → SCORE → PROPOSE
 * Runs autonomously and saves winning strategies as proposals for human approval.
 */
export async function runDiscoveryLoop(config: DiscoveryConfig & { trigger?: string }): Promise<{
  proposals: number
  scanned: number
  tested: number
  errors: string[]
  runId?: string
}> {
  const supabase = getServiceClient()
  const hypothesesPerMarket = config.hypothesesPerMarket ?? 3
  const minScore = config.minScore ?? 5
  const monthsBack = config.monthsBack ?? 6
  const errors: string[] = []
  const startTime = Date.now()

  let scanned = 0
  let tested = 0
  let proposals = 0
  let hypothesesGenerated = 0
  let proposalsRejected = 0

  // Log run start
  const { data: run } = await supabase
    .from('discovery_runs')
    .insert({
      user_id: config.userId,
      trigger: config.trigger ?? 'cron',
      symbols: config.symbols,
      timeframes: config.timeframes,
      started_at: new Date().toISOString(),
    })
    .select('id')
    .single()

  // Collect paper trading feedback to inform hypothesis generation
  let feedbackContext = ''
  try {
    const feedback = await collectPaperFeedback(config.userId)
    feedbackContext = formatFeedbackForPrompt(feedback)
  } catch {
    // Non-blocking: discovery works without feedback
  }

  // Prepend failure context if triggered by auto-retire (avoids repeating same mistakes)
  if (config.failureContext) {
    feedbackContext = config.failureContext + '\n\n' + feedbackContext
  }

  // Use explicit pairs if provided, otherwise cross-product
  const pairs = config.symbolTimeframePairs
    ?? config.symbols.flatMap(s => config.timeframes.map(tf => ({ symbol: s, timeframe: tf })))

  for (const { symbol, timeframe } of pairs) {
      scanned++
      try {
        // Step 1: SCAN — Fetch candles
        const endDate = new Date().toISOString()
        const startDate = new Date()
        startDate.setMonth(startDate.getMonth() - monthsBack)

        const { data: candles, error: candleErr } = await supabase
          .from('ohlcv_candles')
          .select('timestamp, open, high, low, close, volume')
          .eq('symbol', symbol)
          .eq('timeframe', timeframe)
          .gte('timestamp', startDate.toISOString())
          .lte('timestamp', endDate)
          .order('timestamp', { ascending: true })
          .limit(50000)

        if (candleErr || !candles || candles.length < 50) {
          errors.push(`${symbol}/${timeframe}: Not enough data (${candles?.length ?? 0} candles)`)
          continue
        }

        // Step 2: ANALYZE — Build market context (pass service client to bypass RLS in cron context)
        const context = await buildAnalysisContext(symbol, timeframe, { client: supabase })

        // Step 3: HYPOTHESIZE — AI generates strategy combinations (informed by paper trading feedback)
        const hypotheses = await generateHypotheses(context, hypothesesPerMarket, feedbackContext)
        hypothesesGenerated += hypotheses.length

        // Step 4: BACKTEST + OPTIMIZE each hypothesis
        for (const hypothesis of hypotheses) {
          tested++
          try {
            const result = await backtestAndOptimize(
              candles as OHLCVCandle[],
              hypothesis,
              symbol,
              timeframe
            )

            if (!result) {
              proposalsRejected++
              continue
            }
            if (result.score < minScore) {
              console.log(`[discovery] ${symbol}/${timeframe} REJECTED: score too low (${result.score.toFixed(1)} < ${minScore})`)
              proposalsRejected++
              continue
            }

            // Step 5: PROPOSE — Save to DB for human approval
            const { error: insertErr } = await supabase
              .from('strategy_proposals')
              .insert({
                user_id: config.userId,
                symbol,
                timeframe,
                signal_config: result.hypothesis.signalConfig,
                optimized_params: result.optimizedParams,
                backtest_results: result.backtestMetrics,
                ai_rationale: result.hypothesis.rationale,
                ai_review_verdict: result.aiReview.verdict,
                score: result.score,
                status: 'pending',
              })

            if (insertErr) {
              errors.push(`${symbol}/${timeframe}: DB insert failed: ${insertErr.message}`)
            } else {
              proposals++
            }
          } catch (err) {
            errors.push(`${symbol}/${timeframe} hypothesis: ${err instanceof Error ? err.message : 'Unknown'}`)
          }
        }
      } catch (err) {
        errors.push(`${symbol}/${timeframe}: ${err instanceof Error ? err.message : 'Unknown'}`)
      }
  }

  // Log run completion
  if (run?.id) {
    await supabase
      .from('discovery_runs')
      .update({
        hypotheses_generated: hypothesesGenerated,
        hypotheses_tested: tested,
        proposals_saved: proposals,
        proposals_rejected: proposalsRejected,
        errors,
        duration_ms: Date.now() - startTime,
        completed_at: new Date().toISOString(),
      })
      .eq('id', run.id)
  }

  return { proposals, scanned, tested, errors, runId: run?.id }
}

/**
 * Backtest a hypothesis and run a mini genetic optimization.
 * Returns null if the strategy doesn't meet minimum quality thresholds.
 */
async function backtestAndOptimize(
  candles: OHLCVCandle[],
  hypothesis: StrategyHypothesis,
  symbol: string,
  timeframe: string
): Promise<DiscoveryResult | null> {
  const capital = 100

  // Walk-Forward Validation: train on 70%, validate on 30%
  const splitIdx = Math.floor(candles.length * 0.7)
  const trainCandles = candles.slice(0, splitIdx)
  const validCandles = candles.slice(splitIdx)

  if (trainCandles.length < 50 || validCandles.length < 20) {
    console.log(`[discovery] ${symbol}/${timeframe} REJECTED: insufficient split data (train=${trainCandles.length}, valid=${validCandles.length})`)
    return null
  }

  // Initial backtest on TRAINING set only
  const baseResult = await simulateOnCandles(
    trainCandles,
    hypothesis.baseParams,
    capital,
    symbol,
    timeframe,
    0.02
  )

  const baseScore = await scoreResult(baseResult)

  // Quick optimization on TRAINING set: 10 generations × 8 population
  let bestResult = baseResult
  let bestScore = baseScore
  let bestParams = hypothesis.baseParams

  for (let gen = 0; gen < 10; gen++) {
    for (let i = 0; i < 8; i++) {
      const mutated = quickMutate(bestParams)
      const result = await simulateOnCandles(trainCandles, mutated, capital, symbol, timeframe, 0.02)
      const score = await scoreResult(result)

      if (score > bestScore) {
        bestScore = score
        bestResult = result
        bestParams = mutated
      }
    }
  }

  // Minimum quality gate on training set (raised from 10 → 20 trades, 2026-03-24 anti-overfit)
  if (bestResult.metrics.totalTrades < 20 || bestScore < 0) {
    console.log(`[discovery] ${symbol}/${timeframe} REJECTED: training quality (trades=${bestResult.metrics.totalTrades}, score=${bestScore.toFixed(1)})`)
    return null
  }

  // Walk-Forward Validation: run best params on UNSEEN validation data
  // Raised from 3 → 8 min trades (2026-03-24 — 3 trades was statistically meaningless)
  const validation = await simulateOnCandles(validCandles, bestParams, capital, symbol, timeframe, 0.02)
  if (validation.metrics.totalTrades < 8 || validation.metrics.winRate < 0.35 || validation.metrics.netPnlPct < 0) {
    console.log(`[discovery] ${symbol}/${timeframe} REJECTED: walk-forward validation (trades=${validation.metrics.totalTrades}, WR=${(validation.metrics.winRate * 100).toFixed(1)}%, PnL=${(validation.metrics.netPnlPct * 100).toFixed(1)}%)`)
    return null // Failed out-of-sample validation — likely overfitted
  }

  // Use FULL dataset metrics for the proposal (but only if validation passed)
  const fullResult = await simulateOnCandles(candles, bestParams, capital, symbol, timeframe, 0.02)
  bestResult = fullResult
  bestScore = await scoreResult(fullResult)

  // Simple AI review based on metrics (avoid API call for speed)
  const review = quickReview(bestResult)

  return {
    hypothesis: { ...hypothesis, baseParams: bestParams },
    backtestMetrics: {
      totalTrades: bestResult.metrics.totalTrades,
      winRate: bestResult.metrics.winRate,
      netPnlPct: bestResult.metrics.netPnlPct,
      profitFactor: bestResult.metrics.profitFactor,
      maxDrawdown: bestResult.metrics.maxDrawdown,
      sharpeRatio: bestResult.metrics.sharpeRatio,
      tradesPerMonth: bestResult.metrics.tradesPerMonth,
    },
    score: bestScore,
    aiReview: review,
    optimizedParams: bestParams,
  }
}

/** Quick parameter mutation for mini-optimization */
function quickMutate(params: typeof import('@/types/database').DEFAULT_STRATEGY_PARAMS): typeof params {
  const result = { ...params }
  const keys: (keyof typeof result)[] = [
    'ema_fast', 'ema_slow', 'rsi_period', 'rsi_oversold', 'rsi_overbought',
    'stop_loss_pct', 'take_profit_pct', 'bb_period', 'bb_std_dev',
  ]

  // Mutate 2-3 parameters
  const numMutations = 2 + Math.floor(Math.random() * 2)
  const toMutate = keys.sort(() => Math.random() - 0.5).slice(0, numMutations)

  const ranges: Record<string, number[]> = {
    ema_fast: [3, 5, 7, 9, 12, 15, 20],
    ema_slow: [15, 20, 21, 26, 30, 40, 50, 60],
    rsi_period: [7, 10, 14, 21],
    rsi_oversold: [20, 25, 30, 35],
    rsi_overbought: [65, 70, 75, 80],
    stop_loss_pct: [0.5, 0.7, 0.8, 1.0, 1.2, 1.5],
    take_profit_pct: [2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0],
    bb_period: [14, 20, 25],
    bb_std_dev: [1.5, 2, 2.5],
  }

  for (const key of toMutate) {
    const range = ranges[key]
    if (range) {
      (result as unknown as Record<string, number>)[key] = range[Math.floor(Math.random() * range.length)]
    }
  }

  // Constraints
  if (result.ema_fast >= result.ema_slow) result.ema_slow = result.ema_fast + 10
  if (result.macd_fast >= result.macd_slow) result.macd_slow = result.macd_fast + 10

  return result
}

/** Rule-based review (fast, no API call) */
function quickReview(result: SimResult): DiscoveryResult['aiReview'] {
  const m = result.metrics
  let verdict: 'approve' | 'caution' | 'reject' = 'reject'
  let confidence = 0.3

  const checks = {
    profitableEnough: m.netPnlPct > 0.05,
    goodWinRate: m.winRate > 0.5,
    positiveSharpe: m.sharpeRatio > 0.5,
    lowDrawdown: m.maxDrawdown < 0.25,
    enoughTrades: m.totalTrades >= 10,
    goodProfitFactor: m.profitFactor > 1.2,
  }

  const passCount = Object.values(checks).filter(Boolean).length

  if (passCount >= 5) {
    verdict = 'approve'
    confidence = 0.6 + passCount * 0.05
  } else if (passCount >= 3) {
    verdict = 'caution'
    confidence = 0.4 + passCount * 0.05
  }

  const overfittingRisk: 'low' | 'medium' | 'high' =
    m.totalTrades >= 30 ? 'low' :
    m.totalTrades >= 15 ? 'medium' : 'high'

  const summary = `${m.totalTrades} trades, WR ${(m.winRate * 100).toFixed(0)}%, PnL ${(m.netPnlPct * 100).toFixed(1)}%, Sharpe ${m.sharpeRatio.toFixed(2)}, DD ${(m.maxDrawdown * 100).toFixed(1)}%. ${passCount}/6 quality checks passed.`

  return { verdict, confidence: Math.min(1, confidence), summary, overfittingRisk }
}
