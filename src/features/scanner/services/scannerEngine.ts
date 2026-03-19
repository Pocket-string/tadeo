import type { OHLCVCandle, Timeframe } from '@/features/market-data/types'
import type { Opportunity, OpportunityScore, ScanResult, ScannerConfig } from '../types'
import { DEFAULT_SCANNER_CONFIG } from '../types'
import {
  calculateEMA, calculateMACD, calculateRSI, calculateBollingerBands,
  calculateATR, calculateADX, detectRegime
} from '@/features/indicators/services/indicatorEngine'
import { runBacktest } from '@/features/backtesting/services/backtestEngine'
import type { StrategyParameters } from '@/types/database'
import { DEFAULT_STRATEGY_PARAMS } from '@/types/database'

/**
 * Escanea un par + timeframe y genera oportunidad si hay señal válida.
 * Retorna null si no hay oportunidad (sin señal, mercado no apto, etc.)
 */
export function scanPair(
  candles: OHLCVCandle[],
  symbol: string,
  timeframe: Timeframe,
  params: StrategyParameters = DEFAULT_STRATEGY_PARAMS
): Opportunity | null {
  if (candles.length < 100) return null // Need minimum data

  // Calculate all indicators
  const emaFast = calculateEMA(candles, params.ema_fast)
  const emaSlow = calculateEMA(candles, params.ema_slow)
  const macd = calculateMACD(candles, params.macd_fast, params.macd_slow, params.macd_signal)
  const rsi = calculateRSI(candles, params.rsi_period)
  const bb = calculateBollingerBands(candles, params.bb_period, params.bb_std_dev)
  const atr = calculateATR(candles, 14)
  const adx = calculateADX(candles, 14)

  // Need all indicators available for last candle
  if (emaFast.length < 2 || emaSlow.length < 2 || macd.length < 1 ||
      rsi.length < 1 || bb.length < 1 || atr.length < 1) return null

  // Detect regime
  const regime = detectRegime(candles, adx, atr, emaFast, emaSlow)

  // Skip choppy and volatile markets
  if (regime.regime === 'choppy' || regime.regime === 'volatile') return null

  // Get latest indicator values
  const currentEmaFast = emaFast[emaFast.length - 1].value
  const prevEmaFast = emaFast[emaFast.length - 2].value
  const currentEmaSlow = emaSlow[emaSlow.length - 1].value
  const prevEmaSlow = emaSlow[emaSlow.length - 2].value
  const currentMACD = macd[macd.length - 1]
  const currentRSI = rsi[rsi.length - 1].value
  const currentBB = bb[bb.length - 1]
  const currentATR = atr[atr.length - 1].value
  const currentADX = adx.length > 0 ? adx[adx.length - 1] : null
  const currentPrice = candles[candles.length - 1].close

  // Check for EMA cross signal
  const emaCrossUp = prevEmaFast <= prevEmaSlow && currentEmaFast > currentEmaSlow
  const emaCrossDown = prevEmaFast >= prevEmaSlow && currentEmaFast < currentEmaSlow

  let signal: 'buy' | 'sell' | null = null

  if (emaCrossUp) {
    let confluence = 0
    if (currentMACD.histogram > 0) confluence++
    if (currentRSI < params.rsi_overbought) confluence++
    if (confluence >= 1) signal = 'buy'
  }

  if (emaCrossDown) {
    let confluence = 0
    if (currentMACD.histogram < 0) confluence++
    if (currentRSI > params.rsi_oversold) confluence++
    if (confluence >= 1) signal = 'sell'
  }

  // Also check for strong momentum entries (no cross required if ADX > 30)
  if (!signal && currentADX && currentADX.adx > 30) {
    // Strong trend + RSI + MACD alignment
    if (currentEmaFast > currentEmaSlow && currentMACD.histogram > 0 && currentRSI > 50 && currentRSI < params.rsi_overbought) {
      signal = 'buy'
    }
    if (currentEmaFast < currentEmaSlow && currentMACD.histogram < 0 && currentRSI < 50 && currentRSI > params.rsi_oversold) {
      signal = 'sell'
    }
  }

  if (!signal) return null

  // Calculate ATR-based stops
  const slMultiplier = 1.5
  const tpMultiplier = 2.5
  const stopDistance = currentATR * slMultiplier
  const profitDistance = currentATR * tpMultiplier

  const stopLoss = signal === 'buy' ? currentPrice - stopDistance : currentPrice + stopDistance
  const takeProfit = signal === 'buy' ? currentPrice + profitDistance : currentPrice - profitDistance
  const riskRewardRatio = profitDistance / stopDistance

  // Calculate BB position (0 = at lower band, 1 = at upper band)
  const bbPosition = currentBB.bandwidth === 0 ? 0.5 :
    (currentPrice - currentBB.lower) / (currentBB.upper - currentBB.lower)

  // Calculate opportunity score
  const score = calculateOpportunityScore({
    adx: currentADX?.adx ?? 0,
    emaFast: currentEmaFast,
    emaSlow: currentEmaSlow,
    rsi: currentRSI,
    macdHistogram: currentMACD.histogram,
    atr: currentATR,
    atrAvg: atr.slice(-50).reduce((s, a) => s + a.value, 0) / Math.min(50, atr.length),
    volume: candles[candles.length - 1].volume,
    volumeAvg: candles.slice(-20).reduce((s, c) => s + c.volume, 0) / Math.min(20, candles.length),
    bbPosition,
    riskRewardRatio,
    signal,
    regime,
  })

  // Quick backtest on recent data (last 200 candles) for validation
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
    indicators: {
      emaFast: currentEmaFast,
      emaSlow: currentEmaSlow,
      rsi: currentRSI,
      macdHistogram: currentMACD.histogram,
      adx: currentADX?.adx ?? 0,
      bbPosition,
    },
    quickBacktest,
    timestamp: candles[candles.length - 1].timestamp,
  }
}

