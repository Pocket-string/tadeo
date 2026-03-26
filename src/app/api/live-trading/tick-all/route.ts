import { NextRequest, NextResponse } from 'next/server'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getCandles } from '@/features/market-data/services/marketDataService'
import { calculateATR, calculateEMA } from '@/features/indicators/services/indicatorEngine'
import {
  precomputeIndicators,
  buildContext,
  generateComposite,
  generateAdaptiveComposite,
  type SignalSystemConfig,
} from '@/features/paper-trading/services/signalRegistry'
import { createBinanceClient, createSimulatedClient } from '@/features/live-trading/services/exchangeClient'
import type { ExchangeClient } from '@/features/live-trading/types'
import { DEFAULT_RISK_CONFIG } from '@/features/live-trading/types'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import { RISK_TIERS, type RiskTier } from '@/features/paper-trading/types'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// ── Circuit Breaker thresholds (from DEFAULT_RISK_CONFIG) ───────────────────
const MAX_DRAWDOWN_PCT = DEFAULT_RISK_CONFIG.maxTotalDrawdownPct   // 15%
const MAX_DAILY_DRAWDOWN_PCT = DEFAULT_RISK_CONFIG.maxDailyDrawdownPct // 5%
const MAX_CONSECUTIVE_LOSSES = DEFAULT_RISK_CONFIG.cooldownAfterLossStreak // 3
const COOLDOWN_MS = 60 * 60 * 1000 // 1 hour

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

function getExchangeClient(): ExchangeClient {
  if (process.env.BINANCE_API_KEY && process.env.BINANCE_API_SECRET) {
    return createBinanceClient()
  }
  return createSimulatedClient()
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
  exchangeOrderId?: string
}

type SignalCheckResult =
  | { signal: 'buy' | 'sell'; atr: number; reason: string; activeSystems: string[] }
  | { signal: null; rejectionReason: string }

