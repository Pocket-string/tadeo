import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { AnalysisContext } from '@/features/ai-analyst/types'
import { getAllSignalSystems } from '@/features/paper-trading/services/signalRegistry'
import { HypothesisResponseSchema, type StrategyHypothesis } from '../types'
import type { StrategyParameters } from '@/types/database'

function getModel(): LanguageModel {
  const modelId = process.env.AI_MODEL || 'gemini-2.5-flash'

  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })
    return google(modelId)
  }
  if (process.env.OPENROUTER_API_KEY) {
    const openrouter = createOpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
    return openrouter(process.env.AI_MODEL || 'google/gemini-2.5-flash')
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
    return openai(process.env.AI_MODEL || 'gpt-4o-mini')
  }
  throw new Error('No AI API key configured.')
}

/**
 * AI generates strategy hypotheses based on market context.
 * Each hypothesis is a combination of signal systems + parameter ranges.
 */
export async function generateHypotheses(
  context: AnalysisContext,
  numHypotheses: number = 3
): Promise<StrategyHypothesis[]> {
  const model = getModel()
  const systems = getAllSignalSystems()
  const systemList = systems.map(s => `- ${s.id}: ${s.name}`).join('\n')

  const prompt = `You are a quantitative strategy researcher discovering new trading strategies.

MARKET CONTEXT for ${context.symbol} (${context.timeframe}):
- Price: $${context.lastPrice.toFixed(2)} | Change: ${context.priceChange24h.toFixed(2)}%
- EMA(fast): ${context.emaFastValue.toFixed(2)} | EMA(slow): ${context.emaSlowValue.toFixed(2)} | Alignment: ${context.emaAlignment}
- RSI(14): ${context.rsiValue.toFixed(1)} | MACD: ${context.macdCrossing}
- BB Position: ${context.bbPosition} | Width: ${context.bbWidth.toFixed(4)}
- Volume Ratio: ${context.volumeRatio.toFixed(2)}x

AVAILABLE SIGNAL SYSTEMS (can combine any subset with weights):
${systemList}

TASK: Generate ${numHypotheses} diverse strategy hypotheses. Each should use a DIFFERENT combination of signal systems.

RULES:
- Each hypothesis must enable 2-5 signal systems
- Weights range from 0.3 to 2.0 (higher = more influence)
- stop_loss_pct and take_profit_pct are ATR multipliers (0.5-3.0 for SL, 1.0-10.0 for TP)
- ema_fast MUST be less than ema_slow
- macd_fast MUST be less than macd_slow
- Diversify: don't repeat the same system combination
- Consider what works for ${context.timeframe} timeframe specifically
- Pattern-based systems (double-pattern, rsi-divergence, engulfing-sr) capture market psychology
- Volume confirmation strengthens any signal but shouldn't be used alone

Respond with ONLY valid JSON:
{
  "hypotheses": [
    {
      "signalSystems": [
        { "id": "system-id", "weight": 1.0, "enabled": true },
        { "id": "other-system", "weight": 0, "enabled": false }
      ],
      "params": {
        "ema_fast": 9, "ema_slow": 21,
        "rsi_period": 14, "rsi_overbought": 70, "rsi_oversold": 30,
        "macd_fast": 12, "macd_slow": 26, "macd_signal": 9,
        "bb_period": 20, "bb_std_dev": 2,
        "stop_loss_pct": 1.0, "take_profit_pct": 2.5
      },
      "rationale": "Why this combination should work for this market"
    }
  ]
}

Include ALL 7 signal systems in each hypothesis's signalSystems array (enabled: false for unused ones).`

  const { text } = await generateText({
    model,
    prompt,
    temperature: 0.7,
  })

  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const parsed = JSON.parse(cleaned)
  const validated = HypothesisResponseSchema.parse(parsed)

  return validated.hypotheses.map(h => ({
    symbol: context.symbol,
    timeframe: context.timeframe,
    signalConfig: h.signalSystems.map(s => ({
      id: s.id,
      weight: s.weight,
      enabled: s.enabled,
    })),
    baseParams: h.params as StrategyParameters,
    rationale: h.rationale,
  }))
}
