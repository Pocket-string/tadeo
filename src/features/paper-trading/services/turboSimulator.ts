'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import {
  calculateEMA,
  calculateATR,
  calculateADX,
  detectRegime,
} from '@/features/indicators/services/indicatorEngine'
import {
  precomputeIndicators,
  buildContext,
  generateComposite,
  LEGACY_SIGNAL_CONFIG,
  type SignalSystemConfig,
} from '@/features/paper-trading/services/signalRegistry'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import type { OHLCVCandle } from '@/features/market-data/types'
import type { RegimeResult } from '@/features/indicators/types'

// ============================================================
// TURBO SIMULATOR: Months of paper trading in seconds
// ============================================================

// Slippage constants (match paper tick-all for realistic backtests)
const ENTRY_SLIPPAGE = 0.0005   // 0.05% on entry fills
const SL_SLIPPAGE = 0.001       // 0.1% on stop loss exits (worst case)
const TP_SLIPPAGE = 0.0005      // 0.05% on take profit exits

export interface SimTrade {
  type: 'buy' | 'sell'
  entryTime: string
  exitTime: string
  entryPrice: number
  exitPrice: number
  pnl: number
  pnlPct: number
  exitReason: string
}

export interface SimResult {
  symbol: string
  timeframe: string
  params: StrategyParameters
  trades: SimTrade[]
  metrics: {
    totalTrades: number
    winRate: number
    netPnl: number
    netPnlPct: number
    profitFactor: number
    maxDrawdown: number
    sharpeRatio: number
    sortinoRatio: number
    avgTradeDuration: string
    tradesPerMonth: number
  }
  regime: RegimeResult
  duration: number // ms to compute
}

export interface OptimizationResult {
  best: SimResult
  iterations: number
  explored: number
  improvements: { iteration: number; winRate: number; netPnlPct: number; params: Partial<StrategyParameters> }[]
  allResults: SimResult[]
}

/**
 * Run turbo simulation: replay historical candles through the strategy engine.
 * Returns months of paper trading results in seconds.
 */
export async function turboSimulate(input: {
  symbol: string
  timeframe: Timeframe
  params: StrategyParameters
  capitalStart?: number
  monthsBack?: number
  riskPerTrade?: number
}): Promise<SimResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const start = performance.now()
  const capital = input.capitalStart ?? 100
  const monthsBack = input.monthsBack ?? 12

  const endDate = new Date().toISOString()
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - monthsBack)

  const { data: candles, error } = await supabase
    .from('ohlcv_candles')
    .select('timestamp, open, high, low, close, volume')
    .eq('symbol', input.symbol)
    .eq('timeframe', input.timeframe)
    .gte('timestamp', startDate.toISOString())
    .lte('timestamp', endDate)
    .order('timestamp', { ascending: true })
    .limit(50000)

  if (error || !candles || candles.length < 50) {
    throw new Error(`Not enough data: ${candles?.length ?? 0} candles for ${input.symbol} ${input.timeframe}`)
  }

  const result = await simulateOnCandles(candles as OHLCVCandle[], input.params, capital, input.symbol, input.timeframe, input.riskPerTrade)
  result.duration = Math.round(performance.now() - start)
  return result
}

/**
 * Pure simulation engine — no DB calls, just computation.
 * This is the core that runs at max speed.
 */
