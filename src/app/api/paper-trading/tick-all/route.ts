import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getCandles } from '@/features/market-data/services/marketDataService'
import { calculateATR, calculateEMA } from '@/features/indicators/services/indicatorEngine'
import { getLivePrice } from '@/features/paper-trading/services/priceService'
import {
  precomputeIndicators,
  buildContext,
  generateComposite,
  generateAdaptiveComposite,
  type SignalSystemConfig,
} from '@/features/paper-trading/services/signalRegistry'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import { RISK_TIERS, type RiskTier } from '@/features/paper-trading/types'

// Service role client — bypasses RLS to tick ALL active sessions
function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface TickResult {
  sessionId: string
  symbol: string
  timeframe: string
  riskTier: string
  action: string
  reason: string
  price?: number
  pnl?: number
}

// Signal check result with rejection reason for observability
type SignalCheckResult =
  | { signal: 'buy' | 'sell'; atr: number; reason: string; activeSystems: string[] }
  | { signal: null; rejectionReason: string }

export async function POST(req: NextRequest) {
  // Auth: accept cron secret OR service role key suffix
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const serviceKeySuffix = process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(-10)

  const providedToken = authHeader?.replace('Bearer ', '')
  const isAuthorized =
    (cronSecret && providedToken === cronSecret) ||
    (serviceKeySuffix && providedToken === serviceKeySuffix)

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Reset ALL per-invocation caches
  htfBiasCache = new Map()
  atrCache.clear()

  const supabase = getServiceClient()
  const results: TickResult[] = []

  // Get all active paper sessions with their strategy parameters
  const { data: sessions, error: sessErr } = await supabase
    .from('paper_sessions')
    .select('*, strategies(parameters)')
    .eq('status', 'active')

  if (sessErr || !sessions || sessions.length === 0) {
    return NextResponse.json({
      message: 'No active sessions',
      sessions: 0,
      results: [],
    })
  }

  // Cache prices and signals per symbol+timeframe to avoid redundant API calls
  const priceCache = new Map<string, number>()
  const signalCache = new Map<string, SignalCheckResult>()

  for (const session of sessions) {
    const riskTier: RiskTier = (session.risk_tier as RiskTier) || 'moderate'
    try {
      const params = (session.strategies as { parameters: StrategyParameters }).parameters

      // Get price (cached per symbol) — wrapped in try/catch so one symbol failure doesn't crash all
      if (!priceCache.has(session.symbol)) {
        try {
          const priceData = await getLivePrice(session.symbol)
          priceCache.set(session.symbol, priceData.price)
        } catch (priceErr) {
          results.push({
            sessionId: session.id,
            symbol: session.symbol,
            timeframe: session.timeframe,
            riskTier,
            action: 'error',
            reason: `Price fetch failed: ${priceErr instanceof Error ? priceErr.message : 'Unknown'}`,
          })
          continue
        }
      }
      const price = priceCache.get(session.symbol)!

      // Check open trades for this SESSION specifically
      const { data: openTrades } = await supabase
        .from('paper_trades')
        .select('*')
        .eq('session_id', session.id)
        .eq('status', 'open')

      if (openTrades && openTrades.length > 0) {
        const trade = openTrades[0]
        const sl = Number(trade.stop_loss)
        const tp = Number(trade.take_profit)
        let closed = false
        let exitPrice = 0
        let exitReason = ''

        if (trade.type === 'buy') {
          if (price <= sl) { exitPrice = sl; exitReason = 'stop_loss'; closed = true }
          else if (price >= tp) { exitPrice = tp; exitReason = 'take_profit'; closed = true }
        } else {
          if (price >= sl) { exitPrice = sl; exitReason = 'stop_loss'; closed = true }
          else if (price <= tp) { exitPrice = tp; exitReason = 'take_profit'; closed = true }
        }

        if (closed) {
          const entryPrice = Number(trade.entry_price)
          const qty = Number(trade.quantity)
          const pnl = trade.type === 'buy'
            ? (exitPrice - entryPrice) * qty
            : (entryPrice - exitPrice) * qty
          const pnlPct = pnl / (entryPrice * qty)

          await supabase
            .from('paper_trades')
            .update({
              status: 'closed',
              exit_price: exitPrice,
              exit_time: new Date().toISOString(),
              exit_reason: exitReason,
              pnl,
              pnl_pct: pnlPct,
            })
            .eq('id', trade.id)

          // Update session stats (scoped to this session's trades)
          await updateSessionStats(supabase, session.id, session.initial_capital)

          results.push({
            sessionId: session.id,
            symbol: session.symbol,
            timeframe: session.timeframe,
            riskTier,
            action: 'close',
            reason: `${exitReason} at ${exitPrice.toFixed(2)}`,
            price,
            pnl,
          })
          continue
        }

        // Trailing stop: update SL if price moved favorably
        const cacheKey = `${session.symbol}:${session.timeframe}`
        const currentATR = await getCachedATR(cacheKey, session.symbol, session.timeframe as Timeframe, supabase)
        if (currentATR) {
          const entryPrice = Number(trade.entry_price)
          const trailActivation = trade.type === 'buy'
            ? entryPrice + currentATR
            : entryPrice - currentATR

          if (trade.type === 'buy' && price > trailActivation) {
            const newTrailSL = price - currentATR
            if (newTrailSL > sl) {
              await supabase
                .from('paper_trades')
                .update({ stop_loss: newTrailSL })
                .eq('id', trade.id)

              results.push({
                sessionId: session.id,
                symbol: session.symbol,
                timeframe: session.timeframe,
                riskTier,
                action: 'trail',
                reason: `Trailing SL raised to ${newTrailSL.toFixed(2)}`,
                price,
              })
              continue
            }
          } else if (trade.type === 'sell' && price < trailActivation) {
            const newTrailSL = price + currentATR
            if (newTrailSL < sl) {
              await supabase
                .from('paper_trades')
                .update({ stop_loss: newTrailSL })
                .eq('id', trade.id)

              results.push({
                sessionId: session.id,
                symbol: session.symbol,
                timeframe: session.timeframe,
                riskTier,
                action: 'trail',
                reason: `Trailing SL lowered to ${newTrailSL.toFixed(2)}`,
                price,
              })
              continue
            }
          }
        }

        results.push({
          sessionId: session.id,
          symbol: session.symbol,
          timeframe: session.timeframe,
          riskTier,
          action: 'hold',
          reason: `Position open: ${trade.type} @ ${trade.entry_price}`,
          price,
        })
        continue
      }

      // No open position — check for signal (cached per symbol+timeframe)
      const sigKey = `${session.symbol}:${session.timeframe}`
      if (!signalCache.has(sigKey)) {
        signalCache.set(sigKey, await checkSignalFull(session.symbol, session.timeframe as Timeframe, params, supabase))
      }
      const signalResult = signalCache.get(sigKey)!

      if (signalResult.signal === null) {
        results.push({
          sessionId: session.id,
          symbol: session.symbol,
          timeframe: session.timeframe,
          riskTier,
          action: 'no_signal',
          reason: signalResult.rejectionReason,
          price,
        })
        continue
      }

      const { signal, atr: currentATR, reason: signalReason, activeSystems: signalSystems } = signalResult

      // Open paper trade with ATR-based SL/TP
      const slMult = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
      const tpMult = params.take_profit_pct > 1 ? params.take_profit_pct : 2.5
      const stopDist = currentATR * slMult
      const riskPct = RISK_TIERS[riskTier]?.riskPerTrade ?? 0.03
      const riskAmount = Number(session.current_capital) * riskPct
      const quantity = riskAmount / stopDist

      if (riskAmount < 0.5 || quantity <= 0) {
        results.push({
          sessionId: session.id,
          symbol: session.symbol,
          timeframe: session.timeframe,
          riskTier,
          action: 'hold',
          reason: 'Capital insuficiente',
          price,
        })
        continue
      }

      const stopLoss = signal === 'buy'
        ? price - stopDist
        : price + stopDist
      const takeProfit = signal === 'buy'
        ? price + currentATR * tpMult
        : price - currentATR * tpMult

      // INSERT with conflict guard — unique index prevents duplicate open trades
      const { data: inserted } = await supabase
        .from('paper_trades')
        .insert({
          user_id: session.user_id,
          strategy_id: session.strategy_id,
          session_id: session.id,
          symbol: session.symbol,
          timeframe: session.timeframe,
          type: signal,
          entry_price: price,
          quantity,
          stop_loss: stopLoss,
          take_profit: takeProfit,
          metadata: { active_systems: signalSystems ?? [] },
        })
        .select('id')

      // If conflict (duplicate open trade), skip silently
      if (!inserted || inserted.length === 0) continue

      results.push({
        sessionId: session.id,
        symbol: session.symbol,
        timeframe: session.timeframe,
        riskTier,
        action: signal,
        reason: `[${riskTier}] ${signalReason} | SL:${stopLoss.toFixed(2)} TP:${takeProfit.toFixed(2)} Qty:${quantity.toFixed(4)}`,
        price,
      })
    } catch (err) {
      results.push({
        sessionId: session.id,
        symbol: session.symbol,
        timeframe: session.timeframe,
        riskTier,
        action: 'error',
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // Log all agent decisions to paper_agent_log (non-blocking, with error logging)
  const logsToInsert = results.map(r => ({
    session_id: r.sessionId,
    symbol: r.symbol,
    timeframe: r.timeframe,
    event_type: r.action,
    reason: r.reason,
    price: r.price ?? null,
    pnl: r.pnl ?? null,
  }))
  if (logsToInsert.length > 0) {
    supabase.from('paper_agent_log').insert(logsToInsert)
      .then(({ error }) => { if (error) console.error('Agent log insert failed:', error.message) })
  }

  return NextResponse.json({
    message: `Ticked ${sessions.length} sessions`,
    sessions: sessions.length,
    results,
    timestamp: new Date().toISOString(),
  })
}

async function updateSessionStats(
  supabase: SupabaseClient,
  sessionId: string,
  initialCapital: number
) {
  // Count only trades belonging to THIS session
  const { data: trades } = await supabase
    .from('paper_trades')
    .select('pnl')
    .eq('session_id', sessionId)
    .eq('status', 'closed')

  if (!trades) return

  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl), 0)
  const winning = trades.filter(t => Number(t.pnl) > 0).length

  await supabase
    .from('paper_sessions')
    .update({
      total_trades: trades.length,
      winning_trades: winning,
      net_pnl: totalPnl,
      current_capital: Number(initialCapital) + totalPnl,
    })
    .eq('id', sessionId)
}

// ATR cache — reset each POST invocation
const atrCache = new Map<string, number | null>()

// HTF bias cache — keyed by `symbol:htf` — reset each POST invocation
let htfBiasCache = new Map<string, 'bull' | 'bear' | 'neutral'>()

async function getCachedATR(key: string, symbol: string, timeframe: Timeframe, dbClient: SupabaseClient): Promise<number | null> {
  if (atrCache.has(key)) return atrCache.get(key)!
  const val = await getCurrentATR(symbol, timeframe, dbClient)
  atrCache.set(key, val)
  return val
}

async function getCurrentATR(symbol: string, timeframe: Timeframe, dbClient: SupabaseClient): Promise<number | null> {
  try {
    const endDate = new Date().toISOString()
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 100 }, { client: dbClient })
    if (candles.length < 20) return null

    const atr = calculateATR(candles, 14)
    return atr.length > 0 ? atr[atr.length - 1].value : null
  } catch {
    return null
  }
}

