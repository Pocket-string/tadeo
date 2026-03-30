import type { OHLCVCandle } from '@/features/market-data/types'
import type { StrategyParameters } from '@/types/database'
import type { ADXResult, RSIResult } from '@/features/indicators/types'
import {
  calculateEMA,
  calculateMACD,
  calculateRSI,
  calculateBollingerBands,
  calculateATR,
  calculateADX,
} from '@/features/indicators/services/indicatorEngine'
import {
  detectDoubleTopBottom,
  detectRSIDivergence,
  detectSupportResistance,
  detectVolumeConfirmation,
  detectEngulfingPattern,
  type SRLevel,
} from '@/features/indicators/services/patternEngine'

// ─── Core Types ──────────────────────────────────────────────────────────────

export interface SignalOutput {
  signal: 'long' | 'short' | 'neutral'
  confidence: number // 0-1
  metadata: Record<string, unknown>
}

export interface SignalSystem {
  id: string
  name: string
  generate(ctx: SignalContext): SignalOutput
}

export interface CompositeSignal {
  direction: 'long' | 'short' | 'neutral'
  totalConfidence: number
  activeSystems: string[]
  atr: number
}

/** Pre-computed indicator context shared across signal systems */
export interface SignalContext {
  candles: OHLCVCandle[]
  params: StrategyParameters
  currentIndex: number // index of current candle being evaluated
  timeframe?: string // optional — used by signals that behave differently per timeframe
  // Pre-computed indicators (latest values)
  emaFast: number
  emaSlow: number
  prevEmaFast: number
  prevEmaSlow: number
  macd: { macd: number; signal: number; histogram: number }
  rsi: number
  bb: { upper: number; middle: number; lower: number } | null
  atr: number
  adx: ADXResult | null
  price: number
  // Full arrays for pattern detectors
  rsiArray: RSIResult[]
  srLevels: SRLevel[]
}

// ─── Signal System Registry ──────────────────────────────────────────────────

const registry = new Map<string, SignalSystem>()

export function registerSignal(system: SignalSystem): void {
  registry.set(system.id, system)
}

export function getSignalSystem(id: string): SignalSystem | undefined {
  return registry.get(id)
}

export function getAllSignalSystems(): SignalSystem[] {
  return Array.from(registry.values())
}

// ─── Composite Signal Generation ─────────────────────────────────────────────

export interface SignalSystemConfig {
  id: string
  weight: number
  enabled: boolean
}

/**
 * Generate a composite signal from multiple signal systems.
 * Aggregates weighted confidence scores and returns direction + total confidence.
 */
export function generateComposite(
  ctx: SignalContext,
  systemConfigs: SignalSystemConfig[]
): CompositeSignal {
  let longScore = 0
  let shortScore = 0
  let totalWeight = 0
  const activeSystems: string[] = []

  for (const config of systemConfigs) {
    if (!config.enabled) continue

    const system = registry.get(config.id)
    if (!system) continue

    const output = system.generate(ctx)
    if (output.signal === 'neutral') continue

    const weightedConfidence = output.confidence * config.weight
    totalWeight += config.weight

    if (output.signal === 'long') {
      longScore += weightedConfidence
    } else {
      shortScore += weightedConfidence
    }

    activeSystems.push(`${system.id}:${output.signal}(${(output.confidence * 100).toFixed(0)}%)`)
  }

  const normalizer = totalWeight > 0 ? totalWeight : 1
  const normalizedLong = longScore / normalizer
  const normalizedShort = shortScore / normalizer

  // Conflict guard: contradictory signals cancel each other → return neutral
  // Prevents trades like rsi-divergence:LONG(100%) + engulfing-sr:SHORT(70%) from generating a signal
  if (normalizedLong > 0.3 && normalizedShort > 0.3) {
    return { direction: 'neutral', totalConfidence: 0, activeSystems, atr: ctx.atr }
  }

  let direction: 'long' | 'short' | 'neutral' = 'neutral'
  let totalConfidence = 0

  if (normalizedLong > normalizedShort && normalizedLong > 0.45) {
    direction = 'long'
    totalConfidence = normalizedLong
  } else if (normalizedShort > normalizedLong && normalizedShort > 0.45) {
    direction = 'short'
    totalConfidence = normalizedShort
  }

  return { direction, totalConfidence, activeSystems, atr: ctx.atr }
}

// ─── Built-in Signal Systems ─────────────────────────────────────────────────