export async function simulateOnCandles(
  candles: OHLCVCandle[],
  params: StrategyParameters,
  initialCapital: number,
  symbol: string,
  timeframe: string,
  riskPerTrade?: number,
): Promise<SimResult> {
  // Pre-compute all indicators via the unified registry
  const indicators = precomputeIndicators(candles, params)
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)
  const regime = detectRegime(candles, adx, atr, emaFast, emaSlow)

  // Signal system config: use strategy's config or fall back to legacy 3-system
  const signalConfig: SignalSystemConfig[] = params.signal_systems ?? LEGACY_SIGNAL_CONFIG

  const atrValues = Array.from(indicators.atrMap.values())

  const trades: SimTrade[] = []
  let capital = initialCapital
  let peakCapital = initialCapital
  let maxDrawdown = 0

  // Pre-compute EMA for trailing stop if mode is 'ema'
  const trailingEmaMap = params.trailing_stop_mode === 'ema'
    ? new Map(calculateEMA(candles, params.trailing_ema_period ?? 20).map(e => [e.timestamp, e.value]))
    : null

  let position: {
    type: 'buy' | 'sell'
    entryTime: string
    entryPrice: number
    quantity: number
    stopLoss: number
    takeProfit: number
    trailingActivation: number
    trailingStop: number | null
    entryIndex: number
    breakevenHit: boolean
    entryATR: number
  } | null = null

  let prevEF: number | null = null
  let prevES: number | null = null

  const slMult = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
  const tpMult = params.take_profit_pct > 1 ? params.take_profit_pct : 2.5
  const maxHoldingCandles = 50

  for (let i = 0; i < candles.length; i++) {
    const candle = candles[i]
    const ts = candle.timestamp
    const ef = indicators.emaFastMap.get(ts)
    const es = indicators.emaSlowMap.get(ts)
    const currentATR = indicators.atrMap.get(ts)

    if (ef === undefined || es === undefined) {
      if (ef !== undefined) prevEF = ef
      if (es !== undefined) prevES = es
      continue
    }

    // Breakeven: move SL to entry once price advances 0.5x entry ATR
    if (position && !position.breakevenHit && currentATR) {
      const beATR = position.entryATR
      const beActivation = position.type === 'buy'
        ? position.entryPrice + beATR * 0.5
        : position.entryPrice - beATR * 0.5
      if ((position.type === 'buy' && candle.high >= beActivation) ||
          (position.type === 'sell' && candle.low <= beActivation)) {
        position.stopLoss = position.type === 'buy'
          ? Math.max(position.stopLoss, position.entryPrice)
          : Math.min(position.stopLoss, position.entryPrice)
        position.breakevenHit = true
      }
    }

    // Trailing stop update
    if (position && position.trailingStop !== null && currentATR) {
      if (params.trailing_stop_mode === 'ema' && trailingEmaMap) {
        // EMA-based adaptive trailing: SL follows EMA ± 0.5*ATR buffer
        const emaVal = trailingEmaMap.get(ts)
        if (emaVal !== undefined) {
          if (position.type === 'buy') {
            const emaSL = emaVal - currentATR * 0.5
            if (emaSL > position.stopLoss) position.stopLoss = emaSL
          } else {
            const emaSL = emaVal + currentATR * 0.5
            if (emaSL < position.stopLoss) position.stopLoss = emaSL
          }
        }
      } else {
        // Default ATR-based trailing
        if (position.type === 'buy' && candle.high > position.trailingActivation) {
          const newTrail = candle.high - currentATR
          if (newTrail > position.trailingStop) {
            position.trailingStop = newTrail
            if (position.trailingStop > position.stopLoss) position.stopLoss = position.trailingStop
          }
        } else if (position.type === 'sell' && candle.low < position.trailingActivation) {
          const newTrail = candle.low + currentATR
          if (newTrail < position.trailingStop) {
            position.trailingStop = newTrail
            if (position.trailingStop < position.stopLoss) position.stopLoss = position.trailingStop
          }
        }
      }
    }

    // Check SL/TP/Time exit
    if (position) {
      let exitPrice: number | null = null
      let exitReason = ''

      // Time-based exit: close stale positions
      if (i - position.entryIndex >= maxHoldingCandles) {
        exitPrice = candle.close
        exitReason = 'time_exit'
      } else if (position.type === 'buy') {
        if (candle.low <= position.stopLoss) {
          exitPrice = position.stopLoss * (1 - SL_SLIPPAGE) // Slippage worsens SL
          exitReason = 'stop_loss'
        } else if (candle.high >= position.takeProfit) {
          exitPrice = position.takeProfit * (1 - TP_SLIPPAGE) // Slippage reduces TP
          exitReason = 'take_profit'
        }
      } else {
        if (candle.high >= position.stopLoss) {
          exitPrice = position.stopLoss * (1 + SL_SLIPPAGE) // Slippage worsens SL for short
          exitReason = 'stop_loss'
        } else if (candle.low <= position.takeProfit) {
          exitPrice = position.takeProfit * (1 + TP_SLIPPAGE) // Slippage reduces TP for short
          exitReason = 'take_profit'
        }
      }

      if (exitPrice !== null) {
        const pnl = position.type === 'buy'
          ? (exitPrice - position.entryPrice) * position.quantity
          : (position.entryPrice - exitPrice) * position.quantity
        const pnlPct = pnl / (position.entryPrice * position.quantity)

        trades.push({
          type: position.type,
          entryTime: position.entryTime,
          exitTime: ts,
          entryPrice: position.entryPrice,
          exitPrice,
          pnl,
          pnlPct,
          exitReason,
        })

        capital += pnl
        if (capital > peakCapital) peakCapital = capital
        const dd = (peakCapital - capital) / peakCapital
        if (dd > maxDrawdown) maxDrawdown = dd
        position = null
      }
    }

    // Generate signal using the unified N-Signal registry
    if (!position && prevEF !== null && prevES !== null) {
      const ctx = buildContext(candles, i, params, indicators, prevEF, prevES)

      if (ctx) {
        ctx.timeframe = timeframe
        // Regime filtering — skip choppy and volatile markets
        const adxVal = ctx.adx?.adx ?? 0
        const isChoppy = adxVal < 20 && adxVal > 0
        const atrAvg = atrValues.length > 50
          ? atrValues.slice(-50).reduce((s, a) => s + a, 0) / 50
          : 0
        const isVolatile = currentATR !== undefined && atrAvg > 0 && currentATR > 2 * atrAvg

        if (!isChoppy && !isVolatile) {
          const composite = generateComposite(ctx, signalConfig)

          if (composite.direction !== 'neutral' && currentATR) {
            const signal: 'buy' | 'sell' = composite.direction === 'long' ? 'buy' : 'sell'
            const riskAmt = capital * (riskPerTrade ?? 0.02)
            const stopDist = currentATR * slMult
            const qty = riskAmt / stopDist

            if (qty > 0 && riskAmt >= 0.5) {
              const sl = signal === 'buy' ? candle.close - stopDist : candle.close + stopDist
              const tp = signal === 'buy' ? candle.close + currentATR * tpMult : candle.close - currentATR * tpMult
              const trailAct = signal === 'buy' ? candle.close + currentATR : candle.close - currentATR

              // Apply entry slippage (buy higher, sell lower)
              const entryPrice = signal === 'buy'
                ? candle.close * (1 + ENTRY_SLIPPAGE)
                : candle.close * (1 - ENTRY_SLIPPAGE)

              position = {
                type: signal,
                entryTime: ts,
                entryPrice,
                quantity: qty,
                stopLoss: sl,
                takeProfit: tp,
                trailingActivation: trailAct,
                trailingStop: sl,
                entryIndex: i,
                breakevenHit: false,
                entryATR: currentATR,
              }
            }
          }
        }
      }
    }

    prevEF = ef
    prevES = es
  }

  // Close open position at last candle
  if (position && candles.length > 0) {
    const last = candles[candles.length - 1]
    const pnl = position.type === 'buy'
      ? (last.close - position.entryPrice) * position.quantity
      : (position.entryPrice - last.close) * position.quantity
    trades.push({
      type: position.type,
      entryTime: position.entryTime,
      exitTime: last.timestamp,
      entryPrice: position.entryPrice,
      exitPrice: last.close,
      pnl,
      pnlPct: pnl / (position.entryPrice * position.quantity),
      exitReason: 'end_of_data',
    })
    capital += pnl
  }

  // Calculate metrics
  const winners = trades.filter(t => t.pnl > 0)
  const losers = trades.filter(t => t.pnl <= 0)
  const grossProfit = winners.reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(losers.reduce((s, t) => s + t.pnl, 0))

  // Sharpe ratio
  const returns = trades.map(t => t.pnlPct)
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 0
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0

  // Sortino ratio (penalizes only downside volatility)
  const downsideDev = Math.sqrt(
    returns.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / returns.length
  )
  const sortino = downsideDev > 0 ? (avgReturn / downsideDev) * Math.sqrt(252) : 0

  // Average trade duration
  let avgDurationMs = 0
  if (trades.length > 0) {
    const durations = trades.map(t => new Date(t.exitTime).getTime() - new Date(t.entryTime).getTime())
    avgDurationMs = durations.reduce((s, d) => s + d, 0) / durations.length
  }
  const avgDurationHours = Math.round(avgDurationMs / 3600000)

  // Trades per month
  const dataSpanMs = candles.length > 1
    ? new Date(candles[candles.length - 1].timestamp).getTime() - new Date(candles[0].timestamp).getTime()
    : 1
  const dataSpanMonths = dataSpanMs / (30 * 24 * 3600000)
  const tradesPerMonth = dataSpanMonths > 0 ? trades.length / dataSpanMonths : 0

  return {
    symbol,
    timeframe,
    params,
    trades,
    metrics: {
      totalTrades: trades.length,
      winRate: trades.length > 0 ? winners.length / trades.length : 0,
      netPnl: capital - initialCapital,
      netPnlPct: (capital - initialCapital) / initialCapital,
      profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
      maxDrawdown,
      sharpeRatio: sharpe,
      sortinoRatio: sortino,
      avgTradeDuration: `${avgDurationHours}h`,
      tradesPerMonth,
    },
    regime,
    duration: 0,
  }
}

