import type { OHLCVCandle } from '@/features/market-data/types'
import type { StrategyParameters, SignalType } from '@/types/database'
import type { BacktestTradeResult, BacktestMetrics, BacktestOutput } from '../types'
import { calculateEMA, calculateMACD, calculateRSI, calculateBollingerBands, calculateATR, calculateADX, detectRegime } from '@/features/indicators/services/indicatorEngine'
import {
  precomputeIndicators,
  buildContext,
  generateComposite,
  generateAdaptiveComposite,
  type SignalSystemConfig,
} from '@/features/paper-trading/services/signalRegistry'

// Binance commission: 0.1% per side (entry + exit = 0.2% roundtrip)
const COMMISSION_RATE = 0.001

interface OpenPosition {
  type: SignalType
  entryTime: string
  entryPrice: number
  quantity: number
  stopLoss: number
  takeProfit: number
  trailingActivation: number // price level where trailing activates
  trailingStop: number | null // dynamic trailing stop level
  breakevenHit: boolean
  entryATR: number
}

/**
 * Motor de backtesting v2.
 * ATR-based dynamic stops, trailing stops, regime-aware filtering.
 */
export function runBacktest(
  candles: OHLCVCandle[],
  params: StrategyParameters,
  initialCapital: number = 10000
): BacktestOutput {
  // Calcular indicadores using shared registry (parity with live engine)
  const indicators = precomputeIndicators(candles, params)

  // Also calculate standalone for regime detection + map lookups
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)

  // Detect market regime
  const regime = detectRegime(candles, adx, atr, emaFast, emaSlow)

  // Pre-compute EMA for trailing stop if mode is 'ema'
  const trailingEmaMap = params.trailing_stop_mode === 'ema'
    ? new Map(calculateEMA(candles, params.trailing_ema_period ?? 20).map(e => [e.timestamp, e.value]))
    : null

  // Maps for quick lookup
  const atrMap = new Map(atr.map(e => [e.timestamp, e.value]))

  const trades: BacktestTradeResult[] = []
  const equityCurve: { timestamp: string; equity: number }[] = []
  let position: OpenPosition | null = null
  let capital = initialCapital

  // ATR multipliers for dynamic stops (use params SL/TP as multipliers if > 1, else as percentages)
  const slMultiplier = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
  const tpMultiplier = params.take_profit_pct > 1 ? params.take_profit_pct : 2.5

  for (let i = 1; i < candles.length; i++) {
    const candle = candles[i]
    const ts = candle.timestamp
    const currentATR = atrMap.get(ts)

    // Need previous EMA values for crossover detection (parity with live engine)
    const prevTs = candles[i - 1].timestamp
    const prevEF = indicators.emaFastMap.get(prevTs)
    const prevES = indicators.emaSlowMap.get(prevTs)

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

    // Update trailing stop if position open
    if (position && position.trailingStop !== null) {
      if (params.trailing_stop_mode === 'ema' && trailingEmaMap) {
        // EMA-based adaptive trailing: SL follows EMA ± 0.5*ATR buffer
        const emaVal = trailingEmaMap.get(ts)
        if (emaVal !== undefined && currentATR) {
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
          const newTrail = candle.high - (currentATR ?? (position.entryPrice * params.stop_loss_pct))
          if (newTrail > position.trailingStop) {
            position.trailingStop = newTrail
            if (position.trailingStop > position.stopLoss) {
              position.stopLoss = position.trailingStop
            }
          }
        } else if (position.type === 'sell' && candle.low < position.trailingActivation) {
          const newTrail = candle.low + (currentATR ?? (position.entryPrice * params.stop_loss_pct))
          if (newTrail < position.trailingStop) {
            position.trailingStop = newTrail
            if (position.trailingStop < position.stopLoss) {
              position.stopLoss = position.trailingStop
            }
          }
        }
      }
    }

    // Verificar stop-loss y take-profit en posicion abierta
    if (position) {
      const exitCheck = checkExit(position, candle)
      if (exitCheck) {
        const rawPnl = position.type === 'buy'
          ? (exitCheck.price - position.entryPrice) * position.quantity
          : (position.entryPrice - exitCheck.price) * position.quantity
        const entryComm = position.entryPrice * position.quantity * COMMISSION_RATE
        const exitComm = exitCheck.price * position.quantity * COMMISSION_RATE
        const pnl = rawPnl - entryComm - exitComm
        const pnlPct = pnl / (position.entryPrice * position.quantity)

        trades.push({
          entryTime: position.entryTime,
          exitTime: ts,
          type: position.type,
          entryPrice: position.entryPrice,
          exitPrice: exitCheck.price,
          quantity: position.quantity,
          pnl,
          pnlPct,
          exitReason: exitCheck.reason,
        })

        capital += pnl
        position = null
      }
    }

    // Signal generation using shared registry (parity with live engine)
    if (!position && prevEF !== undefined && prevES !== undefined) {
      const ctx = buildContext(candles, i, params, indicators, prevEF, prevES)
      if (!ctx) {
        equityCurve.push({ timestamp: ts, equity: capital })
        continue
      }

      // Regime filter (same thresholds as live engine — calibrated for crypto)
      const adxVal = ctx.adx?.adx ?? 0
      const isChoppy = adxVal < 15 && adxVal > 0
      const atrValues = Array.from(indicators.atrMap.values())
      const atrAvg = atrValues.length > 50
        ? atrValues.slice(-50).reduce((s, a) => s + a, 0) / 50
        : 0
      const isVolatile = atrAvg > 0 && ctx.atr > 3 * atrAvg

      if (!isChoppy && !isVolatile) {
        // Use same composite signal as live engine
        const composite = params.signal_systems
          ? generateComposite(ctx, params.signal_systems as SignalSystemConfig[])
          : generateAdaptiveComposite(ctx)

        if (composite.direction !== 'neutral' && currentATR !== undefined) {
          const signal: SignalType = composite.direction === 'long' ? 'buy' : 'sell'
          const riskAmount = capital * 0.02
          const stopDistance = currentATR * slMultiplier
          const quantity = riskAmount / stopDistance

          if (quantity > 0 && riskAmount >= 1) {
            const stopLoss = signal === 'buy'
              ? candle.close - stopDistance
              : candle.close + stopDistance
            const takeProfit = signal === 'buy'
              ? candle.close + currentATR * tpMultiplier
              : candle.close - currentATR * tpMultiplier
            const trailingActivation = signal === 'buy'
              ? candle.close + currentATR
              : candle.close - currentATR

            position = {
              type: signal,
              entryTime: ts,
              entryPrice: candle.close,
              quantity,
              stopLoss,
              takeProfit,
              trailingActivation,
              trailingStop: stopLoss,
              breakevenHit: false,
              entryATR: currentATR,
            }
          }
        }
      }
    }

    equityCurve.push({ timestamp: ts, equity: capital })
  }

  // Cerrar posicion abierta al final del periodo
  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1]
    const rawPnl = position.type === 'buy'
      ? (lastCandle.close - position.entryPrice) * position.quantity
      : (position.entryPrice - lastCandle.close) * position.quantity
    const entryComm = position.entryPrice * position.quantity * COMMISSION_RATE
    const exitComm = lastCandle.close * position.quantity * COMMISSION_RATE
    const pnl = rawPnl - entryComm - exitComm

    trades.push({
      entryTime: position.entryTime,
      exitTime: lastCandle.timestamp,
      type: position.type,
      entryPrice: position.entryPrice,
      exitPrice: lastCandle.close,
      quantity: position.quantity,
      pnl,
      pnlPct: pnl / (position.entryPrice * position.quantity),
      exitReason: 'end_of_period',
    })
    capital += pnl
  }

  const metrics = calculateMetrics(trades, initialCapital, equityCurve)

  return { metrics, trades, equityCurve, regime }
}