/** System 1: EMA Crossover + MACD/RSI Confluence */
const emaCrossSystem: SignalSystem = {
  id: 'ema-cross',
  name: 'EMA Crossover + Confluence',
  generate(ctx: SignalContext): SignalOutput {
    // Bullish cross
    if (ctx.prevEmaFast <= ctx.prevEmaSlow && ctx.emaFast > ctx.emaSlow) {
      let conf = 0
      if (ctx.macd.histogram > 0) conf++
      if (ctx.rsi < ctx.params.rsi_overbought) conf++
      if (conf >= 1) {
        return { signal: 'long', confidence: 0.5 + conf * 0.15, metadata: { cross: 'bullish', conf } }
      }
    }
    // Bearish cross
    if (ctx.prevEmaFast >= ctx.prevEmaSlow && ctx.emaFast < ctx.emaSlow) {
      let conf = 0
      if (ctx.macd.histogram < 0) conf++
      if (ctx.rsi > ctx.params.rsi_oversold) conf++
      if (conf >= 1) {
        return { signal: 'short', confidence: 0.5 + conf * 0.15, metadata: { cross: 'bearish', conf } }
      }
    }
    return { signal: 'neutral', confidence: 0, metadata: {} }
  },
}

/** System 2: Bollinger Band Mean-Reversion + RSI Extremes */
const bbMeanRevSystem: SignalSystem = {
  id: 'bb-mean-rev',
  name: 'BB Mean-Reversion + RSI',
  generate(ctx: SignalContext): SignalOutput {
    if (!ctx.bb) return { signal: 'neutral', confidence: 0, metadata: {} }

    if (ctx.price <= ctx.bb.lower && ctx.rsi < ctx.params.rsi_oversold + 5) {
      const depth = (ctx.bb.lower - ctx.price) / ctx.bb.lower
      return { signal: 'long', confidence: 0.5 + Math.min(0.3, depth * 10), metadata: { zone: 'lower_band' } }
    }
    if (ctx.price >= ctx.bb.upper && ctx.rsi > ctx.params.rsi_overbought - 5) {
      const depth = (ctx.price - ctx.bb.upper) / ctx.bb.upper
      return { signal: 'short', confidence: 0.5 + Math.min(0.3, depth * 10), metadata: { zone: 'upper_band' } }
    }
    return { signal: 'neutral', confidence: 0, metadata: {} }
  },
}

/** System 3: ADX Strong Trend Continuation */
const adxTrendSystem: SignalSystem = {
  id: 'adx-trend',
  name: 'ADX Trend Continuation',
  generate(ctx: SignalContext): SignalOutput {
    if (!ctx.adx || ctx.adx.adx <= 30) return { signal: 'neutral', confidence: 0, metadata: {} }

    const adxStrength = Math.min(1, (ctx.adx.adx - 30) / 30)

    // Momentum guard: don't enter if price already moved > 1 ATR in that direction recently
    // This prevents entering late into moves that are about to reverse
    const lookback = Math.min(5, ctx.currentIndex)
    if (lookback > 0 && ctx.atr > 0) {
      const recentHigh = Math.max(...ctx.candles.slice(ctx.currentIndex - lookback, ctx.currentIndex + 1).map(c => c.high))
      const recentLow = Math.min(...ctx.candles.slice(ctx.currentIndex - lookback, ctx.currentIndex + 1).map(c => c.low))
      const recentRange = recentHigh - recentLow

      // Long: skip if price already rallied > 1 ATR (late entry)
      if (ctx.adx.plusDI > ctx.adx.minusDI && (ctx.price - recentLow) > ctx.atr * 1.0) {
        return { signal: 'neutral', confidence: 0, metadata: { skipped: 'late_long_entry' } }
      }
      // Short: skip if price already dropped > 1 ATR (late entry — root cause of 7.1% WR)
      if (ctx.adx.minusDI > ctx.adx.plusDI && (recentHigh - ctx.price) > ctx.atr * 1.0) {
        return { signal: 'neutral', confidence: 0, metadata: { skipped: 'late_short_entry', range: recentRange, atr: ctx.atr } }
      }
    }

    if (ctx.adx.plusDI > ctx.adx.minusDI && ctx.rsi > 40 && ctx.rsi < 65 && ctx.emaFast > ctx.emaSlow) {
      return { signal: 'long', confidence: 0.5 + adxStrength * 0.3, metadata: { adx: ctx.adx.adx, trend: 'up' } }
    }
    if (ctx.adx.minusDI > ctx.adx.plusDI && ctx.rsi < 60 && ctx.rsi > 35 && ctx.emaFast < ctx.emaSlow) {
      return { signal: 'short', confidence: 0.5 + adxStrength * 0.3, metadata: { adx: ctx.adx.adx, trend: 'down' } }
    }
    return { signal: 'neutral', confidence: 0, metadata: {} }
  },
}