// ============================================================
// GENETIC OPTIMIZER: Evolve strategy parameters automatically
// ============================================================

// PARAM_RANGES extracted to paramRanges.ts (cannot export objects from 'use server' files)
import { PARAM_RANGES } from './paramRanges'

function mutateParams(base: StrategyParameters): StrategyParameters {
  const result = { ...base }
  // Mutate 2-4 random parameters
  const keys = Object.keys(PARAM_RANGES) as (keyof typeof PARAM_RANGES)[]
  const numMutations = 2 + Math.floor(Math.random() * 3)
  const toMutate = keys.sort(() => Math.random() - 0.5).slice(0, numMutations)

  for (const key of toMutate) {
    const range = PARAM_RANGES[key]
    result[key] = range[Math.floor(Math.random() * range.length)]
  }

  // Ensure ema_fast < ema_slow
  if (result.ema_fast >= result.ema_slow) {
    result.ema_slow = result.ema_fast + 10
  }
  // Ensure macd_fast < macd_slow
  if (result.macd_fast >= result.macd_slow) {
    result.macd_slow = result.macd_fast + 10
  }

  return result
}

export async function scoreResult(r: SimResult): Promise<number> {
  const m = r.metrics
  if (m.totalTrades < 10) return -100 // Need statistical significance

  let score = 0

  // Risk-adjusted return is king (35%) — Sharpe penalizes volatility
  score += m.sharpeRatio * 12

  // Profit factor consistency (20%) — winners must outweigh losers in $
  if (m.profitFactor > 1) score += Math.min(20, (m.profitFactor - 1) * 15)
  else score -= (1 - m.profitFactor) * 25

  // Drawdown penalty (15%) — protect capital
  score -= m.maxDrawdown * 25

  // Trade frequency (10%) — strategies must trade enough to be useful
  if (m.tradesPerMonth > 2) score += Math.min(10, m.tradesPerMonth * 1.5)

  // Win rate as tie-breaker (10%)
  score += (m.winRate - 0.45) * 15

  // Statistical robustness (10%) — more trades = more confidence
  if (m.totalTrades >= 10) score += 3
  if (m.totalTrades >= 20) score += 3
  if (m.totalTrades >= 30) score += 2
  if (m.totalTrades >= 50) score += 2

  // Sortino bonus (5%) — reward strategies with good downside protection
  score += Math.min(5, m.sortinoRatio * 2)

  // Anti-overfit: suspiciously high win rate with few trades
  if (m.winRate > 0.85 && m.totalTrades < 20) score -= 10

  return score
}