/**
 * Verifica si la posicion debe cerrarse por stop-loss o take-profit.
 */
function checkExit(
  position: OpenPosition,
  candle: OHLCVCandle,
): { price: number; reason: 'stop_loss' | 'take_profit' } | null {
  if (position.type === 'buy') {
    if (candle.low <= position.stopLoss) {
      return { price: position.stopLoss, reason: 'stop_loss' }
    }
    if (candle.high >= position.takeProfit) {
      return { price: position.takeProfit, reason: 'take_profit' }
    }
  } else {
    if (candle.high >= position.stopLoss) {
      return { price: position.stopLoss, reason: 'stop_loss' }
    }
    if (candle.low <= position.takeProfit) {
      return { price: position.takeProfit, reason: 'take_profit' }
    }
  }
  return null
}

/**
 * Calcula metricas de rendimiento del backtest.
 */
function calculateMetrics(
  trades: BacktestTradeResult[],
  initialCapital: number,
  equityCurve: { timestamp: string; equity: number }[]
): BacktestMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0,
      winningTrades: 0,
      losingTrades: 0,
      winRate: 0,
      netProfit: 0,
      maxDrawdown: 0,
      sharpeRatio: 0,
      sortinoRatio: 0,
      tStatistic: 0,
      profitFactor: 0,
    }
  }

  const winningTrades = trades.filter(t => t.pnl > 0)
  const losingTrades = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0)
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0)
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0))

  // Max drawdown
  let peak = initialCapital
  let maxDrawdown = 0
  for (const point of equityCurve) {
    if (point.equity > peak) peak = point.equity
    const dd = (peak - point.equity) / peak
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  // Sharpe ratio (annualizado, asumiendo 252 dias de trading)
  const returns = trades.map(t => t.pnlPct)
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length
  const stdReturn = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  )
  const sharpeRatio = stdReturn === 0 ? 0 : (avgReturn / stdReturn) * Math.sqrt(252)

  // Sortino ratio (penalizes only downside volatility)
  const downsideDev = Math.sqrt(
    returns.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / returns.length
  )
  const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * Math.sqrt(252) : 0

  // t-statistic = avgReturn / (stdReturn / sqrt(n))
  const tStatistic = stdReturn === 0 ? 0 : (avgReturn / (stdReturn / Math.sqrt(trades.length)))

  return {
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: trades.length > 0 ? winningTrades.length / trades.length : 0,
    netProfit: totalPnl,
    maxDrawdown,
    sharpeRatio,
    sortinoRatio,
    tStatistic,
    profitFactor: grossLoss === 0 ? grossProfit > 0 ? Infinity : 0 : grossProfit / grossLoss,
  }
}
