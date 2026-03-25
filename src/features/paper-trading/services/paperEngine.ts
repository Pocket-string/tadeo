'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getCandles } from '@/features/market-data/services/marketDataService'
import { calculateATR, calculateEMA } from '@/features/indicators/services/indicatorEngine'
import {
  precomputeIndicators,
  buildContext,
  generateComposite,
  generateAdaptiveComposite,
  LEGACY_SIGNAL_CONFIG,
  type SignalSystemConfig,
} from '@/features/paper-trading/services/signalRegistry'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import type { PaperSession, PaperTrade, RiskTier } from '../types'
import { RISK_TIERS } from '../types'
import { getLivePrice } from './priceService'

/**
 * Start a paper trading session for a strategy.
 */
export async function startPaperSession(input: {
  strategyId: string
  symbol: string
  timeframe: string
  initialCapital?: number
}): Promise<PaperSession> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Check no active session for this strategy+symbol
  const { data: existing } = await supabase
    .from('paper_sessions')
    .select('id')
    .eq('strategy_id', input.strategyId)
    .eq('symbol', input.symbol)
    .eq('status', 'active')
    .maybeSingle()

  if (existing) throw new Error('Active session already exists for this strategy+symbol')

  const { data, error } = await supabase
    .from('paper_sessions')
    .insert({
      user_id: user.id,
      strategy_id: input.strategyId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      initial_capital: input.initialCapital ?? 10000,
      current_capital: input.initialCapital ?? 10000,
    })
    .select()
    .single()

  if (error) throw new Error(`Failed to start session: ${error.message}`)
  return data as PaperSession
}

/**
 * Stop a paper trading session.
 */
