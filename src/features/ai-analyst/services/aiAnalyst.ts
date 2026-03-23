'use server'

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { getCandles } from '@/features/market-data/services/marketDataService'
import type { SupabaseClient } from '@supabase/supabase-js'
import { calculateEMA, calculateMACD, calculateRSI, calculateBollingerBands } from '@/features/indicators/services/indicatorEngine'
import { MarketAnalysisSchema, StrategyProposalSchema } from '../types'
import type { MarketAnalysis, StrategyProposal, AnalysisContext } from '../types'
import type { Timeframe } from '@/features/market-data/types'

/**
 * AI Provider routing: Google AI > OpenRouter > OpenAI
 * Configure with env vars: GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY
 */
function getModelInstance(): LanguageModel {
  const modelId = process.env.AI_MODEL || 'gemini-2.5-flash'

  // Priority 1: Google AI (Gemini direct)
  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({
      apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    })
    return google(modelId)
  }

  // Priority 2: OpenRouter (multi-model gateway)
  if (process.env.OPENROUTER_API_KEY) {
    const openrouter = createOpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
    return openrouter(process.env.AI_MODEL || 'google/gemini-2.5-flash')
  }

  // Priority 3: OpenAI direct
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
    return openai(process.env.AI_MODEL || 'gpt-4o-mini')
  }

  throw new Error(
    'No AI API key configured. Set one of: GOOGLE_GENERATIVE_AI_API_KEY, OPENROUTER_API_KEY, or OPENAI_API_KEY'
  )
}

/**
 * Build analysis context from raw candle data + indicators.
 */
export async function buildAnalysisContext(
  symbol: string,
  timeframe: string,
  options?: { client?: SupabaseClient }
): Promise<AnalysisContext> {
  const endDate = new Date().toISOString()
  const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()

  const candles = await getCandles({
    symbol,
    timeframe: timeframe as Timeframe,
    startDate,
    endDate,
  }, { client: options?.client })

  if (candles.length < 50) {
    throw new Error(`Insufficient data: ${candles.length} candles (need 50+). Ingest data first.`)
  }

  // Calculate indicators
  const emaFast = calculateEMA(candles, 9)
  const emaSlow = calculateEMA(candles, 21)
  const macd = calculateMACD(candles, 12, 26, 9)
  const rsi = calculateRSI(candles, 14)
  const bb = calculateBollingerBands(candles, 20, 2)

  const lastCandle = candles[candles.length - 1]
  const prevCandle = candles.length > 1 ? candles[candles.length - 2] : lastCandle
  const lastEmaFast = emaFast[emaFast.length - 1]?.value ?? lastCandle.close
  const lastEmaSlow = emaSlow[emaSlow.length - 1]?.value ?? lastCandle.close
  const lastMacd = macd[macd.length - 1]
  const prevMacd = macd.length > 1 ? macd[macd.length - 2] : lastMacd
  const lastRsi = rsi[rsi.length - 1]?.value ?? 50
  const lastBb = bb[bb.length - 1]

  // Volume analysis
  const recentVolumes = candles.slice(-20).map((c) => c.volume)
  const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length

  // Price change
  const priceChange = ((lastCandle.close - prevCandle.close) / prevCandle.close) * 100

  // EMA alignment
  let emaAlignment = 'neutral'
  if (lastEmaFast > lastEmaSlow) emaAlignment = 'bullish'
  if (lastEmaFast < lastEmaSlow) emaAlignment = 'bearish'

  // MACD crossing
  let macdCrossing = 'neutral'
  if (lastMacd && prevMacd) {
    if (prevMacd.histogram <= 0 && lastMacd.histogram > 0) macdCrossing = 'bullish_cross'
    else if (prevMacd.histogram >= 0 && lastMacd.histogram < 0) macdCrossing = 'bearish_cross'
    else if (lastMacd.histogram > 0) macdCrossing = 'bullish'
    else macdCrossing = 'bearish'
  }

  // BB position
  let bbPosition = 'middle'
  if (lastBb) {
    const range = lastBb.upper - lastBb.lower
    if (range > 0) {
      const pos = (lastCandle.close - lastBb.lower) / range
      if (pos > 0.8) bbPosition = 'upper_band'
      else if (pos < 0.2) bbPosition = 'lower_band'
    }
  }

  return {
    symbol,
    timeframe,
    lastPrice: lastCandle.close,
    priceChange24h: priceChange,
    emaFastValue: lastEmaFast,
    emaSlowValue: lastEmaSlow,
    emaAlignment,
    rsiValue: lastRsi,
    macdHistogram: lastMacd?.histogram ?? 0,
    macdCrossing,
    bbUpper: lastBb?.upper ?? 0,
    bbLower: lastBb?.lower ?? 0,
    bbWidth: lastBb?.bandwidth ?? 0,
    bbPosition,
    avgVolume,
    lastVolume: lastCandle.volume,
    volumeRatio: avgVolume > 0 ? lastCandle.volume / avgVolume : 1,
    candleCount: candles.length,
  }
}