/**
 * Full signal check using the N-Signal registry.
 * Returns typed result with rejection reason for observability.
 */
async function checkSignalFull(
  symbol: string,
  timeframe: Timeframe,
  params: StrategyParameters,
  dbClient: SupabaseClient
): Promise<SignalCheckResult> {
  const endDate = new Date().toISOString()
  const startDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 200 }, { client: dbClient })
  if (candles.length < 50) return { signal: null, rejectionReason: `insufficient_candles:${candles.length}` }

  // Staleness check — reject if last candle is older than 3 candle periods
  const tfMs = getTimeframeMs(timeframe)
  if (tfMs > 0) {
    const lastTs = new Date(candles[candles.length - 1].timestamp).getTime()
    const staleness = Date.now() - lastTs
    if (staleness > tfMs * 3) {
      return { signal: null, rejectionReason: `stale_data:${Math.round(staleness / 60000)}min` }
    }
  }

  // Pre-compute all indicators
  const indicators = precomputeIndicators(candles, params)
  const lastIndex = candles.length - 1
  const prevIndex = candles.length - 2

  // Need previous EMA values for crossover detection
  const prevTs = candles[prevIndex].timestamp
  const prevEF = indicators.emaFastMap.get(prevTs)
  const prevES = indicators.emaSlowMap.get(prevTs)
  if (prevEF === undefined || prevES === undefined) return { signal: null, rejectionReason: 'missing_prev_ema' }

  // Build signal context for the latest candle
  const ctx = buildContext(candles, lastIndex, params, indicators, prevEF, prevES)
  if (!ctx) return { signal: null, rejectionReason: 'context_build_failed' }

  // Regime filtering — skip choppy and volatile markets
  // ADX thresholds calibrated for crypto (lower than forex/stocks)
  const adxVal = ctx.adx?.adx ?? 0
  const adxChoppyThreshold = (timeframe === '4h' || timeframe === '1d') ? 10
    : (timeframe === '1m' || timeframe === '5m' || timeframe === '15m') ? 13
    : 15
  const isChoppy = adxVal < adxChoppyThreshold && adxVal > 0
  const atrValues = Array.from(indicators.atrMap.values())
  const atrAvg = atrValues.length > 50
    ? atrValues.slice(-50).reduce((s, a) => s + a, 0) / 50
    : 0
  const isVolatile = atrAvg > 0 && ctx.atr > 3 * atrAvg

  if (isChoppy) return { signal: null, rejectionReason: `choppy:ADX=${adxVal.toFixed(1)}<${adxChoppyThreshold}` }
  if (isVolatile) return { signal: null, rejectionReason: `volatile:ATR=${ctx.atr.toFixed(4)}>3x(${atrAvg.toFixed(4)})` }

  // Use strategy's signal_systems config if set; otherwise use adaptive composite
  const composite = params.signal_systems
    ? generateComposite(ctx, params.signal_systems as SignalSystemConfig[])
    : generateAdaptiveComposite(ctx)

  if (composite.direction === 'neutral') {
    return { signal: null, rejectionReason: `neutral_composite:conf=${composite.totalConfidence.toFixed(3)},systems=[${composite.activeSystems.join(',')}]` }
  }

  const signal: 'buy' | 'sell' = composite.direction === 'long' ? 'buy' : 'sell'

  // Higher-timeframe trend filter — block signals against 4h/1d trend
  const htfBias = await getCachedHTFBias(symbol, timeframe, dbClient)
  if (htfBias === 'bull' && signal === 'sell') return { signal: null, rejectionReason: `htf_blocked:bias=bull,signal=sell` }
  if (htfBias === 'bear' && signal === 'buy') return { signal: null, rejectionReason: `htf_blocked:bias=bear,signal=buy` }

  const reason = composite.activeSystems.join(' + ')

  return { signal, atr: ctx.atr, reason, activeSystems: composite.activeSystems }
}

