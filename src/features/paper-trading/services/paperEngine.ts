'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getCandles } from '@/features/market-data/services/marketDataService'
import {
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
} from '@/features/indicators/services/indicatorEngine'
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
    const sl = Number(trade.stop_loss)
    const tp = Number(trade.take_profit)

    if (trade.type === 'buy') {
      if (currentPrice.price <= sl) {
        const closed = await closePaperTrade(trade.id, sl, 'stop_loss')
        await updateSessionStats(sessionId)
        return { action: 'close', trade: closed, reason: `Stop loss hit at ${sl}` }
      }
      if (currentPrice.price >= tp) {
        const closed = await closePaperTrade(trade.id, tp, 'take_profit')
        await updateSessionStats(sessionId)
        return { action: 'close', trade: closed, reason: `Take profit hit at ${tp}` }
      }
    } else {
      if (currentPrice.price >= sl) {
        const closed = await closePaperTrade(trade.id, sl, 'stop_loss')
        await updateSessionStats(sessionId)
        return { action: 'close', trade: closed, reason: `Stop loss hit at ${sl}` }
      }
      if (currentPrice.price <= tp) {
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

  const { signal, atr: currentATR } = signalResult

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

  const { data: newTrade, error: tradeErr } = await supabase
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
    })
    .select()
    .single()

  if (tradeErr) throw new Error(`Failed to open trade: ${tradeErr.message}`)
  return { action: signal, trade: newTrade as PaperTrade, reason: `${signalResult.reason} at ${currentPrice.price}` }
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

/**
 * Full signal check — matches turbo simulator exactly:
 * - 3 signal systems (EMA cross, BB mean-reversion, ADX trend)
 * - Regime filtering (skip choppy/volatile)
 * - Returns ATR for position sizing
 */
async function checkSignalFull(
  symbol: string,
  timeframe: Timeframe,
  params: StrategyParameters
): Promise<{ signal: 'buy' | 'sell'; atr: number; reason: string } | null> {
  const endDate = new Date().toISOString()
  const startDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()

  const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 200 })
  if (candles.length < 50) return null

  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const macd = calculateMACD(candles, params.macd_fast, params.macd_slow, params.macd_signal)
  const rsi = calculateRSI(candles, params.rsi_period)
  const bb = calculateBollingerBands(candles, params.bb_period, params.bb_std_dev)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)

  if (emaFast.length < 2 || emaSlow.length < 2 || macd.length < 1 || rsi.length < 1 || atr.length < 1) {
    return null
  }

  const ef = emaFast[emaFast.length - 1].value
  const es = emaSlow[emaSlow.length - 1].value
  const pef = emaFast[emaFast.length - 2].value
  const pes = emaSlow[emaSlow.length - 2].value
  const m = macd[macd.length - 1]
  const r = rsi[rsi.length - 1].value
  const currentATR = atr[atr.length - 1].value
  const currentADX = adx.length > 0 ? adx[adx.length - 1] : null
  const currentBB = bb.length > 0 ? bb[bb.length - 1] : null
  const price = candles[candles.length - 1].close

  // Regime filtering — skip choppy and volatile (same as turbo sim)
  const adxVal = currentADX?.adx ?? 0
  const isChoppy = adxVal < 20 && adxVal > 0
  const atrAvg = atr.length > 50
    ? atr.slice(-50).reduce((s, a) => s + a.value, 0) / 50
    : 0
  const isVolatile = atrAvg > 0 && currentATR > 2 * atrAvg

  if (isChoppy || isVolatile) return null

  // System 1: EMA crossover + confluence
  if (pef <= pes && ef > es) {
    let conf = 0
    if (m.histogram > 0) conf++
    if (r < params.rsi_overbought) conf++
    if (conf >= 1) return { signal: 'buy', atr: currentATR, reason: 'EMA cross up + confluence' }
  }
  if (pef >= pes && ef < es) {
    let conf = 0
    if (m.histogram < 0) conf++
    if (r > params.rsi_oversold) conf++
    if (conf >= 1) return { signal: 'sell', atr: currentATR, reason: 'EMA cross down + confluence' }
  }

  // System 2: BB mean-reversion + RSI extremes
  if (currentBB) {
    if (price <= currentBB.lower && r < params.rsi_oversold + 5) {
      return { signal: 'buy', atr: currentATR, reason: 'BB lower + RSI oversold' }
    }
    if (price >= currentBB.upper && r > params.rsi_overbought - 5) {
      return { signal: 'sell', atr: currentATR, reason: 'BB upper + RSI overbought' }
    }
  }

  // System 3: Strong trend continuation (ADX > 30)
  if (currentADX && currentADX.adx > 30) {
    if (currentADX.plusDI > currentADX.minusDI && r > 40 && r < 65 && ef > es) {
      return { signal: 'buy', atr: currentATR, reason: 'Strong uptrend (ADX>30)' }
    }
    if (currentADX.minusDI > currentADX.plusDI && r < 60 && r > 35 && ef < es) {
      return { signal: 'sell', atr: currentATR, reason: 'Strong downtrend (ADX>30)' }
    }
  }

  return null
}