/** System 4: Double Top/Bottom Pattern */
const doublePatternSystem: SignalSystem = {
  id: 'double-pattern',
  name: 'Double Top/Bottom',
  generate(ctx: SignalContext): SignalOutput {
    // Increased lookback from 60 to 120 candles (2026-03-24 — 60 candles on 5m = only 5 hours, too noisy)
    const lookback = Math.min(120, ctx.currentIndex + 1)
    const slice = ctx.candles.slice(ctx.currentIndex - lookback + 1, ctx.currentIndex + 1)
    const result = detectDoubleTopBottom(slice, lookback)

    if (!result.detected) return { signal: 'neutral', confidence: 0, metadata: {} }

    // Confirmation filter: require price to move in pattern direction for 2+ candles after detection
    // Without this, we enter immediately on pattern detection and get stopped out by false breakouts
    if (ctx.currentIndex >= 2) {
      const prev1 = ctx.candles[ctx.currentIndex - 1]
      const prev2 = ctx.candles[ctx.currentIndex - 2]
      if (result.type === 'bearish') {
        // For short (double top): require 2 consecutive lower closes as confirmation
        if (!(ctx.price < prev1.close && prev1.close < prev2.close)) {
          return { signal: 'neutral', confidence: 0, metadata: { skipped: 'no_short_confirmation' } }
        }
      } else {
        // For long (double bottom): require 2 consecutive higher closes as confirmation
        if (!(ctx.price > prev1.close && prev1.close > prev2.close)) {
          return { signal: 'neutral', confidence: 0, metadata: { skipped: 'no_long_confirmation' } }
        }
      }
    }

    return {
      signal: result.type === 'bullish' ? 'long' : 'short',
      confidence: result.confidence,
      metadata: result.metadata,
    }
  },
}

/** Timeframes where RSI divergence long signals are unreliable (2026-03-30 Karpathy: 4/5 ADA 1h trades from rsi-div, noisy) */
const SHORT_TIMEFRAMES = new Set(['1m', '3m', '5m', '15m', '30m', '1h'])

/** System 5: RSI Divergence */
const rsiDivergenceSystem: SignalSystem = {
  id: 'rsi-divergence',
  name: 'RSI Divergence',
  generate(ctx: SignalContext): SignalOutput {
    const lookback = Math.min(30, ctx.currentIndex + 1)
    const candleSlice = ctx.candles.slice(ctx.currentIndex - lookback + 1, ctx.currentIndex + 1)
    const rsiSlice = ctx.rsiArray.slice(-lookback)

    if (candleSlice.length < 15 || rsiSlice.length < 15) {
      return { signal: 'neutral', confidence: 0, metadata: {} }
    }

    const result = detectRSIDivergence(candleSlice, rsiSlice, lookback)

    if (!result.detected) return { signal: 'neutral', confidence: 0, metadata: {} }

    // Disable bullish (long) RSI divergence on short timeframes — produces noise, WR 25.8% on 5m/15m
    if (result.type === 'bullish' && ctx.timeframe && SHORT_TIMEFRAMES.has(ctx.timeframe)) {
      return { signal: 'neutral', confidence: 0, metadata: { skipped: 'rsi_div_long_disabled_short_tf' } }
    }

    return {
      signal: result.type === 'bullish' ? 'long' : 'short',
      confidence: result.confidence,
      metadata: result.metadata,
    }
  },
}

/** System 6: Volume Confirmation (boosts existing signals) */
const volumeConfirmSystem: SignalSystem = {
  id: 'volume-confirm',
  name: 'Volume Confirmation',
  generate(ctx: SignalContext): SignalOutput {
    // Check volume for both directions, return the confirmed one
    const longResult = detectVolumeConfirmation(
      ctx.candles.slice(0, ctx.currentIndex + 1),
      'long'
    )
    const shortResult = detectVolumeConfirmation(
      ctx.candles.slice(0, ctx.currentIndex + 1),
      'short'
    )

    if (longResult.detected) {
      return { signal: 'long', confidence: longResult.confidence, metadata: longResult.metadata }
    }
    if (shortResult.detected) {
      return { signal: 'short', confidence: shortResult.confidence, metadata: shortResult.metadata }
    }
    return { signal: 'neutral', confidence: 0, metadata: {} }
  },
}