export async function POST(req: NextRequest) {
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

  htfBiasCache = new Map()
  atrCache.clear()
  emaTrailCache.clear()

  const supabase = getServiceClient()
  const exchange = getExchangeClient()
  const results: TickResult[] = []

  const { data: sessions, error: sessErr } = await supabase
    .from('live_sessions')
    .select('*, strategies(parameters)')
    .eq('status', 'active')

  if (sessErr || !sessions || sessions.length === 0) {
    return NextResponse.json({ message: 'No active live sessions', sessions: 0, results: [] })
  }

  // Cache prices and signals per symbol+timeframe
  const priceCache = new Map<string, number>()
  const signalCache = new Map<string, SignalCheckResult>()

  // Pre-fetch consecutive losses
  const consecutiveLossCache = new Map<string, { count: number; lastLossAt: string | null }>()
  {
    const { data: recentTrades } = await supabase
      .from('live_trades')
      .select('session_id, pnl, exit_time')
      .in('session_id', sessions.map(s => s.id))
      .eq('status', 'closed')
      .order('exit_time', { ascending: false })
      .limit(500)

    if (recentTrades) {
      const bySession = new Map<string, { pnl: number; exit_time: string }[]>()
      for (const t of recentTrades) {
        const list = bySession.get(t.session_id) || []
        list.push({ pnl: Number(t.pnl), exit_time: t.exit_time })
        bySession.set(t.session_id, list)
      }
      for (const [sid, trades] of bySession) {
        let count = 0
        for (const t of trades) {
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

  // Pre-fetch today's PnL for daily drawdown check
  const today = new Date().toISOString().split('T')[0]
  const dailyPnlCache = new Map<string, number>()
  {
    const { data: todayTrades } = await supabase
      .from('live_trades')
      .select('session_id, pnl')
      .in('session_id', sessions.map(s => s.id))
      .eq('status', 'closed')
      .gte('exit_time', `${today}T00:00:00Z`)

    if (todayTrades) {
      for (const t of todayTrades) {
        dailyPnlCache.set(t.session_id, (dailyPnlCache.get(t.session_id) || 0) + Number(t.pnl))
      }
    }
  }

  for (const session of sessions) {
    const riskTier: RiskTier = (session.risk_tier as RiskTier) || 'moderate'
    try {
      const params = (session.strategies as { parameters: StrategyParameters }).parameters

      // ── Circuit Breaker 1: Max Total Drawdown → emergency pause ────────
      const drawdownPct = Number(session.net_pnl) / Number(session.initial_capital)
      if (drawdownPct <= -MAX_DRAWDOWN_PCT) {
        await supabase
          .from('live_sessions')
          .update({
            status: 'emergency',
            paused_at: new Date().toISOString(),
            pause_reason: `CIRCUIT BREAKER: drawdown ${(drawdownPct * 100).toFixed(1)}% exceeded -${MAX_DRAWDOWN_PCT * 100}% limit`,
          })
          .eq('id', session.id)

        results.push({
          sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
          action: 'circuit_breaker',
          reason: `EMERGENCY: drawdown ${(drawdownPct * 100).toFixed(1)}% exceeded -${MAX_DRAWDOWN_PCT * 100}% limit`,
        })
        continue
      }

      // ── Circuit Breaker 2: Daily Drawdown → pause ─────────────────────
      const dailyPnl = dailyPnlCache.get(session.id) || 0
      const dailyDrawdown = dailyPnl < 0 ? Math.abs(dailyPnl) / Number(session.current_capital) : 0
      if (dailyDrawdown >= MAX_DAILY_DRAWDOWN_PCT) {
        await supabase
          .from('live_sessions')
          .update({
            status: 'paused',
            paused_at: new Date().toISOString(),
            pause_reason: `Daily drawdown ${(dailyDrawdown * 100).toFixed(1)}% exceeded ${MAX_DAILY_DRAWDOWN_PCT * 100}% limit`,
          })
          .eq('id', session.id)

        results.push({
          sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
          action: 'circuit_breaker',
          reason: `PAUSED: daily drawdown ${(dailyDrawdown * 100).toFixed(1)}% exceeded ${MAX_DAILY_DRAWDOWN_PCT * 100}% limit`,
        })
        continue
      }

      // ── Circuit Breaker 3: Consecutive Losses → cooldown ──────────────
      const lossInfo = consecutiveLossCache.get(session.id)
      if (lossInfo && lossInfo.count >= MAX_CONSECUTIVE_LOSSES && lossInfo.lastLossAt) {
        const lastLossTime = new Date(lossInfo.lastLossAt).getTime()
        const elapsed = Date.now() - lastLossTime
        if (elapsed < COOLDOWN_MS) {
          const remainMin = Math.ceil((COOLDOWN_MS - elapsed) / 60000)
          results.push({
            sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
            action: 'cooldown',
            reason: `${lossInfo.count} consecutive losses — cooldown ${remainMin}min remaining`,
          })
          continue
        }
      }

      // Get price (cached per symbol)
      if (!priceCache.has(session.symbol)) {
        try {
          const p = await exchange.getPrice(session.symbol)
          priceCache.set(session.symbol, p)
        } catch (priceErr) {
          results.push({
            sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
            action: 'error',
            reason: `Price fetch failed: ${priceErr instanceof Error ? priceErr.message : 'Unknown'}`,
          })
          continue
        }
      }
      const price = priceCache.get(session.symbol)!

      // Check open trades
      const { data: openTrades } = await supabase
        .from('live_trades')
        .select('*')
        .eq('session_id', session.id)
        .eq('status', 'open')

      if (openTrades && openTrades.length > 0) {
        const trade = openTrades[0]
        let sl = Number(trade.stop_loss)
        const tp = Number(trade.take_profit)
        let shouldClose = false
        let exitReason = ''

        if (trade.type === 'buy') {
          if (price <= sl) { exitReason = 'stop_loss'; shouldClose = true }
          else if (price >= tp) { exitReason = 'take_profit'; shouldClose = true }
        } else {
          if (price >= sl) { exitReason = 'stop_loss'; shouldClose = true }
          else if (price <= tp) { exitReason = 'take_profit'; shouldClose = true }
        }

        if (shouldClose) {
          // Execute REAL close order on Binance
          const closeSide = trade.type === 'buy' ? 'SELL' : 'BUY'
          let qty = Number(trade.quantity)

          // For SELL orders, query actual asset balance to avoid "insufficient balance"
          // (Binance fees reduce the received quantity on BUY)
          if (closeSide === 'SELL') {
            try {
              const balances = await exchange.getBalance()
              const asset = session.symbol.replace('USDT', '').replace('USDC', '')
              const assetBalance = balances.find(b => b.asset === asset)
              if (assetBalance && assetBalance.free < qty) {
                qty = assetBalance.free
              }
            } catch {
              // If balance check fails, reduce qty by 0.2% to account for fees
              qty = qty * 0.998
            }
          }

          try {
            const order = await exchange.placeOrder({
              symbol: session.symbol,
              side: closeSide as 'BUY' | 'SELL',
              type: 'MARKET',
              quantity: qty,
            })

            const exitPrice = order.filledPrice ?? price
            const entryPrice = Number(trade.entry_price)
            const pnl = trade.type === 'buy'
              ? (exitPrice - entryPrice) * qty
              : (entryPrice - exitPrice) * qty
            const pnlPct = pnl / (entryPrice * qty)

            await supabase
              .from('live_trades')
              .update({
                status: 'closed',
                exit_price: exitPrice,
                exit_time: new Date().toISOString(),
                exit_reason: exitReason,
                pnl,
                pnl_pct: pnlPct,
                exchange_order_id: order.orderId,
              })
              .eq('id', trade.id)

            await updateSessionStats(supabase, session.id, session.initial_capital)

            results.push({
              sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
              action: 'close',
              reason: `${exitReason} at ${exitPrice.toFixed(2)} (${closeSide})`,
              price, pnl, exchangeOrderId: order.orderId,
            })
          } catch (orderErr) {
            results.push({
              sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
              action: 'error',
              reason: `Close order failed: ${orderErr instanceof Error ? orderErr.message : 'Unknown'}`,
            })
          }
          continue
        }

        // ── Breakeven + Trailing Stop (parity with paper trading) ────────
        const cacheKey = `${session.symbol}:${session.timeframe}`
        const currentATR = await getCachedATR(cacheKey, session.symbol, session.timeframe as Timeframe, supabase)

        // Resolve entry_atr from metadata or backfill from SL distance
        const tradeMeta = (trade.metadata as Record<string, unknown>) || {}
        let entryATR = Number(tradeMeta.entry_atr) || null
        if (!entryATR && currentATR) {
          const slDist = Math.abs(Number(trade.entry_price) - Number(trade.stop_loss))
          const slMult = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
          entryATR = slDist / slMult
          await supabase.from('live_trades').update({
            metadata: { ...tradeMeta, entry_atr: entryATR },
          }).eq('id', trade.id)
        }
        const effectiveATR = entryATR ?? currentATR ?? 0

        // Breakeven: move SL to entry once price advances 0.5x entry_atr
        if (currentATR && !tradeMeta.breakeven_hit) {
          const entryPrice = Number(trade.entry_price)
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
            await supabase.from('live_trades').update({
              stop_loss: newSL,
              metadata: { ...tradeMeta, breakeven_hit: true },
            }).eq('id', trade.id)

            results.push({
              sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
              action: 'trail', reason: `Breakeven activated: SL moved to entry ${entryPrice.toFixed(2)}`, price,
            })
            continue
          }
        }

        // Trailing stop: EMA-based or ATR-based
        // IMPORTANT: Only trail AFTER breakeven has been hit (trade is in profit)
        if (currentATR && tradeMeta.breakeven_hit) {
          let trailUpdated = false

          if (params.trailing_stop_mode === 'ema') {
            const emaPeriod = params.trailing_ema_period ?? 20
            const emaVal = await getCachedEMATrail(cacheKey, session.symbol, session.timeframe as Timeframe, emaPeriod, supabase)
            if (emaVal !== null) {
              const entryPrice = Number(trade.entry_price)
              const emaTrailSL = trade.type === 'buy'
                ? emaVal - currentATR * 0.5
                : emaVal + currentATR * 0.5
              // Cap SL so it never exceeds current price minus a buffer
              // This prevents EMA (lagging indicator) from setting SL above price in downtrends
              const cappedSL = trade.type === 'buy'
                ? Math.min(emaTrailSL, price - currentATR * 0.3)
                : Math.max(emaTrailSL, price + currentATR * 0.3)
              // Never trail SL below entry once breakeven is active
              const floorSL = trade.type === 'buy'
                ? Math.max(cappedSL, entryPrice)
                : Math.min(cappedSL, entryPrice)
              const isBetter = trade.type === 'buy' ? floorSL > sl : floorSL < sl
              if (isBetter) {
                await supabase.from('live_trades').update({ stop_loss: floorSL }).eq('id', trade.id)
                results.push({
                  sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
                  action: 'trail',
                  reason: `EMA trailing SL ${trade.type === 'buy' ? 'raised' : 'lowered'} to ${floorSL.toFixed(2)}`,
                  price,
                })
                trailUpdated = true
              }
            }
          } else {
            // Default ATR-based trailing
            const entryPrice = Number(trade.entry_price)
            const activationATR = effectiveATR || currentATR
            const trailActivation = trade.type === 'buy'
              ? entryPrice + activationATR
              : entryPrice - activationATR

            if (trade.type === 'buy' && price > trailActivation) {
              const newTrailSL = price - currentATR
              if (newTrailSL > sl) {
                await supabase.from('live_trades').update({ stop_loss: newTrailSL }).eq('id', trade.id)
                results.push({
                  sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
                  action: 'trail', reason: `Trailing SL raised to ${newTrailSL.toFixed(2)}`, price,
                })
                trailUpdated = true
              }
            } else if (trade.type === 'sell' && price < trailActivation) {
              const newTrailSL = price + currentATR
              if (newTrailSL < sl) {
                await supabase.from('live_trades').update({ stop_loss: newTrailSL }).eq('id', trade.id)
                results.push({
                  sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
                  action: 'trail', reason: `Trailing SL lowered to ${newTrailSL.toFixed(2)}`, price,
                })
                trailUpdated = true
              }
            }
          }

          if (trailUpdated) continue
        }

        results.push({
          sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
          action: 'hold', reason: `Position open: ${trade.type} @ ${trade.entry_price}`, price,
        })
        continue
      }

      // No open position — check for signal (reuse paper signal engine)
      const sigKey = `${session.symbol}:${session.timeframe}:${session.strategy_id}`
      if (!signalCache.has(sigKey)) {
        signalCache.set(sigKey, await checkSignalFull(session.symbol, session.timeframe as Timeframe, params, supabase))
      }
      const signalResult = signalCache.get(sigKey)!

      if (signalResult.signal === null) {
        results.push({
          sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
          action: 'no_signal', reason: signalResult.rejectionReason, price,
        })
        continue
      }

      const { signal, atr: currentATR, reason: signalReason, activeSystems: signalSystems } = signalResult

      // Position sizing
      const slMult = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
      const tpMult = params.take_profit_pct > 1 ? params.take_profit_pct : 2.5
      const stopDist = currentATR * slMult
      const riskPct = RISK_TIERS[riskTier]?.riskPerTrade ?? 0.03
      const riskAmount = Number(session.current_capital) * riskPct
      const quantity = riskAmount / stopDist

      // Cap quantity by available capital (spot trading = no leverage)
      const maxByCapital = Number(session.current_capital) / price * 0.98 // 98% max to leave fee buffer
      const finalQuantity = Math.min(quantity, maxByCapital)

      if (riskAmount < 0.5 || finalQuantity <= 0) {
        results.push({
          sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
          action: 'skip', reason: 'Insufficient capital for position sizing', price,
        })
        continue
      }

      // Execute REAL order on Binance
      const side = signal === 'buy' ? 'BUY' : 'SELL'
      try {
        const order = await exchange.placeOrder({
          symbol: session.symbol,
          side: side as 'BUY' | 'SELL',
          type: 'MARKET',
          quantity: finalQuantity,
        })

        const entryPrice = order.filledPrice ?? price
        const stopLoss = signal === 'buy' ? entryPrice - stopDist : entryPrice + stopDist
        const takeProfit = signal === 'buy'
          ? entryPrice + currentATR * tpMult
          : entryPrice - currentATR * tpMult

        const { data: inserted } = await supabase
          .from('live_trades')
          .insert({
            user_id: session.user_id,
            strategy_id: session.strategy_id,
            session_id: session.id,
            symbol: session.symbol,
            type: signal,
            entry_price: entryPrice,
            quantity: order.filledQty || quantity,
            stop_loss: stopLoss,
            take_profit: takeProfit,
            exchange_order_id: order.orderId,
            metadata: { active_systems: signalSystems ?? [], entry_atr: currentATR },
          })
          .select('id')

        // If conflict (duplicate open trade), skip silently
        if (!inserted || inserted.length === 0) continue

        results.push({
          sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
          action: signal,
          reason: `[${riskTier}] ${signalReason} | Entry:${entryPrice.toFixed(2)} SL:${stopLoss.toFixed(2)} TP:${takeProfit.toFixed(2)} Qty:${(order.filledQty || finalQuantity).toFixed(4)}`,
          price, exchangeOrderId: order.orderId,
        })
      } catch (orderErr) {
        results.push({
          sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe, riskTier,
          action: 'error',
          reason: `Order failed: ${orderErr instanceof Error ? orderErr.message : 'Unknown'}`,
          price,
        })
      }
    } catch (err) {
      results.push({
        sessionId: session.id, symbol: session.symbol, timeframe: session.timeframe,
        riskTier: (session.risk_tier as string) || 'moderate',
        action: 'error',
        reason: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  // Log all decisions to live_agent_log (non-blocking)
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
    supabase.from('live_agent_log').insert(logsToInsert)
      .then(({ error }) => { if (error) console.error('Live agent log insert failed:', error.message) })
  }

  return NextResponse.json({
    message: `Ticked ${sessions.length} live sessions`,
    sessions: sessions.length,
    results,
    timestamp: new Date().toISOString(),
  })
}

// ── Session Stats ───────────────────────────────────────────────────────────

async function updateSessionStats(
  supabase: SupabaseClient,
  sessionId: string,
  initialCapital: number
) {
  const { data: trades } = await supabase
    .from('live_trades')
    .select('pnl, exit_time')
    .eq('session_id', sessionId)
    .eq('status', 'closed')
    .order('exit_time', { ascending: true })

  if (!trades) return

  const totalPnl = trades.reduce((s, t) => s + Number(t.pnl), 0)
  const winning = trades.filter(t => Number(t.pnl) > 0).length

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
    .from('live_sessions')
    .update({
      total_trades: trades.length,
      winning_trades: winning,
      net_pnl: totalPnl,
      current_capital: cap + totalPnl,
      max_drawdown_pct: maxDD,
    })
    .eq('id', sessionId)
}

// ── Signal Engine (shared with paper trading) ───────────────────────────────

const atrCache = new Map<string, number | null>()
const emaTrailCache = new Map<string, number | null>()
let htfBiasCache = new Map<string, 'bull' | 'bear' | 'neutral'>()

async function getCachedEMATrail(key: string, symbol: string, timeframe: Timeframe, period: number, dbClient: SupabaseClient): Promise<number | null> {
  const cacheKey = `${key}:${period}`
  if (emaTrailCache.has(cacheKey)) return emaTrailCache.get(cacheKey)!
  try {
    const tfMs = getTimeframeMs(timeframe)
    const lookbackMs = tfMs > 0 ? tfMs * 120 : 30 * 24 * 60 * 60 * 1000
    const candles = await getCandles({
      symbol, timeframe,
      startDate: new Date(Date.now() - lookbackMs).toISOString(),
      endDate: new Date().toISOString(),
      limit: 100,
    }, { client: dbClient })
    if (candles.length < period + 5) { emaTrailCache.set(cacheKey, null); return null }
    const ema = calculateEMA(candles, period)
    const val = ema.length > 0 ? ema[ema.length - 1].value : null
    emaTrailCache.set(cacheKey, val)
    return val
  } catch {
    emaTrailCache.set(cacheKey, null)
    return null
  }
}

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

async function checkSignalFull(
  symbol: string,
  timeframe: Timeframe,
  params: StrategyParameters,
  dbClient: SupabaseClient
): Promise<SignalCheckResult> {
  const endDate = new Date().toISOString()
  const tfMs = getTimeframeMs(timeframe)
  const lookbackMs = tfMs > 0 ? tfMs * 250 : 60 * 24 * 60 * 60 * 1000
  const startDate = new Date(Date.now() - lookbackMs).toISOString()

  const candles = await getCandles({ symbol, timeframe, startDate, endDate, limit: 500 }, { client: dbClient })
  if (candles.length < 50) return { signal: null, rejectionReason: `insufficient_candles:${candles.length}` }

  if (tfMs > 0) {
    const lastTs = new Date(candles[candles.length - 1].timestamp).getTime()
    const staleness = Date.now() - lastTs
    if (staleness > tfMs * 3) {
      return { signal: null, rejectionReason: `stale_data:${Math.round(staleness / 60000)}min` }
    }
  }

  const indicators = precomputeIndicators(candles, params)
  const lastIndex = candles.length - 1
  const prevIndex = candles.length - 2

  const prevTs = candles[prevIndex].timestamp
  const prevEF = indicators.emaFastMap.get(prevTs)
  const prevES = indicators.emaSlowMap.get(prevTs)
  if (prevEF === undefined || prevES === undefined) return { signal: null, rejectionReason: 'missing_prev_ema' }

  const ctx = buildContext(candles, lastIndex, params, indicators, prevEF, prevES)
  if (!ctx) return { signal: null, rejectionReason: 'context_build_failed' }

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

  const composite = params.signal_systems
    ? generateComposite(ctx, params.signal_systems as SignalSystemConfig[])
    : generateAdaptiveComposite(ctx)

  if (composite.direction === 'neutral') {
    return { signal: null, rejectionReason: `neutral_composite:conf=${composite.totalConfidence.toFixed(3)},systems=[${composite.activeSystems.join(',')}]` }
  }

  const signal: 'buy' | 'sell' = composite.direction === 'long' ? 'buy' : 'sell'

  const htfBias = await getCachedHTFBias(symbol, timeframe, dbClient)
  if (htfBias === 'bull' && signal === 'sell') return { signal: null, rejectionReason: `htf_blocked:bias=bull,signal=sell` }
  if (htfBias === 'bear' && signal === 'buy') return { signal: null, rejectionReason: `htf_blocked:bias=bear,signal=buy` }

  return { signal, atr: ctx.atr, reason: composite.activeSystems.join(' + '), activeSystems: composite.activeSystems }
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

    const threshold = (currentTf === '1m' || currentTf === '5m' || currentTf === '15m')
      ? 0.02
      : currentTf === '1h'
      ? 0.01
      : 0.005

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
