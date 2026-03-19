import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getCandles } from '@/features/market-data/services/marketDataService'
import {
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
} from '@/features/indicators/services/indicatorEngine'
import { getLivePrice } from '@/features/paper-trading/services/priceService'
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
  riskTier: string
  action: string
  reason: string
  price?: number
  pnl?: number
}

export async function POST(req: NextRequest) {
  // Auth: accept cron secret OR service role key suffix
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const serviceKeySuffix = process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(-10)

  const providedToken = authHeader?.replace('Bearer ', '')
  const isAuthorized =
    (cronSecret && providedToken === cronSecret) ||
    (serviceKeySuffix && providedToken === serviceKeySuffix) ||
    // Allow from same origin (localhost dev)
    req.headers.get('x-auto-tick') === 'true'

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

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
  const signalCache = new Map<string, { signal: 'buy' | 'sell'; atr: number; reason: string } | null>()

  for (const session of sessions) {
    const riskTier: RiskTier = (session.risk_tier as RiskTier) || 'moderate'
    try {
      const params = (session.strategies as { parameters: StrategyParameters }).parameters

      // Get price (cached per symbol)
      if (!priceCache.has(session.symbol)) {
        const priceData = await getLivePrice(session.symbol)
        priceCache.set(session.symbol, priceData.price)
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
        const currentATR = await getCachedATR(cacheKey, session.symbol, session.timeframe as Timeframe)
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
        signalCache.set(sigKey, await checkSignalFull(session.symbol, session.timeframe as Timeframe, params))
      }
      const signalResult = signalCache.get(sigKey)!

      if (!signalResult) {
        results.push({
          sessionId: session.id,
          symbol: session.symbol,
          riskTier,
          action: 'hold',
          reason: 'No signal',
          price,
        })
        continue
      }

      const { signal, atr: currentATR, reason: signalReason } = signalResult

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
          riskTier,
          action: 'hold',
          reason: 'Insufficient capital',
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

      await supabase
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
        })

      results.push({
        sessionId: session.id,
        symbol: session.symbol,
        riskTier,
        action: signal,
        reason: `[${riskTier}] ${signalReason} | SL:${stopLoss.toFixed(2)} TP:${takeProfit.toFixed(2)} Qty:${quantity.toFixed(4)}`,
        price,
      })
    } catch (err) {
      results.push({
        sessionId: session.id,
        symbol: session.symbol,
        riskTier,
        action: 'error',
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  return NextResponse.json({
    message: `Ticked ${sessions.length} sessions`,
    sessions: sessions.length,
    results,
    timestamp: new Date().toISOString(),
  })
}

async function updateSessionStats(
  supabase: ReturnType<typeof getServiceClient>,
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

// ATR cache to avoid redundant candle fetches
const atrCache = new Map<string, number | null>()

async function getCachedATR(key: string, symbol: string, timeframe: Timeframe): Promise<number | null> {
  if (atrCache.has(key)) return atrCache.get(key)!
  const val = await getCurrentATR(symbol, timeframe)
  atrCache.set(key, val)
  return val
}

/**
 * Get current ATR value for a symbol/timeframe.
 */
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
 * Full signal check — matches turbo simulator exactly:
 * - 3 signal systems (EMA cross, BB mean-reversion, ADX trend)
 * - Regime filtering (skip choppy/volatile)
 * - ATR-based position sizing
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

  // Calculate ALL indicators (same as turbo simulator)
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

  // Current values
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

  // Regime filtering — skip choppy and volatile markets (same as turbo sim)
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