export async function stopPaperSession(sessionId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Close all open trades for this session
  const { data: openTrades } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'open')

  if (openTrades && openTrades.length > 0) {
    for (const trade of openTrades) {
      try {
        const price = await getLivePrice(trade.symbol)
        await closePaperTrade(trade.id, price.price, 'session_stopped')
      } catch {
        // Force close at entry price if can't get live price
        await closePaperTrade(trade.id, Number(trade.entry_price), 'session_stopped')
      }
    }
  }

  await supabase
    .from('paper_sessions')
    .update({ status: 'stopped', stopped_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', user.id)
}

/**
 * Check signals and execute paper trades for active sessions.
 * Called periodically (e.g., every candle close).
 */
export async function tickPaperSession(sessionId: string): Promise<{
  action: 'buy' | 'sell' | 'close' | 'hold'
  trade?: PaperTrade
  reason: string
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Get session
  const { data: session, error: sessErr } = await supabase
    .from('paper_sessions')
    .select('*, strategies(parameters)')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .single()

  if (sessErr || !session) throw new Error('Session not found')
  if (session.status !== 'active') return { action: 'hold', reason: 'Session not active' }

  const params = (session.strategies as { parameters: StrategyParameters }).parameters
  const currentPrice = await getLivePrice(session.symbol)

  // Check open trades for this session specifically
  const { data: openTrades } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'open')

  if (openTrades && openTrades.length > 0) {
    const trade = openTrades[0] as PaperTrade
    let sl = Number(trade.stop_loss)
    const tp = Number(trade.take_profit)
    const price = currentPrice.price

    // Time-based exit: close stale positions (estimate candle count from entry time)
    const timeframeMs = getTimeframeMs(session.timeframe)
    const entryTime = new Date(trade.entry_time || trade.created_at).getTime()
    const candlesSinceEntry = Math.floor((Date.now() - entryTime) / timeframeMs)
    if (candlesSinceEntry >= 50) {
      const closed = await closePaperTrade(trade.id, price, 'time_exit')
      await updateSessionStats(sessionId)
      return { action: 'close', trade: closed, reason: `Time exit after ${candlesSinceEntry} candles` }
    }

    // Breakeven: move SL to entry once price advances 0.5x ATR
    const currentATR = await getCurrentATR(session.symbol, session.timeframe as Timeframe)
    // Use entry_atr for activation thresholds — avoids mismatch when ATR changes between ticks
    const entryATR = Number(trade.metadata?.entry_atr) || currentATR
    if (currentATR && !trade.metadata?.breakeven_hit) {
      const entryPrice = Number(trade.entry_price)
      const effectiveATR = entryATR ?? currentATR
      const beActivation = trade.type === 'buy'
        ? entryPrice + effectiveATR * 0.5
        : entryPrice - effectiveATR * 0.5
      const shouldActivateBE = trade.type === 'buy'
        ? price >= beActivation
        : price <= beActivation
      if (shouldActivateBE) {
        const newSL = trade.type === 'buy'
          ? Math.max(sl, entryPrice)
          : Math.min(sl, entryPrice)
        await supabase.from('paper_trades').update({
          stop_loss: newSL,
          metadata: { ...trade.metadata, breakeven_hit: true },
        }).eq('id', trade.id)
        sl = newSL
      }
    }

    // Trailing stop: update SL if price moved favorably
    if (currentATR) {
      if (params.trailing_stop_mode === 'ema') {
        // EMA-based adaptive trailing: SL follows EMA ± 0.5*ATR buffer
        const emaPeriod = params.trailing_ema_period ?? 20
        const emaVal = await getCurrentEMATrail(session.symbol, session.timeframe as Timeframe, emaPeriod)
        if (emaVal !== null) {
          const newSL = trade.type === 'buy'
            ? emaVal - currentATR * 0.5
            : emaVal + currentATR * 0.5
          const isBetter = trade.type === 'buy' ? newSL > sl : newSL < sl
          if (isBetter) {
            await supabase.from('paper_trades').update({ stop_loss: newSL }).eq('id', trade.id)
            sl = newSL
          }
        }
      } else {
        // Default ATR-based trailing — use entryATR for activation, currentATR for distance
        const entryPrice = Number(trade.entry_price)
        const activationATR = entryATR ?? currentATR ?? 0
        const trailActivation = trade.type === 'buy'
          ? entryPrice + activationATR
          : entryPrice - activationATR

        if (trade.type === 'buy' && price > trailActivation) {
          const newTrailSL = price - currentATR
          if (newTrailSL > sl) {
            await supabase.from('paper_trades').update({ stop_loss: newTrailSL }).eq('id', trade.id)
            sl = newTrailSL
          }
        } else if (trade.type === 'sell' && price < trailActivation) {
          const newTrailSL = price + currentATR
          if (newTrailSL < sl) {
            await supabase.from('paper_trades').update({ stop_loss: newTrailSL }).eq('id', trade.id)
            sl = newTrailSL
          }
        }
      }
    }

    // Check SL/TP
    if (trade.type === 'buy') {
      if (price <= sl) {
        const closed = await closePaperTrade(trade.id, sl, 'stop_loss')
        await updateSessionStats(sessionId)
        return { action: 'close', trade: closed, reason: `Stop loss hit at ${sl}` }
      }
      if (price >= tp) {
        const closed = await closePaperTrade(trade.id, tp, 'take_profit')
        await updateSessionStats(sessionId)
        return { action: 'close', trade: closed, reason: `Take profit hit at ${tp}` }
      }
    } else {
      if (price >= sl) {
        const closed = await closePaperTrade(trade.id, sl, 'stop_loss')
        await updateSessionStats(sessionId)
        return { action: 'close', trade: closed, reason: `Stop loss hit at ${sl}` }
      }
      if (price <= tp) {
        const closed = await closePaperTrade(trade.id, tp, 'take_profit')
        await updateSessionStats(sessionId)
        return { action: 'close', trade: closed, reason: `Take profit hit at ${tp}` }
      }
    }
    return { action: 'hold', reason: `Position open: ${trade.type} @ ${trade.entry_price}` }
  }

  // No open position — check for new signal using full 3-system engine
  const signalResult = await checkSignalFull(session.symbol, session.timeframe as Timeframe, params)
  if (!signalResult) return { action: 'hold', reason: 'No signal detected' }

  const { signal, atr: currentATR, activeSystems: signalSystems } = signalResult

  // ATR-based SL/TP (matches turbo simulator exactly)
  const slMult = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
  const tpMult = params.take_profit_pct > 1 ? params.take_profit_pct : 2.5
  const stopDist = currentATR * slMult
  const riskTier = (session as PaperSession).risk_tier || 'moderate'
  const riskPct = RISK_TIERS[riskTier as RiskTier]?.riskPerTrade ?? 0.03
  const riskAmount = Number(session.current_capital) * riskPct
  const quantity = riskAmount / stopDist
  if (riskAmount < 0.5 || quantity <= 0) return { action: 'hold', reason: 'Insufficient capital' }

  const stopLoss = signal === 'buy'
    ? currentPrice.price - stopDist
    : currentPrice.price + stopDist
  const takeProfit = signal === 'buy'
    ? currentPrice.price + currentATR * tpMult
    : currentPrice.price - currentATR * tpMult

  // INSERT with conflict guard — unique index prevents duplicate open trades per session
  const { data: newTrades } = await supabase
    .from('paper_trades')
    .insert({
      user_id: user.id,
      strategy_id: session.strategy_id,
      session_id: sessionId,
      symbol: session.symbol,
      timeframe: session.timeframe,
      type: signal,
      entry_price: currentPrice.price,
      quantity,
      stop_loss: stopLoss,
      take_profit: takeProfit,
      metadata: { active_systems: signalSystems ?? [], entry_atr: currentATR },
    })
    .select()

  if (!newTrades || newTrades.length === 0) {
    return { action: 'hold', reason: 'Duplicate trade blocked by index' }
  }
  return { action: signal, trade: newTrades[0] as PaperTrade, reason: `${signalResult.reason} at ${currentPrice.price}` }
}