/** System 7: Engulfing Pattern at S/R */
const engulfingSystem: SignalSystem = {
  id: 'engulfing-sr',
  name: 'Engulfing at S/R',
  generate(ctx: SignalContext): SignalOutput {
    if (ctx.currentIndex < 2) return { signal: 'neutral', confidence: 0, metadata: {} }

    const slice = ctx.candles.slice(0, ctx.currentIndex + 1)
    const result = detectEngulfingPattern(slice, ctx.srLevels)

    if (!result.detected) return { signal: 'neutral', confidence: 0, metadata: {} }
    return {
      signal: result.type === 'bullish' ? 'long' : 'short',
      confidence: result.confidence,
      metadata: result.metadata,
    }
  },
}

// ─── Register all built-in systems ───────────────────────────────────────────

registerSignal(emaCrossSystem)
registerSignal(bbMeanRevSystem)
registerSignal(adxTrendSystem)
registerSignal(doublePatternSystem)
registerSignal(rsiDivergenceSystem)
registerSignal(volumeConfirmSystem)
registerSignal(engulfingSystem)

// ─── Default Configurations ──────────────────────────────────────────────────

/** Legacy config: original 3 systems — adx-trend disabled (2026-03-30 Karpathy: 7.1% WR toxic) */
export const LEGACY_SIGNAL_CONFIG: SignalSystemConfig[] = [
  { id: 'ema-cross', weight: 1, enabled: true },
  { id: 'bb-mean-rev', weight: 1, enabled: true },
  { id: 'adx-trend', weight: 0.3, enabled: false },    // TOXIC: 0W/3L live, disabled
  { id: 'double-pattern', weight: 0, enabled: false },
  { id: 'rsi-divergence', weight: 0, enabled: false },
  { id: 'volume-confirm', weight: 0, enabled: false },
  { id: 'engulfing-sr', weight: 0, enabled: false },
]

/** Full config: all 7 systems with tuned weights (rebalanced 2026-03-30 Karpathy loop — disabled toxic signals) */
export const FULL_SIGNAL_CONFIG: SignalSystemConfig[] = [
  { id: 'ema-cross', weight: 1.2, enabled: true },       // ema-cross:long WR 87.5%
  { id: 'bb-mean-rev', weight: 1.5, enabled: true },     // bb-mean-rev:long 13W/0L — best signal
  { id: 'adx-trend', weight: 0.3, enabled: false },      // adx-trend:short WR 7.1% — TOXIC, 0W/3L live, DISABLED
  { id: 'double-pattern', weight: 0.3, enabled: false },  // double-pattern:short WR 33% — TOXIC, DISABLED
  { id: 'rsi-divergence', weight: 0.3, enabled: false },  // rsi-divergence:long WR 25.8% — TOXIC on 1h+, DISABLED
  { id: 'volume-confirm', weight: 1.0, enabled: true },
  { id: 'engulfing-sr', weight: 1.3, enabled: true },    // engulfing:long WR 100% — raised
]

// ─── Strategy Presets (New Composite Strategies) ────────────────────────────

/** Pattern Confluence: price-action with volume/engulfing emphasis. Rebalanced — reduced toxic signals. */
export const PATTERN_CONFLUENCE_CONFIG: SignalSystemConfig[] = [
  { id: 'ema-cross', weight: 0.2, enabled: false },
  { id: 'bb-mean-rev', weight: 0.3, enabled: false },
  { id: 'adx-trend', weight: 0.2, enabled: false },
  { id: 'double-pattern', weight: 0.8, enabled: true },  // reduced from 1.5 — short side toxic
  { id: 'rsi-divergence', weight: 0.5, enabled: true },  // reduced from 1.3 — long side toxic in short TFs
  { id: 'volume-confirm', weight: 1.2, enabled: true },  // raised — good confirmation signal
  { id: 'engulfing-sr', weight: 1.5, enabled: true },    // raised — engulfing:long WR 100%
]

