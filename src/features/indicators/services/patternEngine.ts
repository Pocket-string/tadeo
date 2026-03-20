import type { OHLCVCandle } from '@/features/market-data/types'
import type { RSIResult } from '../types'

// ─── Types ───────────────────────────────────────────────────────────────────

export type PatternDirection = 'bullish' | 'bearish' | 'neutral'

export interface PatternResult {
  detected: boolean
  type: PatternDirection
  confidence: number // 0-1
  metadata: Record<string, unknown>
}

export interface SRLevel {
  price: number
  touches: number
  type: 'support' | 'resistance'
  strength: number // 0-1 based on touches and recency
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Find local extrema (peaks and valleys) using a window of ±order candles */
export function findPivots(
  candles: OHLCVCandle[],
  order: number = 5
): { peaks: number[]; valleys: number[] } {
  const peaks: number[] = []
  const valleys: number[] = []

  for (let i = order; i < candles.length - order; i++) {
    let isPeak = true
    let isValley = true

    for (let j = 1; j <= order; j++) {
      if (candles[i].high <= candles[i - j].high || candles[i].high <= candles[i + j].high) {
        isPeak = false
      }
      if (candles[i].low >= candles[i - j].low || candles[i].low >= candles[i + j].low) {
        isValley = false
      }
    }

    if (isPeak) peaks.push(i)
    if (isValley) valleys.push(i)
  }

  return { peaks, valleys }
}

// ─── Pattern 1: Double Top / Double Bottom ───────────────────────────────────

/**
 * Detects double top (M) and double bottom (W) patterns.
 * Double top: two peaks at similar price with a valley between them.
 * Double bottom: two valleys at similar price with a peak between them.
 * Tolerance: peaks/valleys must be within `tolerance` % of each other.
 */
export function detectDoubleTopBottom(
  candles: OHLCVCandle[],
  lookback: number = 60,
  tolerance: number = 0.015,
  pivotOrder: number = 5
): PatternResult {
  const slice = candles.slice(-lookback)
  if (slice.length < pivotOrder * 2 + 3) {
    return { detected: false, type: 'neutral', confidence: 0, metadata: {} }
  }

  const { peaks, valleys } = findPivots(slice, pivotOrder)

  // Check double top: last two peaks at similar level
  if (peaks.length >= 2) {
    const p1 = peaks[peaks.length - 2]
    const p2 = peaks[peaks.length - 1]
    const price1 = slice[p1].high
    const price2 = slice[p2].high
    const diff = Math.abs(price1 - price2) / Math.max(price1, price2)

    if (diff <= tolerance && p2 > p1 + 2) {
      // Find valley between peaks
      const valleyBetween = valleys.find(v => v > p1 && v < p2)
      if (valleyBetween !== undefined) {
        const neckline = slice[valleyBetween].low
        const currentPrice = slice[slice.length - 1].close
        // Bearish if price is breaking below neckline
        const breaking = currentPrice < neckline
        const confidence = breaking
          ? Math.min(1, 0.6 + (neckline - currentPrice) / neckline * 10)
          : 0.3 + (1 - diff / tolerance) * 0.3

        return {
          detected: true,
          type: 'bearish',
          confidence: Math.min(1, confidence),
          metadata: {
            pattern: 'double_top',
            peak1Price: price1,
            peak2Price: price2,
            neckline,
            breakingNeckline: breaking,
            peak1Index: p1,
            peak2Index: p2,
          },
        }
      }
    }
  }

  // Check double bottom: last two valleys at similar level
  if (valleys.length >= 2) {
    const v1 = valleys[valleys.length - 2]
    const v2 = valleys[valleys.length - 1]
    const price1 = slice[v1].low
    const price2 = slice[v2].low
    const diff = Math.abs(price1 - price2) / Math.max(price1, price2)

    if (diff <= tolerance && v2 > v1 + 2) {
      const peakBetween = peaks.find(p => p > v1 && p < v2)
      if (peakBetween !== undefined) {
        const neckline = slice[peakBetween].high
        const currentPrice = slice[slice.length - 1].close
        const breaking = currentPrice > neckline
        const confidence = breaking
          ? Math.min(1, 0.6 + (currentPrice - neckline) / neckline * 10)
          : 0.3 + (1 - diff / tolerance) * 0.3

        return {
          detected: true,
          type: 'bullish',
          confidence: Math.min(1, confidence),
          metadata: {
            pattern: 'double_bottom',
            valley1Price: price1,
            valley2Price: price2,
            neckline,
            breakingNeckline: breaking,
            valley1Index: v1,
            valley2Index: v2,
          },
        }
      }
    }
  }

  return { detected: false, type: 'neutral', confidence: 0, metadata: {} }
}

// ─── Pattern 2: RSI Divergence ───────────────────────────────────────────────

/**
 * Detects bullish/bearish RSI divergence.
 * Bullish divergence: price makes lower low, RSI makes higher low.
 * Bearish divergence: price makes higher high, RSI makes lower high.
 */
export function detectRSIDivergence(
  candles: OHLCVCandle[],
  rsiValues: RSIResult[],
  lookback: number = 30,
  pivotOrder: number = 3
): PatternResult {
  if (candles.length < lookback || rsiValues.length < lookback) {
    return { detected: false, type: 'neutral', confidence: 0, metadata: {} }
  }

  const priceSlice = candles.slice(-lookback)
  const rsiSlice = rsiValues.slice(-lookback)

  // Align by length
  const len = Math.min(priceSlice.length, rsiSlice.length)
  const prices = priceSlice.slice(-len)
  const rsis = rsiSlice.slice(-len)

  const pricePivots = findPivots(prices, pivotOrder)
  // Build pseudo-candles from RSI for pivot detection
  const rsiCandles: OHLCVCandle[] = rsis.map((r, i) => ({
    timestamp: r.timestamp,
    open: r.value,
    high: r.value,
    low: r.value,
    close: r.value,
    volume: prices[i]?.volume ?? 0,
  }))
  const rsiPivots = findPivots(rsiCandles, pivotOrder)

  // Bearish divergence: price higher highs, RSI lower highs
  if (pricePivots.peaks.length >= 2 && rsiPivots.peaks.length >= 2) {
    const pp1 = pricePivots.peaks[pricePivots.peaks.length - 2]
    const pp2 = pricePivots.peaks[pricePivots.peaks.length - 1]
    const rp1 = rsiPivots.peaks[rsiPivots.peaks.length - 2]
    const rp2 = rsiPivots.peaks[rsiPivots.peaks.length - 1]

    const priceHigherHigh = prices[pp2].high > prices[pp1].high
    const rsiLowerHigh = rsis[rp2].value < rsis[rp1].value

    if (priceHigherHigh && rsiLowerHigh) {
      const priceDiff = (prices[pp2].high - prices[pp1].high) / prices[pp1].high
      const rsiDiff = (rsis[rp1].value - rsis[rp2].value) / rsis[rp1].value
      const confidence = Math.min(1, 0.4 + priceDiff * 5 + rsiDiff * 3)

      return {
        detected: true,
        type: 'bearish',
        confidence: Math.min(1, confidence),
        metadata: {
          divergence: 'bearish',
          pricePeak1: prices[pp1].high,
          pricePeak2: prices[pp2].high,
          rsiPeak1: rsis[rp1].value,
          rsiPeak2: rsis[rp2].value,
        },
      }
    }
  }

  // Bullish divergence: price lower lows, RSI higher lows
  if (pricePivots.valleys.length >= 2 && rsiPivots.valleys.length >= 2) {
    const pv1 = pricePivots.valleys[pricePivots.valleys.length - 2]
    const pv2 = pricePivots.valleys[pricePivots.valleys.length - 1]
    const rv1 = rsiPivots.valleys[rsiPivots.valleys.length - 2]
    const rv2 = rsiPivots.valleys[rsiPivots.valleys.length - 1]

    const priceLowerLow = prices[pv2].low < prices[pv1].low
    const rsiHigherLow = rsis[rv2].value > rsis[rv1].value

    if (priceLowerLow && rsiHigherLow) {
      const priceDiff = (prices[pv1].low - prices[pv2].low) / prices[pv1].low
      const rsiDiff = (rsis[rv2].value - rsis[rv1].value) / rsis[rv1].value
      const confidence = Math.min(1, 0.4 + priceDiff * 5 + rsiDiff * 3)

      return {
        detected: true,
        type: 'bullish',
        confidence: Math.min(1, confidence),
        metadata: {
          divergence: 'bullish',
          priceValley1: prices[pv1].low,
          priceValley2: prices[pv2].low,
          rsiValley1: rsis[rv1].value,
          rsiValley2: rsis[rv2].value,
        },
      }
    }
  }

  return { detected: false, type: 'neutral', confidence: 0, metadata: {} }
}

// ─── Pattern 3: Support / Resistance Levels ──────────────────────────────────

/**
 * Identifies support and resistance levels by clustering pivot points.
 * Groups pivots within `clusterTolerance` % of each other.
 * Returns levels sorted by strength (touch count × recency weight).
 */
export function detectSupportResistance(
  candles: OHLCVCandle[],
  lookback: number = 120,
  clusterTolerance: number = 0.005,
  pivotOrder: number = 5
): SRLevel[] {
  const slice = candles.slice(-lookback)
  if (slice.length < pivotOrder * 2 + 1) return []

  const { peaks, valleys } = findPivots(slice, pivotOrder)
  const totalCandles = slice.length

  // Collect all pivot prices with type and index
  const pivotPoints: { price: number; type: 'resistance' | 'support'; index: number }[] = []

  for (const p of peaks) {
    pivotPoints.push({ price: slice[p].high, type: 'resistance', index: p })
  }
  for (const v of valleys) {
    pivotPoints.push({ price: slice[v].low, type: 'support', index: v })
  }

  if (pivotPoints.length === 0) return []

  // Sort by price
  pivotPoints.sort((a, b) => a.price - b.price)

  // Cluster pivots within tolerance
  const clusters: { prices: number[]; types: ('support' | 'resistance')[]; indices: number[] }[] = []
  let currentCluster = { prices: [pivotPoints[0].price], types: [pivotPoints[0].type], indices: [pivotPoints[0].index] }

  for (let i = 1; i < pivotPoints.length; i++) {
    const avgPrice = currentCluster.prices.reduce((a, b) => a + b, 0) / currentCluster.prices.length
    const diff = Math.abs(pivotPoints[i].price - avgPrice) / avgPrice

    if (diff <= clusterTolerance) {
      currentCluster.prices.push(pivotPoints[i].price)
      currentCluster.types.push(pivotPoints[i].type)
      currentCluster.indices.push(pivotPoints[i].index)
    } else {
      clusters.push(currentCluster)
      currentCluster = { prices: [pivotPoints[i].price], types: [pivotPoints[i].type], indices: [pivotPoints[i].index] }
    }
  }
  clusters.push(currentCluster)

  // Convert clusters to SR levels
  const levels: SRLevel[] = clusters
    .filter(c => c.prices.length >= 2) // At least 2 touches
    .map(c => {
      const avgPrice = c.prices.reduce((a, b) => a + b, 0) / c.prices.length
      const touches = c.prices.length
      const supportCount = c.types.filter(t => t === 'support').length
      const resistanceCount = c.types.filter(t => t === 'resistance').length
      const type: 'support' | 'resistance' = supportCount >= resistanceCount ? 'support' : 'resistance'

      // Recency weight: more recent touches score higher
      const recencyScore = c.indices.reduce((sum, idx) => sum + idx / totalCandles, 0) / c.indices.length

      const strength = Math.min(1, (touches / 5) * 0.6 + recencyScore * 0.4)

      return { price: avgPrice, touches, type, strength }
    })
    .sort((a, b) => b.strength - a.strength)

  return levels
}

// ─── Pattern 4: Volume Confirmation ──────────────────────────────────────────

/**
 * Validates a signal direction with volume analysis.
 * A signal is confirmed if current volume is significantly above average.
 * Also checks if volume trend aligns with price direction.
 */
export function detectVolumeConfirmation(
  candles: OHLCVCandle[],
  signalDirection: 'long' | 'short',
  volumeAvgPeriod: number = 20,
  spikeThreshold: number = 1.5
): PatternResult {
  if (candles.length < volumeAvgPeriod + 1) {
    return { detected: false, type: 'neutral', confidence: 0, metadata: {} }
  }

  const recent = candles.slice(-(volumeAvgPeriod + 1))
  const currentCandle = recent[recent.length - 1]
  const avgVolume = recent.slice(0, -1).reduce((s, c) => s + c.volume, 0) / volumeAvgPeriod
  const currentVolume = currentCandle.volume

  if (avgVolume === 0) {
    return { detected: false, type: 'neutral', confidence: 0, metadata: { reason: 'no_volume_data' } }
  }

  const volumeRatio = currentVolume / avgVolume
  const isSpike = volumeRatio >= spikeThreshold

  // Check price direction alignment
  const priceChange = currentCandle.close - currentCandle.open
  const priceAligned =
    (signalDirection === 'long' && priceChange > 0) ||
    (signalDirection === 'short' && priceChange < 0)

  // Volume trend: are last 3 candles increasing in volume?
  const last3 = candles.slice(-3)
  const volumeIncreasing = last3.length === 3 && last3[1].volume > last3[0].volume && last3[2].volume > last3[1].volume

  const confirmed = isSpike && priceAligned
  let confidence = 0
  if (confirmed) {
    confidence = Math.min(1, 0.4 + (volumeRatio - spikeThreshold) * 0.2 + (volumeIncreasing ? 0.2 : 0))
  } else if (isSpike) {
    confidence = 0.2 // Spike but wrong direction
  }

  const direction: PatternDirection = signalDirection === 'long' ? 'bullish' : 'bearish'

  return {
    detected: confirmed,
    type: confirmed ? direction : 'neutral',
    confidence,
    metadata: {
      volumeRatio: Math.round(volumeRatio * 100) / 100,
      isSpike,
      priceAligned,
      volumeIncreasing,
      avgVolume: Math.round(avgVolume),
      currentVolume: Math.round(currentVolume),
    },
  }
}

// ─── Pattern 5: Engulfing Pattern ────────────────────────────────────────────

/**
 * Detects bullish and bearish engulfing candlestick patterns.
 * Bullish engulfing: bearish candle followed by larger bullish candle that fully engulfs it.
 * Bearish engulfing: bullish candle followed by larger bearish candle that fully engulfs it.
 * Stronger signal when occurring at S/R levels.
 */
export function detectEngulfingPattern(
  candles: OHLCVCandle[],
  srLevels?: SRLevel[],
  proximityPct: number = 0.01
): PatternResult {
  if (candles.length < 3) {
    return { detected: false, type: 'neutral', confidence: 0, metadata: {} }
  }

  const prev = candles[candles.length - 2]
  const curr = candles[candles.length - 1]

  const prevBody = Math.abs(prev.close - prev.open)
  const currBody = Math.abs(curr.close - curr.open)
  const prevBearish = prev.close < prev.open
  const prevBullish = prev.close > prev.open
  const currBearish = curr.close < curr.open
  const currBullish = curr.close > curr.open

  // Minimum body size filter (avoid doji-like candles)
  const avgPrice = (curr.high + curr.low) / 2
  const minBodyPct = 0.001 // 0.1% of price
  if (prevBody < avgPrice * minBodyPct || currBody < avgPrice * minBodyPct) {
    return { detected: false, type: 'neutral', confidence: 0, metadata: { reason: 'body_too_small' } }
  }

  let detected = false
  let type: PatternDirection = 'neutral'
  let baseConfidence = 0

  // Bullish engulfing
  if (prevBearish && currBullish && curr.open <= prev.close && curr.close >= prev.open) {
    detected = true
    type = 'bullish'
    baseConfidence = 0.4 + Math.min(0.3, (currBody / prevBody - 1) * 0.15)
  }

  // Bearish engulfing
  if (prevBullish && currBearish && curr.open >= prev.close && curr.close <= prev.open) {
    detected = true
    type = 'bearish'
    baseConfidence = 0.4 + Math.min(0.3, (currBody / prevBody - 1) * 0.15)
  }

  if (!detected) {
    return { detected: false, type: 'neutral', confidence: 0, metadata: {} }
  }

  // Boost confidence if at S/R level
  let atSRLevel = false
  if (srLevels && srLevels.length > 0) {
    for (const level of srLevels) {
      const distance = Math.abs(curr.close - level.price) / level.price
      if (distance <= proximityPct) {
        atSRLevel = true
        baseConfidence += 0.15 * level.strength
        break
      }
    }
  }

  return {
    detected: true,
    type,
    confidence: Math.min(1, baseConfidence),
    metadata: {
      pattern: type === 'bullish' ? 'bullish_engulfing' : 'bearish_engulfing',
      prevBodySize: prevBody,
      currBodySize: currBody,
      bodyRatio: Math.round((currBody / prevBody) * 100) / 100,
      atSRLevel,
    },
  }
}
