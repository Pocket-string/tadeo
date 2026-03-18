import type { OHLCVCandle } from '@/features/market-data/types'
import type { StrategyParameters, SignalType } from '@/types/database'
import type { BacktestTradeResult, BacktestMetrics, BacktestOutput } from '../types'
import { calculateEMA, calculateMACD, calculateRSI, calculateBollingerBands } from '@/features/indicators/services/indicatorEngine'

interface OpenPosition {
  type: SignalType
  entryTime: string
  entryPrice: number
  quantity: number
  stopLoss: number
  takeProfit: number
}

/**
 * Motor de backtesting.
 * Recibe candles OHLCV y parametros de estrategia, retorna metricas y trades.
 */
export function runBacktest(
  candles: OHLCVCandle[],
  params: StrategyParameters,
  initialCapital: number = 10000
): BacktestOutput {
  // Calcular indicadores
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const macd = calculateMACD(candles, params.macd_fast, params.macd_slow, params.macd_signal)
  const rsi = calculateRSI(candles, params.rsi_period)
  const bb = calculateBollingerBands(candles, params.bb_period, params.bb_std_dev)

  // Alinear todos los indicadores por timestamp
  const timestamps = new Set<string>()
  emaFast.forEach(e => timestamps.add(e.timestamp))
  emaSlow.forEach(e => timestamps.add(e.timestamp))
  macd.forEach(e => timestamps.add(e.timestamp))
  rsi.forEach(e => timestamps.add(e.timestamp))
  bb.forEach(e => timestamps.add(e.timestamp))

  // Crear mapas de lookup
  const emaFastMap = new Map(emaFast.map(e => [e.timestamp, e.value]))
  const emaSlowMap = new Map(emaSlow.map(e => [e.timestamp, e.value]))
  const macdMap = new Map(macd.map(e => [e.timestamp, e]))
  const rsiMap = new Map(rsi.map(e => [e.timestamp, e.value]))
  const bbMap = new Map(bb.map(e => [e.timestamp, e]))

  const trades: BacktestTradeResult[] = []
  const equityCurve: { timestamp: string; equity: number }[] = []
  let position: OpenPosition | null = null
  let capital = initialCapital
  let prevEmaFast: number | null = null
  let prevEmaSlow: number | null = null

  for (const candle of candles) {
    const ts = candle.timestamp
    const ef = emaFastMap.get(ts)
    const es = emaSlowMap.get(ts)
    const m = macdMap.get(ts)
    const r = rsiMap.get(ts)
    const b = bbMap.get(ts)

    // Solo operar cuando todos los indicadores estan disponibles
    if (ef === undefined || es === undefined || !m || r === undefined || !b) {
      if (ef !== undefined) prevEmaFast = ef
      if (es !== undefined) prevEmaSlow = es
      equityCurve.push({ timestamp: ts, equity: capital })
      continue
    }

    // Verificar stop-loss y take-profit en posicion abierta
    if (position) {
      const exitCheck = checkExit(position, candle, params)
      if (exitCheck) {
        const pnl = position.type === 'buy'
          ? (exitCheck.price - position.entryPrice) * position.quantity
          : (position.entryPrice - exitCheck.price) * position.quantity
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

    // Generar senal si no hay posicion abierta
    if (!position && prevEmaFast !== null && prevEmaSlow !== null) {
      const signal = generateSignal(
        prevEmaFast, prevEmaSlow, ef, es, m, r, params
      )

      if (signal) {
        const quantity = capital * 0.02 / candle.close // Risk 2% del capital (fractional for crypto)
        if (quantity > 0 && capital * 0.02 >= 1) { // At least $1 position
          const stopLoss = signal === 'buy'
            ? candle.close * (1 - params.stop_loss_pct)
            : candle.close * (1 + params.stop_loss_pct)
          const takeProfit = signal === 'buy'
            ? candle.close * (1 + params.take_profit_pct)
            : candle.close * (1 - params.take_profit_pct)

          position = {
            type: signal,
            entryTime: ts,
            entryPrice: candle.close,
            quantity,
            stopLoss,
            takeProfit,
          }
        }
      }
    }

    prevEmaFast = ef
    prevEmaSlow = es
    equityCurve.push({ timestamp: ts, equity: capital })
  }

  // Cerrar posicion abierta al final del periodo
  if (position && candles.length > 0) {
    const lastCandle = candles[candles.length - 1]
    const pnl = position.type === 'buy'
      ? (lastCandle.close - position.entryPrice) * position.quantity
      : (position.entryPrice - lastCandle.close) * position.quantity

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

  return { metrics, trades, equityCurve }
}

/**
 * Genera senal basada en confluencia de indicadores (scoring).
 * EMA cross es obligatorio. MACD y RSI suman confluencia.
 * Se necesita al menos 1 confirmacion adicional para entrar.
 */
function generateSignal(
  prevEmaFast: number,
  prevEmaSlow: number,
  emaFast: number,
  emaSlow: number,
  macd: { macd: number; signal: number; histogram: number },
  rsi: number,
  params: StrategyParameters
): SignalType | null {
  const emaCrossUp = prevEmaFast <= prevEmaSlow && emaFast > emaSlow
  const emaCrossDown = prevEmaFast >= prevEmaSlow && emaFast < emaSlow

  if (emaCrossUp) {
    let confluence = 0
    if (macd.histogram > 0) confluence++
    if (rsi < params.rsi_overbought) confluence++
    if (confluence >= 1) return 'buy'
  }

  if (emaCrossDown) {
    let confluence = 0
    if (macd.histogram < 0) confluence++
    if (rsi > params.rsi_oversold) confluence++
    if (confluence >= 1) return 'sell'
  }

  return null
}

/**
 * Verifica si la posicion debe cerrarse por stop-loss o take-profit.
 */
function checkExit(
  position: OpenPosition,
  candle: OHLCVCandle,
  _params: StrategyParameters
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
    tStatistic,
    profitFactor: grossLoss === 0 ? grossProfit > 0 ? Infinity : 0 : grossProfit / grossLoss,
  }
}
