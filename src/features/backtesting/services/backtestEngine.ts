import type { OHLCVCandle } from '@/features/market-data/types'
import type { StrategyParameters, SignalType } from '@/types/database'
import type { BacktestTradeResult, BacktestMetrics, BacktestOutput } from '../types'
import { calculateEMA, calculateMACD, calculateRSI, calculateBollingerBands, calculateATR, calculateADX, detectRegime } from '@/features/indicators/services/indicatorEngine'

interface OpenPosition {
  type: SignalType
  entryTime: string
  entryPrice: number
  quantity: number
  stopLoss: number
  takeProfit: number
  trailingActivation: number // price level where trailing activates
  trailingStop: number | null // dynamic trailing stop level
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
  // Calcular indicadores
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const macd = calculateMACD(candles, params.macd_fast, params.macd_slow, params.macd_signal)
  const rsi = calculateRSI(candles, params.rsi_period)
  const bb = calculateBollingerBands(candles, params.bb_period, params.bb_std_dev)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)

  // Detect market regime
  const regime = detectRegime(candles, adx, atr, emaFast, emaSlow)

  // Crear mapas de lookup
  const emaFastMap = new Map(emaFast.map(e => [e.timestamp, e.value]))
  const emaSlowMap = new Map(emaSlow.map(e => [e.timestamp, e.value]))
  const macdMap = new Map(macd.map(e => [e.timestamp, e]))
  const rsiMap = new Map(rsi.map(e => [e.timestamp, e.value]))
  const bbMap = new Map(bb.map(e => [e.timestamp, e]))
  const atrMap = new Map(atr.map(e => [e.timestamp, e.value]))
  const adxMap = new Map(adx.map(e => [e.timestamp, e]))

  const trades: BacktestTradeResult[] = []
  const equityCurve: { timestamp: string; equity: number }[] = []
  let position: OpenPosition | null = null
  let capital = initialCapital
  let prevEmaFast: number | null = null
  let prevEmaSlow: number | null = null

  // ATR multipliers for dynamic stops (use params SL/TP as multipliers if > 1, else as percentages)
  const slMultiplier = params.stop_loss_pct > 1 ? params.stop_loss_pct : 1.5
  const tpMultiplier = params.take_profit_pct > 1 ? params.take_profit_pct : 2.5

  for (const candle of candles) {
    const ts = candle.timestamp
    const ef = emaFastMap.get(ts)
    const es = emaSlowMap.get(ts)
    const m = macdMap.get(ts)
    const r = rsiMap.get(ts)
    const b = bbMap.get(ts)
    const currentATR = atrMap.get(ts)
    const currentADX = adxMap.get(ts)

    // Solo operar cuando todos los indicadores estan disponibles
    if (ef === undefined || es === undefined || !m || r === undefined || !b) {
      if (ef !== undefined) prevEmaFast = ef
      if (es !== undefined) prevEmaSlow = es
      equityCurve.push({ timestamp: ts, equity: capital })
      continue
    }

    // Update trailing stop if position open
    if (position && position.trailingStop !== null) {
      if (position.type === 'buy' && candle.high > position.trailingActivation) {
        // Price hit trailing activation — trail the stop
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

    // Verificar stop-loss y take-profit en posicion abierta
    if (position) {
      const exitCheck = checkExit(position, candle)
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
      // Regime filter: skip choppy and volatile markets
      const adxVal = currentADX?.adx ?? 0
      const isChoppy = adxVal < 20 && adxVal > 0
      const isVolatile = currentATR !== undefined && atr.length > 50 &&
        currentATR > 2 * (atr.slice(-50).reduce((s, a) => s + a.value, 0) / Math.min(50, atr.length))

      if (!isChoppy && !isVolatile) {
        const signal = generateSignal(
          prevEmaFast, prevEmaSlow, ef, es, m, r, params, b, currentADX, candle.close
        )

        if (signal && currentATR !== undefined) {
          // ATR-based position sizing: risk_amount / (ATR * sl_multiplier) = quantity
          const riskAmount = capital * 0.02
          const stopDistance = currentATR * slMultiplier
          const quantity = riskAmount / stopDistance

          if (quantity > 0 && riskAmount >= 1) {
            // ATR-based dynamic stops
            const stopLoss = signal === 'buy'
              ? candle.close - stopDistance
              : candle.close + stopDistance
            const takeProfit = signal === 'buy'
              ? candle.close + currentATR * tpMultiplier
              : candle.close - currentATR * tpMultiplier

            // Trailing stop activates at 1x ATR profit
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
              trailingStop: signal === 'buy' ? stopLoss : stopLoss,
            }
          }
        } else if (signal && currentATR === undefined) {
          // Fallback to percentage-based stops if ATR not available
          const riskAmount = capital * 0.02
          const quantity = riskAmount / candle.close
          if (quantity > 0 && riskAmount >= 1) {
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
              trailingActivation: Infinity,
              trailingStop: null,
            }
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

  return { metrics, trades, equityCurve, regime }
}

/**
 * Genera senal basada en multiples sistemas:
 * 1. EMA crossover + confluencia (trend following)
 * 2. Bollinger Band bounce + RSI extremo (mean reversion)
 * 3. Strong trend momentum (ADX > 30 + alignment)
 * Cada sistema opera independientemente para generar más trades.
 */
function generateSignal(
  prevEmaFast: number,
  prevEmaSlow: number,
  emaFast: number,
  emaSlow: number,
  macd: { macd: number; signal: number; histogram: number },
  rsi: number,
  params: StrategyParameters,
  bb?: { upper: number; lower: number; middle: number; bandwidth: number },
  adx?: { adx: number; plusDI: number; minusDI: number },
  price?: number
): SignalType | null {
  // System 1: EMA Crossover + Confluence (original)
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

  // System 2: Bollinger Band mean-reversion + RSI extremes
  if (bb && price) {
    // Buy: price touches/breaks lower BB + RSI oversold + MACD turning up
    if (price <= bb.lower && rsi < params.rsi_oversold + 5 && macd.histogram > macd.signal * -0.5) {
      return 'buy'
    }
    // Sell: price touches/breaks upper BB + RSI overbought + MACD turning down
    if (price >= bb.upper && rsi > params.rsi_overbought - 5 && macd.histogram < macd.signal * 0.5) {
      return 'sell'
    }
  }

  // System 3: Strong trend continuation (no cross needed)
  if (adx && adx.adx > 30) {
    // Strong uptrend: EMA aligned + DI+ > DI- + RSI pullback to 40-55
    if (emaFast > emaSlow && adx.plusDI > adx.minusDI && rsi >= 40 && rsi <= 55 && macd.histogram > 0) {
      return 'buy'
    }
    // Strong downtrend: EMA aligned + DI- > DI+ + RSI pullback to 45-60
    if (emaFast < emaSlow && adx.minusDI > adx.plusDI && rsi >= 45 && rsi <= 60 && macd.histogram < 0) {
      return 'sell'
    }
  }

  return null
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