/**
 * Genetic optimizer: evolve strategy parameters over N generations.
 * Tests parameter variations against historical data at max speed.
 */
export async function optimizeStrategy(input: {
  symbol: string
  timeframe: Timeframe
  baseParams: StrategyParameters
  capitalStart?: number
  monthsBack?: number
  generations?: number
  populationSize?: number
}): Promise<OptimizationResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const capital = input.capitalStart ?? 100
  const monthsBack = input.monthsBack ?? 12
  const generations = input.generations ?? 20
  const popSize = input.populationSize ?? 10

  // Load candles once
  const endDate = new Date().toISOString()
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - monthsBack)

  const { data: candles, error } = await supabase
    .from('ohlcv_candles')
    .select('timestamp, open, high, low, close, volume')
    .eq('symbol', input.symbol)
    .eq('timeframe', input.timeframe)
    .gte('timestamp', startDate.toISOString())
    .lte('timestamp', endDate)
    .order('timestamp', { ascending: true })
    .limit(50000)

  if (error || !candles || candles.length < 50) {
    throw new Error(`Not enough data: ${candles?.length ?? 0} candles`)
  }

  const allResults: SimResult[] = []
  const improvements: OptimizationResult['improvements'] = []

  // Start with base params
  let bestResult = await simulateOnCandles(candles as OHLCVCandle[], input.baseParams, capital, input.symbol, input.timeframe)
  let bestScore = await scoreResult(bestResult)
  allResults.push(bestResult)

  // Evolution loop
  for (let gen = 0; gen < generations; gen++) {
    const population: StrategyParameters[] = []
    for (let i = 0; i < popSize; i++) {
      population.push(mutateParams(bestResult.params))
    }

    for (const params of population) {
      const result = await simulateOnCandles(candles as OHLCVCandle[], params, capital, input.symbol, input.timeframe)
      allResults.push(result)

      const score = await scoreResult(result)
      if (score > bestScore) {
        bestScore = score
        bestResult = result
        improvements.push({
          iteration: gen * popSize + allResults.length,
          winRate: result.metrics.winRate,
          netPnlPct: result.metrics.netPnlPct,
          params: {
            ema_fast: params.ema_fast,
            ema_slow: params.ema_slow,
            rsi_period: params.rsi_period,
            stop_loss_pct: params.stop_loss_pct,
            take_profit_pct: params.take_profit_pct,
          },
        })
      }
    }
  }

  // Score all results for sorting (async scoreResult can't be used in sort comparator)
  const scored = await Promise.all(allResults.map(async r => ({ result: r, score: await scoreResult(r) })))
  scored.sort((a, b) => b.score - a.score)

  return {
    best: bestResult,
    iterations: generations,
    explored: allResults.length,
    improvements,
    allResults: scored.slice(0, 10).map(s => s.result),
  }
}
