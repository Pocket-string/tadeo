'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { buildAnalysisContext, analyzeMarket, proposeStrategy } from '@/features/ai-analyst/services/aiAnalyst'
import type { MarketAnalysis, StrategyProposal, AnalysisContext } from '@/features/ai-analyst/types'
import { z } from 'zod'
import { DEFAULT_STRATEGY_PARAMS } from '@/types/database'

const AnalyzeSchema = z.object({
  symbol: z.string().min(1).max(20),
  timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']),
})

export interface FullAnalysisResult {
  context: AnalysisContext
  analysis: MarketAnalysis
  proposal: StrategyProposal
}

/**
 * Run full AI analysis: build context → analyze market → propose strategy.
 * This is the main entry point for the AI analyst feature.
 */
export async function runFullAnalysis(input: {
  symbol: string
  timeframe: string
}): Promise<FullAnalysisResult> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const parsed = AnalyzeSchema.parse(input)

  // 1. Build context from indicators
  const context = await buildAnalysisContext(parsed.symbol, parsed.timeframe)

  // 2. AI analyzes the market
  const analysis = await analyzeMarket(context)

  // 3. AI proposes strategy
  const proposal = await proposeStrategy(context, analysis)

  return { context, analysis, proposal }
}

/**
 * Save an AI-proposed strategy (after human approval).
 * HUMAN GATE: The user must explicitly approve the proposal before saving.
 */
export async function approveAndSaveStrategy(proposal: StrategyProposal) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = {
    ...DEFAULT_STRATEGY_PARAMS,
    ...proposal.parameters,
  }

  const { error } = await supabase
    .from('strategies')
    .insert({
      user_id: user.id,
      name: proposal.name,
      description: `[AI Generated] ${proposal.description}`,
      parameters: params,
    })

  if (error) throw new Error(`Failed to save strategy: ${error.message}`)
}
