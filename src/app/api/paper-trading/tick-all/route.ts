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

// ── Slippage simulation for realistic paper trading ─────────────────────────
// SL slippage is higher because stop-loss fills are market orders during fast moves
const SLIPPAGE_SL = 0.001   // 0.1% — stop loss exits (market order in real trading)
const SLIPPAGE_TP = 0.0005  // 0.05% — take profit exits (limit order, less slippage)
const SLIPPAGE_ENTRY = 0.0005 // 0.05% — entry fills (market order but no urgency)

// ── Circuit Breaker thresholds ──────────────────────────────────────────────
const MAX_DRAWDOWN_PCT = 0.25      // 25% max drawdown before auto-pause (aligned with evaluate auto-retire)
const MAX_CONSECUTIVE_LOSSES = 3   // pause after N consecutive losses
const COOLDOWN_MS = 60 * 60 * 1000 // 1 hour cooldown after consecutive losses

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

  // Pre-fetch recent losses per session for consecutive-loss circuit breaker
  const consecutiveLossCache = new Map<string, { count: number; lastLossAt: string | null }>()
  {
    const { data: recentTrades } = await supabase
      .from('paper_trades')
      .select('session_id, pnl, exit_time')
      .in('session_id', sessions.map(s => s.id))
      .eq('status', 'closed')
      .order('exit_time', { ascending: false })
      .limit(500)

    if (recentTrades) {
      // Group by session and count consecutive losses from most recent
      const bySession = new Map<string, { pnl: number; exit_time: string }[]>()
      for (const t of recentTrades) {
        const list = bySession.get(t.session_id) || []
        list.push({ pnl: Number(t.pnl), exit_time: t.exit_time })
        bySession.set(t.session_id, list)
      }
      for (const [sid, trades] of bySession) {
        let count = 0
        for (const t of trades) { // already sorted most recent first
          if (t.pnl < 0) count++
          else break
        }
        consecutiveLossCache.set(sid, {
          count,
          lastLossAt: count > 0 ? trades[0].exit_time : null,
        })
      }
    }
  }

  for (const session of sessions) {
    const riskTier: RiskTier = (session.risk_tier as RiskTier) || 'moderate'
    try {
      const params = (session.strategies as { parameters: StrategyParameters }).parameters

      // ── Circuit Breaker 1: Max Drawdown (15%) ──────────────────────────
      // If session has lost more than 15% of initial capital, auto-pause
      const drawdownPct = Number(session.net_pnl) / Number(session.initial_capital)
      if (drawdownPct <= -MAX_DRAWDOWN_PCT) {
        await supabase
          .from('paper_sessions')
          .update({ status: 'paused', max_drawdown: Math.abs(drawdownPct) })
          .eq('id', session.id)

        results.push({
          sessionId: session.id,
          symbol: session.symbol,
          timeframe: session.timeframe,
          riskTier,
          action: 'circuit_breaker',
          reason: `PAUSED: drawdown ${(drawdownPct * 100).toFixed(1)}% exceeded -${MAX_DRAWDOWN_PCT * 100}% limit`,
          price: 0,
        })
        continue
      }

      // ── Circuit Breaker 2: Consecutive Losses → cooldown ──────────────
      const lossInfo = consecutiveLossCache.get(session.id)
      if (lossInfo && lossInfo.count >= MAX_CONSECUTIVE_LOSSES && lossInfo.lastLossAt) {
        const lastLossTime = new Date(lossInfo.lastLossAt).getTime()
        const elapsed = Date.now() - lastLossTime
        if (elapsed < COOLDOWN_MS) {
          const remainMin = Math.ceil((COOLDOWN_MS - elapsed) / 60000)
          results.push({
            sessionId: session.id,
            symbol: session.symbol,
            timeframe: session.timeframe,
            riskTier,
            action: 'cooldown',
            reason: `${lossInfo.count} consecutive losses — cooldown ${remainMin}min remaining`,
            price: 0,
          })
          continue
        }
      }

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

        // Simulate slippage: SL exits get 0.1% worse, TP exits get 0.05% worse
        if (trade.type === 'buy') {
          if (price <= sl) {
            exitPrice = sl * (1 - SLIPPAGE_SL) // slips lower on SL
            exitReason = 'stop_loss'; closed = true
          } else if (price >= tp) {
            exitPrice = tp * (1 - SLIPPAGE_TP) // slightly worse on TP
            exitReason = 'take_profit'; closed = true
          }
        } else {
          if (price >= sl) {
            exitPrice = sl * (1 + SLIPPAGE_SL) // slips higher on SL (worse for short)
            exitReason = 'stop_loss'; closed = true
          } else if (price <= tp) {
            exitPrice = tp * (1 + SLIPPAGE_TP)
            exitReason = 'take_profit'; closed = true
          }
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

      // Apply entry slippage: buy fills slightly higher, sell fills slightly lower
      const entryPrice = signal === 'buy'
        ? price * (1 + SLIPPAGE_ENTRY)
        : price * (1 - SLIPPAGE_ENTRY)

      const stopLoss = signal === 'buy'
        ? entryPrice - stopDist
        : entryPrice + stopDist
      const takeProfit = signal === 'buy'
        ? entryPrice + currentATR * tpMult
        : entryPrice - currentATR * tpMult

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
          entry_price: entryPrice,
          quantity,
          stop_loss: stopLoss,
          take_profit: takeProfit,
          metadata: { active_systems: signalSystems ?? [], slippage: SLIPPAGE_ENTRY },
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
        reason: `[${riskTier}] ${signalReason} | Entry:${entryPrice.toFixed(2)}(+slip) SL:${stopLoss.toFixed(2)} TP:${takeProfit.toFixed(2)} Qty:${quantity.toFixed(4)}`,
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
  // Count only trades belonging to THIS session, ordered by exit time
  const { data: trades } = await supabase
    .from('paper_trades')
    .select('pnl, exit_time')
    .eq('session_id', sessionId)
    .eq('status', 'closed')
    .order('exit_time', { ascending: true })

  if (!trades) return

  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl), 0)
  const winning = trades.filter(t => Number(t.pnl) > 0).length

  // Calculate max drawdown from equity curve
  const cap = Number(initialCapital)
  let peak = cap
  let maxDD = 0
  let running = cap
  for (const t of trades) {
    running += Number(t.pnl)
    if (running > peak) peak = running
    const dd = (peak - running) / peak
    if (dd > maxDD) maxDD = dd
  }

  await supabase
    .from('paper_sessions')
    .update({
      total_trades: trades.length,
      winning_trades: winning,
      net_pnl: totalPnl,
      current_capital: cap + totalPnl,
      max_drawdown: maxDD,
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
    const tfMs = getTimeframeMs(timeframe)
    const lookbackMs = tfMs > 0 ? tfMs * 120 : 30 * 24 * 60 * 60 * 1000
    const startDate = new Date(Date.now() - lookbackMs).toISOString()
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
  // Calculate startDate based on timeframe so we get the ~200 most recent candles
  // (not the 200 oldest in a 60-day window — that caused stale_data for short timeframes)
  const tfMs = getTimeframeMs(timeframe)
  const lookbackMs = tfMs > 0 ? tfMs * 250 : 60 * 24 * 60 * 60 * 1000 // 250 candles or 60 days fallback
  const startDate = new Date(Date.now() - lookbackMs).toISOString()

  const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 500 }, { client: dbClient })
  if (candles.length < 50) return { signal: null, rejectionReason: `insufficient_candles:${candles.length}` }

  // Staleness check — reject if last candle is older than 3 candle periods
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
  const key = `${symbol}:${htf}:${currentTf}`
  if (htfBiasCache.has(key)) return htfBiasCache.get(key)!

  const bias = await computeHTFBias(symbol, htf, dbClient, currentTf)
  htfBiasCache.set(key, bias)
  return bias
}