async function closePaperTrade(tradeId: string, exitPrice: number, reason: string): Promise<PaperTrade> {
  const supabase = await createClient()

  const { data: trade } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('id', tradeId)
    .single()

  if (!trade) throw new Error('Trade not found')

  const entryPrice = Number(trade.entry_price)
  const qty = Number(trade.quantity)
  const pnl = trade.type === 'buy'
    ? (exitPrice - entryPrice) * qty
    : (entryPrice - exitPrice) * qty
  const pnlPct = pnl / (entryPrice * qty)

  const { data: updated, error } = await supabase
    .from('paper_trades')
    .update({
      status: 'closed',
      exit_price: exitPrice,
      exit_time: new Date().toISOString(),
      exit_reason: reason,
      pnl,
      pnl_pct: pnlPct,
    })
    .eq('id', tradeId)
    .select()
    .single()

  if (error) throw new Error(`Failed to close trade: ${error.message}`)
  return updated as PaperTrade
}

async function updateSessionStats(sessionId: string): Promise<void> {
  const supabase = await createClient()

  const { data: session } = await supabase
    .from('paper_sessions')
    .select('initial_capital')
    .eq('id', sessionId)
    .single()

  if (!session) return

  // Count only trades belonging to THIS session
  const { data: trades } = await supabase
    .from('paper_trades')
    .select('pnl, status')
    .eq('session_id', sessionId)
    .eq('status', 'closed')

  if (!trades) return

  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl), 0)
  const winning = trades.filter((t) => Number(t.pnl) > 0).length

  await supabase
    .from('paper_sessions')
    .update({
      total_trades: trades.length,
      winning_trades: winning,
      net_pnl: totalPnl,
      current_capital: Number(session.initial_capital) + totalPnl,
    })
    .eq('id', sessionId)
}

/** Convert timeframe string to milliseconds */
function getTimeframeMs(tf: string): number {
  const map: Record<string, number> = {
    '1m': 60_000, '5m': 300_000, '15m': 900_000, '30m': 1_800_000,
    '1h': 3_600_000, '4h': 14_400_000, '1d': 86_400_000, '1w': 604_800_000,
  }
  return map[tf] ?? 3_600_000
}