/**
 * Score de oportunidad (0-100).
 * Ponderación: trend 30%, momentum 25%, volatility 20%, volume 15%, R:R 10%
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
}): OpportunityScore {
  // Trend score (0-100): ADX strength + EMA separation
  let trend = 0
  if (data.adx > 40) trend = 100
  else if (data.adx > 30) trend = 80
  else if (data.adx > 25) trend = 60
  else if (data.adx > 20) trend = 40
  else trend = 20

  // Bonus for EMA alignment with signal
  const emaSpread = Math.abs(data.emaFast - data.emaSlow) / data.emaSlow * 100
  if (emaSpread > 1) trend = Math.min(100, trend + 10)

  // Momentum score (0-100): RSI sweet spot + MACD strength
  let momentum = 0
  if (data.signal === 'buy') {
    // Best buy: RSI 40-60 (room to grow, not oversold bounce)
    if (data.rsi >= 40 && data.rsi <= 60) momentum = 80
    else if (data.rsi >= 30 && data.rsi < 40) momentum = 60
    else if (data.rsi > 60 && data.rsi <= 70) momentum = 50
    else momentum = 20
    if (data.macdHistogram > 0) momentum = Math.min(100, momentum + 20)
  } else {
    // Best sell: RSI 40-60 (room to fall)
    if (data.rsi >= 40 && data.rsi <= 60) momentum = 80
    else if (data.rsi > 60 && data.rsi <= 70) momentum = 60
    else if (data.rsi >= 30 && data.rsi < 40) momentum = 50
    else momentum = 20
    if (data.macdHistogram < 0) momentum = Math.min(100, momentum + 20)
  }

  // Volatility score (0-100): Goldilocks zone (not too high, not too low)
  let volatility = 0
  const atrRatio = data.atrAvg === 0 ? 1 : data.atr / data.atrAvg
  if (atrRatio >= 0.8 && atrRatio <= 1.5) volatility = 100 // Sweet spot
  else if (atrRatio >= 0.5 && atrRatio < 0.8) volatility = 60 // Low vol
  else if (atrRatio > 1.5 && atrRatio <= 2.0) volatility = 50 // High vol
  else volatility = 20 // Extreme

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

  // Weighted total
  const total = Math.round(
    trend * 0.30 +
    momentum * 0.25 +
    volatility * 0.20 +
    volume * 0.15 +
    riskReward * 0.10
  )

  return { trend, momentum, volatility, volume, riskReward, total }
}

/**
 * Escanea múltiples pares × timeframes.
 * Requiere función para obtener candles de cada par.
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
        // Skip pair/timeframe if fetch fails
        continue
      }
    }
  }

  // Sort by score descending
  opportunities.sort((a, b) => b.score.total - a.score.total)

  return {
    opportunities: opportunities.slice(0, cfg.maxResults),
    scannedPairs: cfg.pairs.length,
    scannedTimeframes: cfg.timeframes.length,
    scanDuration: Date.now() - startTime,
    timestamp: new Date().toISOString(),
  }
}
