import type { OHLCVCandle, Timeframe } from '@/features/market-data/types'
import type { Opportunity, OpportunityScore, ScanResult, ScannerConfig } from '../types'
import { DEFAULT_SCANNER_CONFIG } from '../types'
import {
  calculateEMA, calculateBollingerBands,
  calculateATR, calculateADX, detectRegime
} from '@/features/indicators/services/indicatorEngine'
import {
  precomputeIndicators,
  buildContext,
  generateAdaptiveComposite,
} from '@/features/paper-trading/services/signalRegistry'
import { runBacktest } from '@/features/backtesting/services/backtestEngine'
import type { StrategyParameters } from '@/types/database'
import { DEFAULT_STRATEGY_PARAMS } from '@/types/database'

/**
 * Escanea un par + timeframe usando el sistema completo de 7 senales.
 * Retorna null si no hay oportunidad (sin senal, mercado no apto, etc.)
 */
export function scanPair(
  candles: OHLCVCandle[],
  symbol: string,
  timeframe: Timeframe,
  params: StrategyParameters = DEFAULT_STRATEGY_PARAMS
): Opportunity | null {
  if (candles.length < 100) return null

  // Pre-compute all indicators via signalRegistry (shared with paper trading)
  const indicators = precomputeIndicators(candles, params)

  // Get last candle index
  const lastIdx = candles.length - 1
  const lastCandle = candles[lastIdx]

  // Get prev EMA values for context (needed by buildContext)
  const prevCandle = candles[lastIdx - 1]
  const prevEmaFast = indicators.emaFastMap.get(prevCandle.timestamp) ?? 0
  const prevEmaSlow = indicators.emaSlowMap.get(prevCandle.timestamp) ?? 0

  // Build signal context for the last candle
  const ctx = buildContext(candles, lastIdx, params, indicators, prevEmaFast, prevEmaSlow)
  if (!ctx) return null

  // Detect regime
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)
  const regime = detectRegime(candles, adx, atr, emaFast, emaSlow)

  // Skip choppy and volatile markets
  if (regime.regime === 'choppy' || regime.regime === 'volatile') return null

  // Add timeframe to context for timeframe-aware signals (e.g. RSI divergence)
  ctx.timeframe = timeframe

  // Generate composite signal from all 7 signal systems (regime-adaptive weights)
  const composite = generateAdaptiveComposite(ctx)

  // No signal — skip
  if (composite.direction === 'neutral') return null

  const signal: 'buy' | 'sell' = composite.direction === 'long' ? 'buy' : 'sell'

  // ATR-based stops using strategy params (not hardcoded)
  const currentATR = ctx.atr
  const currentPrice = ctx.price
  const slMultiplier = params.stop_loss_pct
  const tpMultiplier = params.take_profit_pct
  const stopDistance = currentATR * slMultiplier
  const profitDistance = currentATR * tpMultiplier

  const stopLoss = signal === 'buy' ? currentPrice - stopDistance : currentPrice + stopDistance
  const takeProfit = signal === 'buy' ? currentPrice + profitDistance : currentPrice - profitDistance
  const riskRewardRatio = profitDistance / stopDistance

  // Calculate BB position (0 = at lower band, 1 = at upper band)
  const currentBB = ctx.bb
  const bbPosition = currentBB
    ? (currentBB.upper - currentBB.lower) === 0
      ? 0.5
      : (currentPrice - currentBB.lower) / (currentBB.upper - currentBB.lower)
    : 0.5

  // Calculate opportunity score (now incorporating composite confidence)
  const currentADX = ctx.adx
  const currentRSI = ctx.rsi
  const currentMACD = ctx.macd
  const atrAvg = atr.slice(-50).reduce((s, a) => s + a.value, 0) / Math.min(50, atr.length)

  const score = calculateOpportunityScore({
    adx: currentADX?.adx ?? 0,
    emaFast: ctx.emaFast,
    emaSlow: ctx.emaSlow,
    rsi: currentRSI,
    macdHistogram: currentMACD.histogram,
    atr: currentATR,
    atrAvg,
    volume: lastCandle.volume,
    volumeAvg: candles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, candles.length),
    bbPosition,
    riskRewardRatio,
    signal,
    regime,
    compositeConfidence: composite.totalConfidence,
  })

  // Quick backtest on recent data (last 200 candles)
  let quickBacktest: Opportunity['quickBacktest'] = undefined
  const recentCandles = candles.slice(-200)
  if (recentCandles.length >= 100) {
    const result = runBacktest(recentCandles, params, 10000)
    if (result.metrics.totalTrades > 0) {
      quickBacktest = {
        metrics: result.metrics,
        sampleSize: recentCandles.length,
      }
    }
  }

  return {
    symbol,
    timeframe,
    signal,
    price: currentPrice,
    score,
    regime,
    stopLoss,
    takeProfit,
    riskRewardRatio,
    atr: currentATR,
    compositeConfidence: composite.totalConfidence,
    activeSignals: composite.activeSystems,
    indicators: {
      emaFast: ctx.emaFast,
      emaSlow: ctx.emaSlow,
      rsi: currentRSI,
      macdHistogram: currentMACD.histogram,
      adx: currentADX?.adx ?? 0,
      bbPosition,
    },
    quickBacktest,
    timestamp: lastCandle.timestamp,
  }
}

