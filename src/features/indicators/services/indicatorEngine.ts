import type { OHLCVCandle } from '@/features/market-data/types'
import type { EMAResult, MACDResult, RSIResult, BollingerBandsResult } from '../types'

/**
 * Calcula EMA (Exponential Moving Average)
 * Formula: EMA = price * k + EMA_prev * (1 - k), donde k = 2 / (period + 1)
 */
export function calculateEMA(candles: OHLCVCandle[], period: number): EMAResult[] {
  if (candles.length < period) return []

  const k = 2 / (period + 1)
  const results: EMAResult[] = []

  // SMA inicial como seed del EMA
  let sum = 0
  for (let i = 0; i < period; i++) {
    sum += candles[i].close
  }
  let ema = sum / period
  results.push({ timestamp: candles[period - 1].timestamp, value: ema })

  // EMA a partir del periodo
  for (let i = period; i < candles.length; i++) {
    ema = candles[i].close * k + ema * (1 - k)
    results.push({ timestamp: candles[i].timestamp, value: ema })
  }

  return results
}

/**
 * Calcula MACD (Moving Average Convergence Divergence)
 * MACD line = EMA(fast) - EMA(slow)
 * Signal line = EMA(MACD line, signal_period)
 * Histogram = MACD - Signal
 */
export function calculateMACD(
  candles: OHLCVCandle[],
  fastPeriod: number,
  slowPeriod: number,
  signalPeriod: number
): MACDResult[] {
  const emaFast = calculateEMA(candles, fastPeriod)
  const emaSlow = calculateEMA(candles, slowPeriod)

  if (emaSlow.length === 0) return []

  // Alinear EMA fast y slow por timestamp
  const slowStart = emaSlow[0].timestamp
  const alignedFast = emaFast.filter(e => e.timestamp >= slowStart)

  if (alignedFast.length !== emaSlow.length) {
    // Alinear por longitud minima
    const minLen = Math.min(alignedFast.length, emaSlow.length)
    alignedFast.splice(0, alignedFast.length - minLen)
    emaSlow.splice(0, emaSlow.length - minLen)
  }

  // MACD line
  const macdLine: { timestamp: string; value: number }[] = []
  for (let i = 0; i < Math.min(alignedFast.length, emaSlow.length); i++) {
    macdLine.push({
      timestamp: emaSlow[i].timestamp,
      value: alignedFast[i].value - emaSlow[i].value,
    })
  }

  if (macdLine.length < signalPeriod) return []

  // Signal line = EMA del MACD line
  const k = 2 / (signalPeriod + 1)
  let signalEma = 0
  for (let i = 0; i < signalPeriod; i++) {
    signalEma += macdLine[i].value
  }
  signalEma /= signalPeriod

  const results: MACDResult[] = []
  results.push({
    timestamp: macdLine[signalPeriod - 1].timestamp,
    macd: macdLine[signalPeriod - 1].value,
    signal: signalEma,
    histogram: macdLine[signalPeriod - 1].value - signalEma,
  })

  for (let i = signalPeriod; i < macdLine.length; i++) {
    signalEma = macdLine[i].value * k + signalEma * (1 - k)
    results.push({
      timestamp: macdLine[i].timestamp,
      macd: macdLine[i].value,
      signal: signalEma,
      histogram: macdLine[i].value - signalEma,
    })
  }

  return results
}

/**
 * Calcula RSI (Relative Strength Index)
 * RSI = 100 - (100 / (1 + RS)), donde RS = avgGain / avgLoss
 */
export function calculateRSI(candles: OHLCVCandle[], period: number): RSIResult[] {
  if (candles.length < period + 1) return []

  const results: RSIResult[] = []
  let avgGain = 0
  let avgLoss = 0

  // Primer periodo: promedio simple
  for (let i = 1; i <= period; i++) {
    const change = candles[i].close - candles[i - 1].close
    if (change > 0) avgGain += change
    else avgLoss += Math.abs(change)
  }
  avgGain /= period
  avgLoss /= period

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss
  results.push({
    timestamp: candles[period].timestamp,
    value: 100 - (100 / (1 + rs)),
  })

  // Periodos siguientes: suavizado Wilder
  for (let i = period + 1; i < candles.length; i++) {
    const change = candles[i].close - candles[i - 1].close
    const gain = change > 0 ? change : 0
    const loss = change < 0 ? Math.abs(change) : 0

    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period

    const currentRs = avgLoss === 0 ? 100 : avgGain / avgLoss
    results.push({
      timestamp: candles[i].timestamp,
      value: 100 - (100 / (1 + currentRs)),
    })
  }

  return results
}

/**
 * Calcula Bandas de Bollinger
 * Middle = SMA(period)
 * Upper = Middle + stdDev * std
 * Lower = Middle - stdDev * std
 */
export function calculateBollingerBands(
  candles: OHLCVCandle[],
  period: number,
  stdDev: number
): BollingerBandsResult[] {
  if (candles.length < period) return []

  const results: BollingerBandsResult[] = []

  for (let i = period - 1; i < candles.length; i++) {
    const slice = candles.slice(i - period + 1, i + 1)
    const closes = slice.map(c => c.close)

    const sma = closes.reduce((a, b) => a + b, 0) / period
    const variance = closes.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period
    const std = Math.sqrt(variance)

    const upper = sma + stdDev * std
    const lower = sma - stdDev * std
    const bandwidth = upper - lower

    results.push({
      timestamp: candles[i].timestamp,
      upper,
      middle: sma,
      lower,
      bandwidth,
    })
  }

  return results
}