async function computeHTFBias(symbol: string, htf: Timeframe, dbClient: SupabaseClient, currentTf?: Timeframe): Promise<'bull' | 'bear' | 'neutral'> {
  try {
    const endDate = new Date().toISOString()
    const tfMs = getTimeframeMs(htf)
    const lookbackMs = tfMs > 0 ? tfMs * 120 : 120 * 24 * 60 * 60 * 1000
    const startDate = new Date(Date.now() - lookbackMs).toISOString()
    const candles = await getCandles({ symbol, timeframe: htf, startDate, endDate, limit: 60 }, { client: dbClient })
    if (candles.length < 50) return 'neutral'

    const ema50 = calculateEMA(candles, 50)
    if (ema50.length === 0) return 'neutral'

    const lastClose = candles[candles.length - 1].close
    const lastEMA = ema50[ema50.length - 1].value
    const diff = (lastClose - lastEMA) / lastEMA

    // Threshold scaled by timeframe distance: scalping needs strong HTF trend to block
    const threshold = (currentTf === '1m' || currentTf === '5m' || currentTf === '15m')
      ? 0.02    // 2% — only strong 4h trends block scalping signals
      : currentTf === '1h'
      ? 0.01    // 1% — moderate filter for intraday
      : 0.005   // 0.5% — tight filter for swing (4h/1d)

    if (diff > threshold) return 'bull'
    if (diff < -threshold) return 'bear'
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