/**
 * Score de oportunidad (0-100).
 * Ponderacion: trend 25%, momentum 20%, volatility 15%, volume 10%, R:R 10%, confidence 20%
 */
function calculateOpportunityScore(data: {
  adx: number
  emaFast: number
  emaSlow: number
  rsi: number
  macdHistogram: number
  atr: number
  atrAvg: number
  volume: number
  volumeAvg: number
  bbPosition: number
  riskRewardRatio: number
  signal: 'buy' | 'sell'
  regime: { regime: string; adx: number }
  compositeConfidence: number
}): OpportunityScore {
  // Trend score (0-100): ADX strength + EMA separation
  let trend = 0
  if (data.adx > 40) trend = 100
  else if (data.adx > 30) trend = 80
  else if (data.adx > 25) trend = 60
  else if (data.adx > 20) trend = 40
  else trend = 20

  const emaSpread = Math.abs(data.emaFast - data.emaSlow) / data.emaSlow * 100
  if (emaSpread > 1) trend = Math.min(100, trend + 10)

  // Momentum score (0-100): RSI sweet spot + MACD strength
  let momentum = 0
  if (data.signal === 'buy') {
    if (data.rsi >= 40 && data.rsi <= 60) momentum = 80
    else if (data.rsi >= 30 && data.rsi < 40) momentum = 60
    else if (data.rsi > 60 && data.rsi <= 70) momentum = 50
    else momentum = 20
    if (data.macdHistogram > 0) momentum = Math.min(100, momentum + 20)
  } else {
    if (data.rsi >= 40 && data.rsi <= 60) momentum = 80
    else if (data.rsi > 60 && data.rsi <= 70) momentum = 60
    else if (data.rsi >= 30 && data.rsi < 40) momentum = 50
    else momentum = 20
    if (data.macdHistogram < 0) momentum = Math.min(100, momentum + 20)
  }

  // Volatility score (0-100): Goldilocks zone
  let volatility = 0
  const atrRatio = data.atrAvg === 0 ? 1 : data.atr / data.atrAvg
  if (atrRatio >= 0.8 && atrRatio <= 1.5) volatility = 100
  else if (atrRatio >= 0.5 && atrRatio < 0.8) volatility = 60
  else if (atrRatio > 1.5 && atrRatio <= 2.0) volatility = 50
  else volatility = 20

  // Volume score (0-100): Above average volume = confirmation
  let volume = 0
  const volRatio = data.volumeAvg === 0 ? 1 : data.volume / data.volumeAvg
  if (volRatio > 2.0) volume = 100
  else if (volRatio > 1.5) volume = 80
  else if (volRatio > 1.0) volume = 60
  else if (volRatio > 0.7) volume = 40
  else volume = 20

  // Risk:Reward score (0-100)
  let riskReward = 0
  if (data.riskRewardRatio >= 3.0) riskReward = 100
  else if (data.riskRewardRatio >= 2.5) riskReward = 80
  else if (data.riskRewardRatio >= 2.0) riskReward = 60
  else if (data.riskRewardRatio >= 1.5) riskReward = 40
  else riskReward = 20

  // Weighted total (now includes composite confidence as 20% weight)
  const confidenceScore = Math.round(data.compositeConfidence * 100)
  const total = Math.round(
    trend * 0.25 +
    momentum * 0.20 +
    volatility * 0.15 +
    volume * 0.10 +
    riskReward * 0.10 +
    confidenceScore * 0.20
  )

  return { trend, momentum, volatility, volume, riskReward, total }
}

/**
 * Escanea multiples pares x timeframes.
 */
export async function scanMarket(
  getCandles: (symbol: string, timeframe: Timeframe) => Promise<OHLCVCandle[]>,
  config: Partial<ScannerConfig> = {},
  params: StrategyParameters = DEFAULT_STRATEGY_PARAMS
): Promise<ScanResult> {
  const cfg = { ...DEFAULT_SCANNER_CONFIG, ...config }
  const startTime = Date.now()
  const opportunities: Opportunity[] = []

  for (const symbol of cfg.pairs) {
    for (const timeframe of cfg.timeframes) {
      try {
        const candles = await getCandles(symbol, timeframe)
        if (candles.length < 100) continue

        const opportunity = scanPair(candles, symbol, timeframe, params)
        if (opportunity && opportunity.score.total >= cfg.minScore) {
          opportunities.push(opportunity)
        }
      } catch {
        continue
      }
    }
  }

  opportunities.sort((a, b) => b.score.total - a.score.total)

  return {
    opportunities: opportunities.slice(0, cfg.maxResults),
    scannedPairs: cfg.pairs.length,
    scannedTimeframes: cfg.timeframes.length,
    scanDuration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }
}
