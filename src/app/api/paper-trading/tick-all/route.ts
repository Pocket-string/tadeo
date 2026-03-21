import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getCandles } from '@/features/market-data/services/marketDataService'
import { calculateATR } from '@/features/indicators/services/indicatorEngine'
import { getLivePrice } from '@/features/paper-trading/services/priceService'
import {
  precomputeIndicators,
  buildContext,
  generateComposite,
  LEGACY_SIGNAL_CONFIG,
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
    (serviceKeySuffix && providedToken === serviceKeySuffix)

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
 * Full signal check using the N-Signal registry.
 * Backward compatible: strategies without signal_systems use legacy 3-system config.
 * Includes regime filtering (skip choppy/volatile markets).
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

  // Pre-compute all indicators
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

  // Regime filtering — skip choppy and volatile markets
  const adxVal = ctx.adx?.adx ?? 0
  const isChoppy = adxVal < 20 && adxVal > 0
  const atrValues = Array.from(indicators.atrMap.values())
  const atrAvg = atrValues.length > 50
    ? atrValues.slice(-50).reduce((s, a) => s + a, 0) / 50
    : 0
  const isVolatile = atrAvg > 0 && ctx.atr > 2 * atrAvg

  if (isChoppy || isVolatile) return null

  // Use strategy's signal_systems config, or fall back to legacy 3-system
  const signalConfig: SignalSystemConfig[] = params.signal_systems ?? LEGACY_SIGNAL_CONFIG

  const composite = generateComposite(ctx, signalConfig)

  if (composite.direction === 'neutral') return null

  const signal: 'buy' | 'sell' = composite.direction === 'long' ? 'buy' : 'sell'
  const reason = composite.activeSystems.join(' + ')

  return { signal, atr: ctx.atr, reason }
}
