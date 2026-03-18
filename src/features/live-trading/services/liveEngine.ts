'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { createBinanceClient, createSimulatedClient } from './exchangeClient'
import { checkRisk, killSwitch } from './riskManager'
import { getCandles } from '@/features/market-data/services/marketDataService'
import { calculateEMA, calculateMACD, calculateRSI } from '@/features/indicators/services/indicatorEngine'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import type { LiveSession, LiveTrade, RiskConfig, ExchangeClient } from '../types'
import { DEFAULT_RISK_CONFIG } from '../types'

function getExchangeClient(): ExchangeClient {
  if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
    return createBinanceClient()
  }
  return createSimulatedClient()
}

/**
 * Start a live trading session.
 * HUMAN GATE: Only humans can start live sessions.
 */
export async function startLiveSession(input: {
  strategyId: string
  symbol: string
  timeframe: string
  initialCapital: number
  riskConfig?: Partial<RiskConfig>
}): Promise<LiveSession> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Check no active session for this strategy+symbol
  const { data: existing } = await supabase
    .from('live_sessions')
    .select('id')
    .eq('strategy_id', input.strategyId)
    .eq('symbol', input.symbol)
    .in('status', ['active', 'paused'])
    .maybeSingle()

  if (existing) throw new Error('Ya existe una sesión activa/pausada para esta estrategia+símbolo')

  const { data, error } = await supabase
    .from('live_sessions')
    .insert({
      user_id: user.id,
      strategy_id: input.strategyId,
      symbol: input.symbol,
      timeframe: input.timeframe,
      initial_capital: input.initialCapital,
      current_capital: input.initialCapital,
    })
    .select()
    .single()

  if (error) throw new Error(`Error al iniciar sesión: ${error.message}`)
  return data as LiveSession
}

/**
 * Stop a live session gracefully.
 * Closes all open positions via exchange then marks session as stopped.
 */
export async function stopLiveSession(sessionId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const exchange = getExchangeClient()

  // Close open trades
  const { data: openTrades } = await supabase
    .from('live_trades')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'open')

  if (openTrades && openTrades.length > 0) {
    for (const trade of openTrades as LiveTrade[]) {
      try {
        const closeSide = trade.type === 'buy' ? 'SELL' : 'BUY'
        const order = await exchange.placeOrder({
          symbol: trade.symbol,
          side: closeSide as 'BUY' | 'SELL',
          type: 'MARKET',
          quantity: Number(trade.quantity),
        })

        const exitPrice = order.filledPrice ?? (await exchange.getPrice(trade.symbol))
        const pnl = trade.type === 'buy'
          ? (exitPrice - Number(trade.entry_price)) * Number(trade.quantity)
          : (Number(trade.entry_price) - exitPrice) * Number(trade.quantity)

        await supabase
          .from('live_trades')
          .update({
            status: 'closed',
            exit_price: exitPrice,
            exit_time: new Date().toISOString(),
            exit_reason: 'session_stopped',
            pnl,
            pnl_pct: pnl / (Number(trade.entry_price) * Number(trade.quantity)),
            exchange_order_id: order.orderId,
          })
          .eq('id', trade.id)
      } catch (err) {
        // Force close in DB even if exchange fails
        await supabase
          .from('live_trades')
          .update({
            status: 'closed',
            exit_time: new Date().toISOString(),
            exit_reason: `session_stopped (exchange error: ${err instanceof Error ? err.message : 'unknown'})`,
          })
          .eq('id', trade.id)
      }
    }
  }

  await supabase
    .from('live_sessions')
    .update({ status: 'stopped', stopped_at: new Date().toISOString() })
    .eq('id', sessionId)
    .eq('user_id', user.id)

  await updateLiveSessionStats(sessionId)
}

/**
 * Execute a tick: check signals, validate risk, execute orders.
 * FLOW: Signal → Risk Check → Exchange Order → DB Record
 */