async function getCachedHTFBias(symbol: string, currentTf: Timeframe, dbClient: SupabaseClient): Promise<'bull' | 'bear' | 'neutral'> {
  const htf: Timeframe = (currentTf === '4h' || currentTf === '1d') ? '1d' : '4h'
  const key = `${symbol}:${htf}`
  if (htfBiasCache.has(key)) return htfBiasCache.get(key)!

  const bias = await computeHTFBias(symbol, htf, dbClient)
  htfBiasCache.set(key, bias)
  return bias
}

async function computeHTFBias(symbol: string, htf: Timeframe, dbClient: SupabaseClient): Promise<'bull' | 'bear' | 'neutral'> {
  try {
    const endDate = new Date().toISOString()
    const startDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    const candles = await getCandles({ symbol, timeframe: htf, startDate, endDate, limit: 60 }, { client: dbClient })
    if (candles.length < 50) return 'neutral'

    const ema50 = calculateEMA(candles, 50)
    if (ema50.length === 0) return 'neutral'

    const lastClose = candles[candles.length - 1].close
    const lastEMA = ema50[ema50.length - 1].value
    const diff = (lastClose - lastEMA) / lastEMA

    if (diff > 0.005) return 'bull'   // >0.5% above EMA50
    if (diff < -0.005) return 'bear'  // >0.5% below EMA50
    return 'neutral'
  } catch {
    return 'neutral'
  }
}

function getTimeframeMs(tf: Timeframe): number {
  const map: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
  }
  return map[tf] ?? 0
}