/** Trend + Momentum: enter on trend confirmed by volume + momentum. 2026-03-30: toxic signals disabled. */
export const TREND_MOMENTUM_CONFIG: SignalSystemConfig[] = [
  { id: 'ema-cross', weight: 1.3, enabled: true },       // raised — ema-cross:long WR 87.5%
  { id: 'bb-mean-rev', weight: 0.3, enabled: false },
  { id: 'adx-trend', weight: 0.3, enabled: false },      // TOXIC: disabled (was 0.6)
  { id: 'double-pattern', weight: 0.3, enabled: false },
  { id: 'rsi-divergence', weight: 0.3, enabled: false },  // TOXIC: disabled (was 0.4)
  { id: 'volume-confirm', weight: 1.0, enabled: true },
  { id: 'engulfing-sr', weight: 1.0, enabled: true },    // enabled for confluence
]

/** Mean Reversion Sniper: BB extremes + S/R + engulfing. Rebalanced — bb-mean-rev dominates. */
export const MEAN_REVERSION_CONFIG: SignalSystemConfig[] = [
  { id: 'ema-cross', weight: 0.2, enabled: false },
  { id: 'bb-mean-rev', weight: 1.5, enabled: true },     // star signal — keep high
  { id: 'adx-trend', weight: 0.2, enabled: false },
  { id: 'double-pattern', weight: 0.5, enabled: false },
  { id: 'rsi-divergence', weight: 0.5, enabled: true },  // reduced from 1.0 — long side toxic
  { id: 'volume-confirm', weight: 0.8, enabled: true },  // raised for confirmation
  { id: 'engulfing-sr', weight: 1.3, enabled: true },
]

/** SOLUSDT/5m optimized: disable toxic signals (adx-trend, double-pattern, rsi-divergence) based on 130 live trades.
 *  Only proven signals: bb-mean-rev (13W/0L), ema-cross (WR 87.5%), volume-confirm, engulfing-sr */
export const SOLUSDT_5M_CONFIG: SignalSystemConfig[] = [
  { id: 'ema-cross', weight: 1.2, enabled: true },
  { id: 'bb-mean-rev', weight: 1.5, enabled: true },
  { id: 'adx-trend', weight: 0.3, enabled: false },
  { id: 'double-pattern', weight: 0.3, enabled: false },
  { id: 'rsi-divergence', weight: 0.3, enabled: false },
  { id: 'volume-confirm', weight: 1.0, enabled: true },
  { id: 'engulfing-sr', weight: 1.3, enabled: true },
]

/** All available strategy presets for UI selection */
export const STRATEGY_PRESETS = {
  legacy: { name: 'Clasica (3 sistemas)', config: LEGACY_SIGNAL_CONFIG, description: 'EMA cross + BB mean-reversion + ADX trend' },
  full: { name: 'Completa (7 sistemas)', config: FULL_SIGNAL_CONFIG, description: 'Todos los sistemas activos con pesos balanceados' },
  patternConfluence: { name: 'Confluencia de Patrones', config: PATTERN_CONFLUENCE_CONFIG, description: 'Price-action puro: doble techo/piso + divergencia RSI + engulfing en S/R' },
  trendMomentum: { name: 'Tendencia + Momentum', config: TREND_MOMENTUM_CONFIG, description: 'Solo entra en tendencias confirmadas por volumen y momentum' },
  meanReversion: { name: 'Reversion a la Media', config: MEAN_REVERSION_CONFIG, description: 'Compra en soporte extremo, vende en resistencia extrema' },
  solusdt5m: { name: 'SOLUSDT/5m Optimizado', config: SOLUSDT_5M_CONFIG, description: 'Solo señales probadas en SOL 5m: bb-mean-rev + ema-cross + engulfing (130 trades de aprendizaje)' },
} as const

// ─── Regime-Adaptive Composite ──────────────────────────────────────────────

/** Trending regime weights (2026-03-30 Karpathy — toxic signals zeroed) */
const TRENDING_WEIGHTS: Record<string, number> = {
  'ema-cross': 1.5, 'bb-mean-rev': 0.5, 'adx-trend': 0,
  'double-pattern': 0, 'rsi-divergence': 0, 'volume-confirm': 0.8, 'engulfing-sr': 1.0,
}