export async function tickLiveSession(sessionId: string): Promise<{
  action: 'buy' | 'sell' | 'close' | 'hold' | 'blocked'
  trade?: LiveTrade
  reason: string
  riskCheck?: { allowed: boolean; reason: string; riskLevel: string }
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const exchange = getExchangeClient()

  // Get session with strategy params
  const { data: session, error: sessErr } = await supabase
    .from('live_sessions')
    .select('*, strategies(parameters)')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .single()

  if (sessErr || !session) throw new Error('Sesión no encontrada')
  if (session.status !== 'active') return { action: 'hold', reason: 'Sesión no activa' }

  const params = (session.strategies as { parameters: StrategyParameters }).parameters
  const currentPrice = await exchange.getPrice(session.symbol)

  // Check open trades for SL/TP
  const { data: openTrades } = await supabase
    .from('live_trades')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'open')

  if (openTrades && openTrades.length > 0) {
    const trade = openTrades[0] as LiveTrade
    const sl = Number(trade.stop_loss)
    const tp = Number(trade.take_profit)

    const shouldClose = trade.type === 'buy'
      ? (currentPrice <= sl ? 'stop_loss' : currentPrice >= tp ? 'take_profit' : null)
      : (currentPrice >= sl ? 'stop_loss' : currentPrice <= tp ? 'take_profit' : null)

    if (shouldClose) {
      const closeSide = trade.type === 'buy' ? 'SELL' : 'BUY'
      try {
        const order = await exchange.placeOrder({
          symbol: trade.symbol,
          side: closeSide as 'BUY' | 'SELL',
          type: 'MARKET',
          quantity: Number(trade.quantity),
        })

        const exitPrice = order.filledPrice ?? currentPrice
        const pnl = trade.type === 'buy'
          ? (exitPrice - Number(trade.entry_price)) * Number(trade.quantity)
          : (Number(trade.entry_price) - exitPrice) * Number(trade.quantity)

        await supabase
          .from('live_trades')
          .update({
            status: 'closed',
            exit_price: exitPrice,
            exit_time: new Date().toISOString(),
            exit_reason: shouldClose,
            pnl,
            pnl_pct: pnl / (Number(trade.entry_price) * Number(trade.quantity)),
            exchange_order_id: order.orderId,
          })
          .eq('id', trade.id)

        await updateLiveSessionStats(sessionId)

        // Check if kill switch needed after loss
        if (pnl < 0) {
          const riskCheck = await checkRisk(session as LiveSession, { type: 'buy', quantity: 0, price: currentPrice })
          if (riskCheck.riskLevel === 'critical') {
            await killSwitch(sessionId, 'Drawdown total excede límite')
            return { action: 'close', reason: `KILL SWITCH activado: ${riskCheck.reason}` }
          }
        }

        const closed = { ...trade, exit_price: exitPrice, pnl, status: 'closed' as const } as LiveTrade
        return { action: 'close', trade: closed, reason: `${shouldClose} @ ${exitPrice}` }
      } catch (err) {
        return { action: 'hold', reason: `Error cerrando posición: ${err instanceof Error ? err.message : 'unknown'}` }
      }
    }

    return { action: 'hold', reason: `Posición abierta: ${trade.type} @ ${trade.entry_price}` }
  }

  // No open position — check for signal
  const signal = await checkSignal(session.symbol, session.timeframe as Timeframe, params)
  if (!signal) return { action: 'hold', reason: 'Sin señal detectada' }

  // Calculate position size with risk management
  const stopLossPrice = signal === 'buy'
    ? currentPrice * (1 - params.stop_loss_pct)
    : currentPrice * (1 + params.stop_loss_pct)

  const quantity = calculatePositionSize(
    Number(session.current_capital),
    currentPrice,
    stopLossPrice,
    DEFAULT_RISK_CONFIG.maxPositionSizePct
  )

  if (quantity <= 0) return { action: 'hold', reason: 'Capital insuficiente para tamaño de posición mínimo' }

  // RISK CHECK before executing
  const riskCheck = await checkRisk(
    session as LiveSession,
    { type: signal, quantity, price: currentPrice }
  )

  if (!riskCheck.allowed) {
    // Auto-pause if critical
    if (riskCheck.riskLevel === 'critical') {
      await killSwitch(sessionId, riskCheck.reason)
    }
    return {
      action: 'blocked',
      reason: `Bloqueado por Risk Manager: ${riskCheck.reason}`,
      riskCheck: { allowed: false, reason: riskCheck.reason, riskLevel: riskCheck.riskLevel },
    }
  }

  // Execute on exchange
  try {
    const order = await exchange.placeOrder({
      symbol: session.symbol,
      side: signal === 'buy' ? 'BUY' : 'SELL',
      type: 'MARKET',
      quantity,
    })

    const entryPrice = order.filledPrice ?? currentPrice
    const takeProfitPrice = signal === 'buy'
      ? entryPrice * (1 + params.take_profit_pct)
      : entryPrice * (1 - params.take_profit_pct)
    const stopLoss = signal === 'buy'
      ? entryPrice * (1 - params.stop_loss_pct)
      : entryPrice * (1 + params.stop_loss_pct)

    const { data: newTrade, error: tradeErr } = await supabase
      .from('live_trades')
      .insert({
        user_id: user.id,
        session_id: sessionId,
        strategy_id: session.strategy_id,
        symbol: session.symbol,
        type: signal,
        entry_price: entryPrice,
        quantity: order.filledQty || quantity,
        stop_loss: stopLoss,
        take_profit: takeProfitPrice,
        exchange_order_id: order.orderId,
      })
      .select()
      .single()

    if (tradeErr) throw new Error(`Error guardando trade: ${tradeErr.message}`)

    return {
      action: signal,
      trade: newTrade as LiveTrade,
      reason: `Señal ${signal} @ ${entryPrice} (Order: ${order.orderId})`,
      riskCheck: { allowed: true, reason: riskCheck.reason, riskLevel: riskCheck.riskLevel },
    }
  } catch (err) {
    return { action: 'hold', reason: `Error ejecutando orden: ${err instanceof Error ? err.message : 'unknown'}` }
  }
}

