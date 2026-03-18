'use server'

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { ScientificBacktestOutput, AIBacktestReview, WalkForwardResult } from '../types'
import { z } from 'zod'

const AIReviewSchema = z.object({
  verdict: z.enum(['approve', 'caution', 'reject']),
  confidence: z.number().min(0).max(1),
  summary: z.string(),
  strengths: z.array(z.string()),
  weaknesses: z.array(z.string()),
  overfittingRisk: z.enum(['low', 'medium', 'high']),
  recommendation: z.string(),
})

function getModelInstance(): LanguageModel {
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
 * AI reviews backtest results and provides verdict + recommendations.
 * HUMAN GATE: The AI recommends but the human decides.
 */
export async function reviewBacktest(
  result: ScientificBacktestOutput,
  walkForward?: WalkForwardResult,
  symbol?: string,
  timeframe?: string
): Promise<AIBacktestReview> {
  const model = getModelInstance()
  const is = result.inSample.metrics
  const oos = result.outOfSample.metrics
  const deg = result.degradation

  const prompt = `You are a quantitative trading auditor reviewing backtest results. Be critical and skeptical — false positives in trading are expensive.

BACKTEST RESULTS for ${symbol ?? 'unknown'} (${timeframe ?? 'unknown'}):

IN-SAMPLE (training data, 70%):
- Total Trades: ${is.totalTrades} | Win Rate: ${(is.winRate * 100).toFixed(1)}%
- Net Profit: $${is.netProfit.toFixed(2)} | Sharpe: ${is.sharpeRatio.toFixed(2)}
- t-Statistic: ${is.tStatistic.toFixed(2)} | Max Drawdown: ${(is.maxDrawdown * 100).toFixed(1)}%
- Profit Factor: ${is.profitFactor === Infinity ? 'INF' : is.profitFactor.toFixed(2)}

OUT-OF-SAMPLE (unseen data, 30%):
- Total Trades: ${oos.totalTrades} | Win Rate: ${(oos.winRate * 100).toFixed(1)}%
- Net Profit: $${oos.netProfit.toFixed(2)} | Sharpe: ${oos.sharpeRatio.toFixed(2)}
- t-Statistic: ${oos.tStatistic.toFixed(2)} | Max Drawdown: ${(oos.maxDrawdown * 100).toFixed(1)}%
- Profit Factor: ${oos.profitFactor === Infinity ? 'INF' : oos.profitFactor.toFixed(2)}

DEGRADATION (IS → OOS):
- Win Rate: ${deg.winRate.toFixed(1)}%
- Sharpe Ratio: ${deg.sharpeRatio.toFixed(1)}%
- Profit Factor: ${deg.profitFactor.toFixed(1)}%
- Overall Degradation: ${deg.overall.toFixed(1)}%

SEMAPHORE: ${JSON.stringify(result.semaphore)}

${walkForward ? `WALK-FORWARD (${walkForward.windows.length} windows):
- Consistency: ${(walkForward.consistency * 100).toFixed(0)}% profitable windows
- Aggregate Test Sharpe: ${walkForward.aggregateTestMetrics.sharpeRatio.toFixed(2)}
- Aggregate Test Win Rate: ${(walkForward.aggregateTestMetrics.winRate * 100).toFixed(1)}%` : 'No walk-forward analysis available.'}

APPROVAL THRESHOLDS:
- t-stat OOS > 3.0 (green), > 2.0 (yellow), < 2.0 (red)
- Win rate > 55% (green), > 45% (yellow), < 45% (red)
- Sharpe > 1.5 (green), > 1.0 (yellow), < 1.0 (red)
- Max drawdown < 15% (green), < 25% (yellow), > 25% (red)
- IS vs OOS degradation < 20% (green), < 40% (yellow), > 40% (red)

Respond with ONLY valid JSON:
{
  "verdict": "approve|caution|reject",
  "confidence": <0-1>,
  "summary": "2-3 sentence executive summary",
  "strengths": ["strength 1", "strength 2"],
  "weaknesses": ["weakness 1", "weakness 2"],
  "overfittingRisk": "low|medium|high",
  "recommendation": "specific actionable recommendation"
}

Be CRITICAL. When in doubt, recommend caution. Trading losses are real.`

  const { text } = await generateText({
    model,
    prompt,
    temperature: 0.2,
  })

  const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
  const parsed = JSON.parse(cleaned)
  return AIReviewSchema.parse(parsed)
}