/** Ranging regime weights (2026-03-30 Karpathy — toxic signals zeroed, bb-mean-rev dominates) */
const RANGING_WEIGHTS: Record<string, number> = {
  'ema-cross': 0.3, 'bb-mean-rev': 1.5, 'adx-trend': 0,
  'double-pattern': 0, 'rsi-divergence': 0, 'volume-confirm': 0.8, 'engulfing-sr': 1.2,
}

/**
 * Generate a regime-adaptive composite signal.
 * Automatically adjusts signal weights based on current market regime (ADX).
 */
export function generateAdaptiveComposite(
  ctx: SignalContext,
): CompositeSignal {
  const adxVal = ctx.adx?.adx ?? 0
  const isTrending = adxVal > 25
  const isVolatile = adxVal > 50
  const weights = isTrending ? TRENDING_WEIGHTS : RANGING_WEIGHTS
  const confidenceThreshold = isVolatile ? 0.5 : 0.3

  const allSystems = getAllSignalSystems()
  const adaptiveConfig: SignalSystemConfig[] = allSystems.map(sys => ({
    id: sys.id,
    weight: isVolatile ? (weights[sys.id] ?? 0.5) * 0.5 : (weights[sys.id] ?? 0.5),
    enabled: true,
  }))

  const result = generateComposite(ctx, adaptiveConfig)

  // Apply regime-specific confidence threshold
  if (result.totalConfidence < confidenceThreshold) {
    return { ...result, direction: 'neutral', totalConfidence: 0 }
  }

  return result
}

// ─── Context Builder ─────────────────────────────────────────────────────────

export interface PrecomputedIndicators {
  emaFastMap: Map<string, number>
  emaSlowMap: Map<string, number>
  macdMap: Map<string, { macd: number; signal: number; histogram: number }>
  rsiMap: Map<string, number>
  rsiArray: RSIResult[]
  bbMap: Map<string, { upper: number; middle: number; lower: number }>
  atrMap: Map<string, number>
  adxMap: Map<string, ADXResult>
  srLevels: SRLevel[]
}

/** Pre-compute all indicators for a set of candles */
export function precomputeIndicators(
  candles: OHLCVCandle[],
  params: StrategyParameters
): PrecomputedIndicators {
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const macd = calculateMACD(candles, params.macd_fast, params.macd_slow, params.macd_signal)
  const rsi = calculateRSI(candles, params.rsi_period)
  const bb = calculateBollingerBands(candles, params.bb_period, params.bb_std_dev)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)

  // S/R levels computed once for the full dataset
  const srLevels = detectSupportResistance(candles, Math.min(120, candles.length))

  return {
    emaFastMap: new Map(emaFast.map(e => [e.timestamp, e.value])),
    emaSlowMap: new Map(emaSlow.map(e => [e.timestamp, e.value])),
    macdMap: new Map(macd.map(e => [e.timestamp, { macd: e.macd, signal: e.signal, histogram: e.histogram }])),
    rsiMap: new Map(rsi.map(e => [e.timestamp, e.value])),
    rsiArray: rsi,
    bbMap: new Map(bb.map(e => [e.timestamp, { upper: e.upper, middle: e.middle, lower: e.lower }])),
    atrMap: new Map(atr.map(e => [e.timestamp, e.value])),
    adxMap: new Map(adx.map(e => [e.timestamp, e])),
    srLevels,
  }
}

/** Build a SignalContext for a specific candle index */
export function buildContext(
  candles: OHLCVCandle[],
  index: number,
  params: StrategyParameters,
  indicators: PrecomputedIndicators,
  prevEmaFast: number,
  prevEmaSlow: number
): SignalContext | null {
  const candle = candles[index]
  const ts = candle.timestamp

  const ef = indicators.emaFastMap.get(ts)
  const es = indicators.emaSlowMap.get(ts)
  const m = indicators.macdMap.get(ts)
  const r = indicators.rsiMap.get(ts)
  const atr = indicators.atrMap.get(ts)

  if (ef === undefined || es === undefined || !m || r === undefined || atr === undefined) {
    return null
  }

  return {
    candles,
    params,
    currentIndex: index,
    emaFast: ef,
    emaSlow: es,
    prevEmaFast: prevEmaFast,
    prevEmaSlow: prevEmaSlow,
    macd: m,
    rsi: r,
    bb: indicators.bbMap.get(ts) ?? null,
    atr,
    adx: indicators.adxMap.get(ts) ?? null,
    price: candle.close,
    rsiArray: indicators.rsiArray,
    srLevels: indicators.srLevels,
  }
}