/**
 * Pause a live session (human decision or risk manager auto-pause).
 * REACTIVATION always requires human approval.
 */
export async function pauseLiveSession(sessionId: string, reason: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  await supabase
    .from('live_sessions')
    .update({
      status: 'paused',
      paused_at: new Date().toISOString(),
      pause_reason: reason,
    })
    .eq('id', sessionId)
    .eq('user_id', user.id)
}

/**
 * Resume a paused session.
 * HUMAN GATE: Only humans can reactivate.
 */
export async function resumeLiveSession(sessionId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  await supabase
    .from('live_sessions')
    .update({
      status: 'active',
      paused_at: null,
      pause_reason: null,
    })
    .eq('id', sessionId)
    .eq('user_id', user.id)
}

async function updateLiveSessionStats(sessionId: string): Promise<void> {
  const supabase = await createClient()

  const { data: session } = await supabase
    .from('live_sessions')
    .select('initial_capital')
    .eq('id', sessionId)
    .single()

  if (!session) return

  const { data: trades } = await supabase
    .from('live_trades')
    .select('pnl')
    .eq('session_id', sessionId)
    .eq('status', 'closed')

  if (!trades) return

  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl), 0)
  const winning = trades.filter(t => Number(t.pnl) > 0).length

  // Calculate max drawdown
  let peak = Number(session.initial_capital)
  let maxDD = 0
  let equity = peak
  for (const t of trades) {
    equity += Number(t.pnl)
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDD) maxDD = dd
  }

  await supabase
    .from('live_sessions')
    .update({
      total_trades: trades.length,
      winning_trades: winning,
      net_pnl: totalPnl,
      current_capital: Number(session.initial_capital) + totalPnl,
      max_drawdown_pct: maxDD,
    })
    .eq('id', sessionId)
}

function calculatePositionSize(
  capital: number,
  price: number,
  stopLossPrice: number,
  maxRiskPct: number = 0.02
): number {
  const riskAmount = capital * maxRiskPct
  const riskPerUnit = Math.abs(price - stopLossPrice)
  if (riskPerUnit <= 0) return 0
  const quantity = riskAmount / riskPerUnit
  return Math.floor(quantity * 100000) / 100000
}

async function checkSignal(
  symbol: string,
  timeframe: Timeframe,
  params: StrategyParameters
): Promise<'buy' | 'sell' | null> {
  const endDate = new Date().toISOString()
  const startDate = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()

  const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 100 })
  if (candles.length < 30) return null

  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const macd = calculateMACD(candles, params.macd_fast, params.macd_slow, params.macd_signal)
  const rsi = calculateRSI(candles, params.rsi_period)

  if (emaFast.length < 2 || emaSlow.length < 2 || macd.length < 1 || rsi.length < 1) return null

  const ef = emaFast[emaFast.length - 1].value
  const es = emaSlow[emaSlow.length - 1].value
  const pef = emaFast[emaFast.length - 2].value
  const pes = emaSlow[emaSlow.length - 2].value
  const m = macd[macd.length - 1]
  const r = rsi[rsi.length - 1].value

  if (pef <= pes && ef > es && m.histogram > 0 && r < 50 && r > params.rsi_oversold) {
    return 'buy'
  }
  if (pef >= pes && ef < es && m.histogram < 0 && r > 50 && r < params.rsi_overbought) {
    return 'sell'
  }

  return null
}