/**
 * AI analyzes market conditions based on indicator context.
 * Optional paperFeedback provides context from past paper trading performance.
 */
export async function analyzeMarket(context: AnalysisContext, paperFeedback?: string): Promise<MarketAnalysis> {
  const model = getModelInstance()

  const prompt = `You are a quantitative trading analyst. Analyze these market conditions and provide a structured analysis.

MARKET DATA for ${context.symbol} (${context.timeframe}):
- Last Price: $${context.lastPrice.toFixed(2)}
- Price Change: ${context.priceChange24h.toFixed(2)}%
- Data Points: ${context.candleCount} candles

INDICATORS:
- EMA(9): ${context.emaFastValue.toFixed(2)} | EMA(21): ${context.emaSlowValue.toFixed(2)} | Alignment: ${context.emaAlignment}
- RSI(14): ${context.rsiValue.toFixed(2)}
- MACD Histogram: ${context.macdHistogram.toFixed(4)} | Signal: ${context.macdCrossing}
- Bollinger Bands: Upper=${context.bbUpper.toFixed(2)} Lower=${context.bbLower.toFixed(2)} Width=${context.bbWidth.toFixed(4)} Position=${context.bbPosition}
- Volume: Last=${context.lastVolume.toFixed(0)} Avg=${context.avgVolume.toFixed(0)} Ratio=${context.volumeRatio.toFixed(2)}x

Respond with ONLY valid JSON matching this exact structure:
{
  "trend": { "direction": "bullish|bearish|neutral", "strength": "strong|moderate|weak", "description": "..." },
  "momentum": { "rsiZone": "overbought|neutral|oversold", "macdSignal": "bullish_cross|bearish_cross|converging|diverging|neutral", "description": "..." },
  "volatility": { "state": "squeeze|expanding|normal", "bbWidth": <number>, "description": "..." },
  "volumeAnalysis": "...",
  "overallBias": "strong_buy|buy|neutral|sell|strong_sell",
  "confidence": <0-1>,
  "reasoning": "..."
}

Be precise and data-driven. No speculation, only what indicators show.${paperFeedback ? `\n\nPAPER TRADING FEEDBACK (use to calibrate your analysis):\n${paperFeedback}` : ''}`

  const { text } = await generateText({
    model,
    prompt,
    temperature: 0.3,
  })

  // Parse and validate with Zod (ai-engine pattern: generateText + JSON.parse + Zod)
  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const parsed = JSON.parse(cleaned)
  return MarketAnalysisSchema.parse(parsed)
}

/**
 * AI proposes strategy parameters based on market analysis.
 */
export async function proposeStrategy(
  context: AnalysisContext,
  analysis: MarketAnalysis,
  paperFeedback?: string
): Promise<StrategyProposal> {
  const model = getModelInstance()

  const prompt = `You are a quantitative strategy designer. Based on this market analysis, propose optimal strategy parameters.

MARKET: ${context.symbol} (${context.timeframe})
ANALYSIS:
- Trend: ${analysis.trend.direction} (${analysis.trend.strength})
- Momentum: RSI=${context.rsiValue.toFixed(1)} zone=${analysis.momentum.rsiZone}, MACD=${analysis.momentum.macdSignal}
- Volatility: ${analysis.volatility.state} (BB width: ${analysis.volatility.bbWidth.toFixed(4)})
- Bias: ${analysis.overallBias} (confidence: ${(analysis.confidence * 100).toFixed(0)}%)

CONSTRAINTS:
- Max 7 key parameters (avoid overfitting)
- Stop loss: 0.005 to 0.10 (as decimal, e.g. 0.03 = 3%)
- Take profit: 0.01 to 0.20 (as decimal, e.g. 0.05 = 5%)
- EMA fast: 3-50, EMA slow: 10-200
- RSI period: 5-30, overbought: 60-90, oversold: 10-40
- MACD fast: 5-20, slow: 15-50, signal: 5-15
- BB period: 10-30, std dev: 1-3
- Parameters must be appropriate for the detected market regime${paperFeedback ? `\n\nPAPER TRADING PERFORMANCE (favor combos that worked, avoid those that failed):\n${paperFeedback}` : ''}

Respond with ONLY valid JSON:
{
  "name": "descriptive strategy name",
  "description": "1-2 sentence description of the strategy logic",
  "parameters": {
    "ema_fast": <int>, "ema_slow": <int>,
    "rsi_period": <int>, "rsi_overbought": <number>, "rsi_oversold": <number>,
    "macd_fast": <int>, "macd_slow": <int>, "macd_signal": <int>,
    "bb_period": <int>, "bb_std_dev": <number>,
    "stop_loss_pct": <decimal 0.005-0.10>, "take_profit_pct": <decimal 0.01-0.20>
  },
  "reasoning": "explain WHY these specific values based on the analysis",
  "riskLevel": "conservative|moderate|aggressive",
  "suitableTimeframes": ["1h", "4h", ...]
}`

  const { text } = await generateText({
    model,
    prompt,
    temperature: 0.4,
  })

  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const parsed = JSON.parse(cleaned)
  return StrategyProposalSchema.parse(parsed)
}