/** Get current EMA value for trailing stop */
async function getCurrentEMATrail(symbol: string, timeframe: Timeframe, period: number): Promise<number | null> {
  try {
    const endDate = new Date().toISOString()
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 100 })
    if (candles.length < period + 5) return null
    const ema = calculateEMA(candles, period)
    return ema.length > 0 ? ema[ema.length - 1].value : null
  } catch {
    return null
  }
}

/** Get current ATR value for a symbol/timeframe */
async function getCurrentATR(symbol: string, timeframe: Timeframe): Promise<number | null> {
  try {
    const endDate = new Date().toISOString()
    const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 100 })
    if (candles.length < 20) return null
    const atr = calculateATR(candles, 14)
    return atr.length > 0 ? atr[atr.length - 1].value : null
  } catch {
    return null
  }
}

/**
 * Full signal check using the unified N-Signal registry.
 * Backward compatible: strategies without signal_systems use legacy 3-system config.
 * Includes regime filtering (skip choppy/volatile markets).
 */
async function checkSignalFull(
  symbol: string,
  timeframe: Timeframe,
  params: StrategyParameters
): Promise<{ signal: 'buy' | 'sell'; atr: number; reason: string; activeSystems: string[] } | null> {
  const endDate = new Date().toISOString()
  const startDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 200 })
  if (candles.length < 50) return null

  // Pre-compute all indicators via the unified registry
  const indicators = precomputeIndicators(candles, params)
  const lastIndex = candles.length - 1
  const prevIndex = candles.length - 2

  // Need previous EMA values for crossover detection
  const prevTs = candles[prevIndex].timestamp
  const prevEF = indicators.emaFastMap.get(prevTs)
  const prevES = indicators.emaSlowMap.get(prevTs)
  if (prevEF === undefined || prevES === undefined) return null

  // Build signal context for the latest candle
  const ctx = buildContext(candles, lastIndex, params, indicators, prevEF, prevES)
  if (!ctx) return null
  ctx.timeframe = timeframe

  // Regime filtering — skip choppy and volatile markets
  // ADX threshold is timeframe-aware: 4h/1d markets trend slowly so a lower bar applies
  const adxVal = ctx.adx?.adx ?? 0
  const adxChoppyThreshold = (timeframe === '4h' || timeframe === '1d') ? 15
    : (timeframe === '1m' || timeframe === '5m' || timeframe === '15m') ? 18
    : 20
  const isChoppy = adxVal < adxChoppyThreshold && adxVal > 0
  const atrValues = Array.from(indicators.atrMap.values())
  const atrAvg = atrValues.length > 50
    ? atrValues.slice(-50).reduce((s, a) => s + a, 0) / 50
    : 0
  const isVolatile = atrAvg > 0 && ctx.atr > 2 * atrAvg

  if (isChoppy || isVolatile) return null

  // Use strategy's signal_systems config if set; otherwise use adaptive composite
  const composite = params.signal_systems
    ? generateComposite(ctx, params.signal_systems as SignalSystemConfig[])
    : generateAdaptiveComposite(ctx)

  if (composite.direction === 'neutral') return null

  const signal: 'buy' | 'sell' = composite.direction === 'long' ? 'buy' : 'sell'

  // Higher-timeframe trend filter — block signals against 4h/1d trend
  const htfBias = await computeHTFBias(symbol, (timeframe === '4h' || timeframe === '1d') ? '1d' : '4h')
  if (htfBias === 'bull' && signal === 'sell') return null
  if (htfBias === 'bear' && signal === 'buy') return null

  const reason = composite.activeSystems.join(' + ')

  return { signal, atr: ctx.atr, reason, activeSystems: composite.activeSystems }
}

async function computeHTFBias(symbol: string, htf: Timeframe): Promise<'bull' | 'bear' | 'neutral'> {
  try {
    const endDate = new Date().toISOString()
    const startDate = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000).toISOString()
    const candles = await getCandles({ symbol, timeframe: htf, startDate, endDate, limit: 60 })
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
