import type { OHLCVCandle } from '@/features/market-data/types'
import type { EMAResult, MACDResult, RSIResult, BollingerBandsResult, ATRResult, ADXResult, RegimeResult, MarketRegime } from '../types'

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

/**
 * Calcula ATR (Average True Range)
 * True Range = max(high-low, |high-prevClose|, |low-prevClose|)
 * ATR = EMA(TR, period)
 */
export function calculateATR(candles: OHLCVCandle[], period: number): ATRResult[] {
  if (candles.length < period + 1) return []

  const trueRanges: number[] = []

  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    const tr = Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))
    trueRanges.push(tr)
  }

  const results: ATRResult[] = []

  // First ATR = SMA of first `period` true ranges
  let atr = 0
  for (let i = 0; i < period; i++) {
    atr += trueRanges[i]
  }
  atr /= period
  results.push({ timestamp: candles[period].timestamp, value: atr })

  // Subsequent ATRs = Wilder smoothing
  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period
    results.push({ timestamp: candles[i + 1].timestamp, value: atr })
  }

  return results
}

/**
 * Calcula ADX (Average Directional Index)
 * Mide la FUERZA de la tendencia (no la dirección)
 * ADX > 25 = tendencia fuerte, ADX < 20 = sin tendencia
 */
export function calculateADX(candles: OHLCVCandle[], period: number): ADXResult[] {
  if (candles.length < period * 2 + 1) return []

  // Step 1: Calculate +DM and -DM
  const plusDM: number[] = []
  const minusDM: number[] = []

  for (let i = 1; i < candles.length; i++) {
    const upMove = candles[i].high - candles[i - 1].high
    const downMove = candles[i - 1].low - candles[i].low

    plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0)
    minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0)
  }

  // Step 2: Calculate TR
  const tr: number[] = []
  for (let i = 1; i < candles.length; i++) {
    const high = candles[i].high
    const low = candles[i].low
    const prevClose = candles[i - 1].close
    tr.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)))
  }

  // Step 3: Smooth with Wilder's method
  const smoothTR: number[] = []
  const smoothPlusDM: number[] = []
  const smoothMinusDM: number[] = []

  let sumTR = 0, sumPDM = 0, sumMDM = 0
  for (let i = 0; i < period; i++) {
    sumTR += tr[i]
    sumPDM += plusDM[i]
    sumMDM += minusDM[i]
  }
  smoothTR.push(sumTR)
  smoothPlusDM.push(sumPDM)
  smoothMinusDM.push(sumMDM)

  for (let i = period; i < tr.length; i++) {
    const sTR = smoothTR[smoothTR.length - 1] - smoothTR[smoothTR.length - 1] / period + tr[i]
    const sPDM = smoothPlusDM[smoothPlusDM.length - 1] - smoothPlusDM[smoothPlusDM.length - 1] / period + plusDM[i]
    const sMDM = smoothMinusDM[smoothMinusDM.length - 1] - smoothMinusDM[smoothMinusDM.length - 1] / period + minusDM[i]
    smoothTR.push(sTR)
    smoothPlusDM.push(sPDM)
    smoothMinusDM.push(sMDM)
  }

  // Step 4: Calculate +DI and -DI
  const plusDI: number[] = []
  const minusDI: number[] = []
  const dx: number[] = []

  for (let i = 0; i < smoothTR.length; i++) {
    const pdi = smoothTR[i] === 0 ? 0 : (smoothPlusDM[i] / smoothTR[i]) * 100
    const mdi = smoothTR[i] === 0 ? 0 : (smoothMinusDM[i] / smoothTR[i]) * 100
    plusDI.push(pdi)
    minusDI.push(mdi)
    const diSum = pdi + mdi
    dx.push(diSum === 0 ? 0 : (Math.abs(pdi - mdi) / diSum) * 100)
  }

  // Step 5: ADX = EMA of DX
  if (dx.length < period) return []

  const results: ADXResult[] = []
  let adx = 0
  for (let i = 0; i < period; i++) {
    adx += dx[i]
  }
  adx /= period

  // First ADX point starts at period + period (need period DX values, each needing period candles)
  const baseIndex = period * 2
  if (baseIndex - 1 >= candles.length) return []

  results.push({
    timestamp: candles[baseIndex - 1].timestamp,
    adx,
    plusDI: plusDI[period - 1],
    minusDI: minusDI[period - 1],
  })

  for (let i = period; i < dx.length; i++) {
    adx = (adx * (period - 1) + dx[i]) / period
    const candleIdx = period + i
    if (candleIdx < candles.length) {
      results.push({
        timestamp: candles[candleIdx].timestamp,
        adx,
        plusDI: plusDI[i],
        minusDI: minusDI[i],
      })
    }
  }

  return results
}

/**
 * Detecta el régimen de mercado actual.
 * Trending: ADX > 25 + EMA slope consistente
 * Ranging: ADX < 20 + BB squeeze
 * Volatile: ATR > 2x promedio
 * Choppy: ADX < 20 + múltiples cruces EMA
 */
export function detectRegime(
  candles: OHLCVCandle[],
  adxResults: ADXResult[],
  atrResults: ATRResult[],
  emaFast: EMAResult[],
  emaSlow: EMAResult[]
): RegimeResult {
  if (adxResults.length === 0 || atrResults.length === 0) {
    return { regime: 'choppy', adx: 0, atrRatio: 1, emaCrossCount: 0, confidence: 0 }
  }

  const currentADX = adxResults[adxResults.length - 1].adx
  const currentATR = atrResults[atrResults.length - 1].value

  // ATR ratio: current vs average of last 50
  const recentATR = atrResults.slice(-50)
  const avgATR = recentATR.reduce((s, a) => s + a.value, 0) / recentATR.length
  const atrRatio = avgATR === 0 ? 1 : currentATR / avgATR

  // Count EMA crosses in last 20 candles
  let emaCrossCount = 0
  const recentFast = emaFast.slice(-21)
  const recentSlow = emaSlow.slice(-21)
  const minLen = Math.min(recentFast.length, recentSlow.length)
  for (let i = 1; i < minLen; i++) {
    const prevDiff = recentFast[i - 1].value - recentSlow[i - 1].value
    const currDiff = recentFast[i].value - recentSlow[i].value
    if ((prevDiff > 0 && currDiff <= 0) || (prevDiff <= 0 && currDiff > 0)) {
      emaCrossCount++
    }
  }

  let regime: MarketRegime
  let confidence: number

  if (atrRatio > 2.0) {
    regime = 'volatile'
    confidence = Math.min(1, (atrRatio - 2) / 2 + 0.5)
  } else if (currentADX > 25) {
    regime = 'trending'
    confidence = Math.min(1, (currentADX - 25) / 25 + 0.5)
  } else if (currentADX < 20 && emaCrossCount >= 3) {
    regime = 'choppy'
    confidence = Math.min(1, emaCrossCount / 5)
  } else {
    regime = 'ranging'
    confidence = Math.min(1, (20 - currentADX) / 20 + 0.3)
  }

  return { regime, adx: currentADX, atrRatio, emaCrossCount, confidence }
}
