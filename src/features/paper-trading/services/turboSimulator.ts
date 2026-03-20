'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import {
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
  detectRegime,
} from '@/features/indicators/services/indicatorEngine'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import type { OHLCVCandle } from '@/features/market-data/types'
import type { RegimeResult } from '@/features/indicators/types'

// ============================================================
// TURBO SIMULATOR: Months of paper trading in seconds
// ============================================================

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

  const result = simulateOnCandles(candles as OHLCVCandle[], input.params, capital, input.symbol, input.timeframe, input.riskPerTrade)
  result.duration = Math.round(performance.now() - start)
  return result
}

/**
 * Pure simulation engine — no DB calls, just computation.
 * This is the core that runs at max speed.
 */
export function simulateOnCandles(
  candles: OHLCVCandle[],
  params: StrategyParameters,
  initialCapital: number,
  symbol: string,
  timeframe: string,
  riskPerTrade?: number,
): SimResult {
  // Calculate all indicators upfront
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const macd = calculateMACD(candles, params.macd_fast, params.macd_slow, params.macd_signal)
  const rsi = calculateRSI(candles, params.rsi_period)
  const bb = calculateBollingerBands(candles, params.bb_period, params.bb_std_dev)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)
  const regime = detectRegime(candles, adx, atr, emaFast, emaSlow)

  // Build lookup maps for O(1) access
  const emaFastMap = new Map(emaFast.map(e => [e.timestamp, e.value]))
  const emaSlowMap = new Map(emaSlow.map(e => [e.timestamp, e.value]))
  const macdMap = new Map(macd.map(e => [e.timestamp, e]))
  const rsiMap = new Map(rsi.map(e => [e.timestamp, e.value]))
  const bbMap = new Map(bb.map(e => [e.timestamp, e]))
  const atrMap = new Map(atr.map(e => [e.timestamp, e.value]))
  const adxMap = new Map(adx.map(e => [e.timestamp, e]))

  const trades: SimTrade[] = []
  let capital = initialCapital
  let peakCapital = initialCapital
  let maxDrawdown = 0

  let position: {
    type: 'buy' | 'sell'
    entryTime: string
    entryPrice: number
    quantity: number
    stopLoss: number
    takeProfit: number
    trailingActivation: number
    trailingStop: number | null
  } | null = null

  let prevEF: number | null = null
  let prevES: number | null = null

  const slMult = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
  const tpMult = params.take_profit_pct > 1 ? params.take_profit_pct : 2.5

  for (const candle of candles) {
    const ts = candle.timestamp
    const ef = emaFastMap.get(ts)
    const es = emaSlowMap.get(ts)
    const m = macdMap.get(ts)
    const r = rsiMap.get(ts)
    const b = bbMap.get(ts)
    const currentATR = atrMap.get(ts)
    const currentADX = adxMap.get(ts)

    if (ef === undefined || es === undefined || !m || r === undefined || !b) {
      if (ef !== undefined) prevEF = ef
      if (es !== undefined) prevES = es
      continue
    }

    // Trailing stop update
    if (position && position.trailingStop !== null && currentATR) {
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

    // Check SL/TP
    if (position) {
      let exitPrice: number | null = null
      let exitReason = ''

      if (position.type === 'buy') {
        if (candle.low <= position.stopLoss) { exitPrice = position.stopLoss; exitReason = 'stop_loss' }
        else if (candle.high >= position.takeProfit) { exitPrice = position.takeProfit; exitReason = 'take_profit' }
      } else {
        if (candle.high >= position.stopLoss) { exitPrice = position.stopLoss; exitReason = 'stop_loss' }
        else if (candle.low <= position.takeProfit) { exitPrice = position.takeProfit; exitReason = 'take_profit' }
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

    // Generate signal
    if (!position && prevEF !== null && prevES !== null) {
      const adxVal = currentADX?.adx ?? 0
      const isChoppy = adxVal < 20 && adxVal > 0
      const atrAvg = atr.length > 50
        ? atr.slice(-50).reduce((s, a) => s + a.value, 0) / 50
        : 0
      const isVolatile = currentATR !== undefined && atrAvg > 0 && currentATR > 2 * atrAvg

      if (!isChoppy && !isVolatile) {
        const signal = getSignal(prevEF, prevES, ef, es, m, r, params, b, currentADX, candle.close)

        if (signal && currentATR) {
          const riskAmt = capital * (riskPerTrade ?? 0.02)
          const stopDist = currentATR * slMult
          const qty = riskAmt / stopDist

          if (qty > 0 && riskAmt >= 0.5) {
            const sl = signal === 'buy' ? candle.close - stopDist : candle.close + stopDist
            const tp = signal === 'buy' ? candle.close + currentATR * tpMult : candle.close - currentATR * tpMult
            const trailAct = signal === 'buy' ? candle.close + currentATR : candle.close - currentATR

            position = {
              type: signal,
              entryTime: ts,
              entryPrice: candle.close,
              quantity: qty,
              stopLoss: sl,
              takeProfit: tp,
              trailingActivation: trailAct,
              trailingStop: sl,
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
      avgTradeDuration: `${avgDurationHours}h`,
      tradesPerMonth,
    },
    regime,
    duration: 0,
  }
}

/**
 * Signal generator — same 3 systems as backtest engine.
 */
function getSignal(
  prevEF: number, prevES: number, ef: number, es: number,
  m: { histogram: number }, r: number, params: StrategyParameters,
  b?: { upper: number; lower: number; middle: number },
  adx?: { adx: number; plusDI: number; minusDI: number },
  price?: number,
): 'buy' | 'sell' | null {
  // System 1: EMA crossover + confluence
  if (prevEF <= prevES && ef > es) {
    let conf = 0
    if (m.histogram > 0) conf++
    if (r < params.rsi_overbought) conf++
    if (conf >= 1) return 'buy'
  }
  if (prevEF >= prevES && ef < es) {
    let conf = 0
    if (m.histogram < 0) conf++
    if (r > params.rsi_oversold) conf++
    if (conf >= 1) return 'sell'
  }

  // System 2: BB mean-reversion + RSI extremes
  if (b && price) {
    if (price <= b.lower && r < params.rsi_oversold + 5) return 'buy'
    if (price >= b.upper && r > params.rsi_overbought - 5) return 'sell'
  }

  // System 3: Strong trend continuation (ADX > 30)
  if (adx && adx.adx > 30 && price) {
    if (adx.plusDI > adx.minusDI && r > 40 && r < 65 && ef > es) return 'buy'
    if (adx.minusDI > adx.plusDI && r < 60 && r > 35 && ef < es) return 'sell'
  }

  return null
}

// ============================================================
// GENETIC OPTIMIZER: Evolve strategy parameters automatically
// ============================================================

const PARAM_RANGES = {
  ema_fast: [3, 5, 7, 9, 12, 15, 20],
  ema_slow: [15, 20, 21, 26, 30, 40, 50, 60],
  rsi_period: [7, 10, 14, 21],
  rsi_oversold: [20, 25, 30, 35],
  rsi_overbought: [65, 70, 75, 80],
  macd_fast: [8, 10, 12, 15],
  macd_slow: [20, 24, 26, 30],
  macd_signal: [7, 9, 12],
  bb_period: [14, 20, 25],
  bb_std_dev: [1.5, 2, 2.5],
  // KEY INSIGHT: tight SL + wide TP = let winners run, cut losers fast
  stop_loss_pct: [0.5, 0.7, 0.8, 1.0, 1.2, 1.5],  // ATR multipliers (tighter)
  take_profit_pct: [2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0], // ATR multipliers (wider)
} as const

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

export function scoreResult(r: SimResult): number {
  const m = r.metrics
  if (m.totalTrades < 5) return -100 // Not enough trades

  // PRIMARY: Must be profitable. No profit = no good.
  let score = 0

  // Profitability is KING (40%) — this is what we're optimizing for
  score += m.netPnlPct * 50

  // Profit Factor > 1 means winners > losers in dollar terms (25%)
  if (m.profitFactor > 1) score += (m.profitFactor - 1) * 20
  else score -= (1 - m.profitFactor) * 30 // Penalize PF < 1 heavily

  // Risk-adjusted returns (15%)
  score += m.sharpeRatio * 5

  // Win rate matters but less than PnL (10%)
  score += (m.winRate - 0.5) * 10

  // Penalize drawdown (10%)
  score -= m.maxDrawdown * 15

  // Bonus for statistical significance
  if (m.totalTrades >= 15) score += 3
  if (m.totalTrades >= 30) score += 3
  if (m.totalTrades >= 50) score += 2

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
  let bestResult = simulateOnCandles(candles as OHLCVCandle[], input.baseParams, capital, input.symbol, input.timeframe)
  let bestScore = scoreResult(bestResult)
  allResults.push(bestResult)

  // Evolution loop
  for (let gen = 0; gen < generations; gen++) {
    const population: StrategyParameters[] = []
    for (let i = 0; i < popSize; i++) {
      population.push(mutateParams(bestResult.params))
    }

    for (const params of population) {
      const result = simulateOnCandles(candles as OHLCVCandle[], params, capital, input.symbol, input.timeframe)
      allResults.push(result)

      const score = scoreResult(result)
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

  return {
    best: bestResult,
    iterations: generations,
    explored: allResults.length,
    improvements,
    allResults: allResults
      .sort((a, b) => scoreResult(b) - scoreResult(a))
      .slice(0, 10), // Top 10 only
  }
}
