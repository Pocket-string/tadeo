'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { buildAnalysisContext, analyzeMarket, proposeStrategy } from '@/features/ai-analyst/services/aiAnalyst'
import type { MarketAnalysis, StrategyProposal, AnalysisContext } from '@/features/ai-analyst/types'
import { collectPaperFeedback, formatFeedbackForPrompt } from '@/features/strategy-discovery/services/feedbackCollector'
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

  // 0. Collect paper trading feedback (non-blocking)
  let feedbackStr = ''
  try {
    const feedback = await collectPaperFeedback(user.id)
    feedbackStr = formatFeedbackForPrompt(feedback)
  } catch {
    // Non-blocking
  }

  // 1. Build context from indicators
  const context = await buildAnalysisContext(parsed.symbol, parsed.timeframe)

  // 2. AI analyzes the market (with paper trading feedback)
  const analysis = await analyzeMarket(context, feedbackStr || undefined)

  // 3. AI proposes strategy (with paper trading feedback)
  const proposal = await proposeStrategy(context, analysis, feedbackStr || undefined)

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

/**
 * Get performance history of AI-generated strategies.
 */
export async function getAIStrategyHistory(): Promise<{
  id: string
  name: string
  created_at: string
  session?: { status: string; net_pnl: number; total_trades: number; winning_trades: number }
}[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: strategies } = await supabase
    .from('strategies')
    .select('id, name, created_at')
    .eq('user_id', user.id)
    .ilike('name', '%AI Generated%')
    .order('created_at', { ascending: false })
    .limit(10)

  if (!strategies || strategies.length === 0) return []

  // Get paper sessions for these strategies
  const { data: sessions } = await supabase
    .from('paper_sessions')
    .select('strategy_id, status, net_pnl, total_trades, winning_trades')
    .in('strategy_id', strategies.map(s => s.id))

  const sessionMap = new Map(
    (sessions ?? []).map(s => [s.strategy_id, s])
  )

  return strategies.map(s => ({
    id: s.id,
    name: s.name,
    created_at: s.created_at,
    session: sessionMap.get(s.id) ? {
      status: sessionMap.get(s.id)!.status,
      net_pnl: Number(sessionMap.get(s.id)!.net_pnl ?? 0),
      total_trades: sessionMap.get(s.id)!.total_trades ?? 0,
      winning_trades: sessionMap.get(s.id)!.winning_trades ?? 0,
    } : undefined,
  }))
}

/**
 * Quick analysis for all active paper trading symbols (no strategy proposal).
 */
export async function runQuickAnalysisAll(): Promise<{
  symbol: string
  timeframe: string
  analysis: MarketAnalysis
}[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: sessions } = await supabase
    .from('paper_sessions')
    .select('symbol, timeframe')
    .eq('user_id', user.id)
    .eq('status', 'active')

  if (!sessions || sessions.length === 0) return []

  // Deduplicate symbol+timeframe pairs
  const pairs = [...new Map(sessions.map(s => [`${s.symbol}:${s.timeframe}`, s])).values()]

  const results: { symbol: string; timeframe: string; analysis: MarketAnalysis }[] = []

  // Run analyses in parallel (max 5 concurrent)
  const chunks = []
  for (let i = 0; i < pairs.length; i += 5) {
    chunks.push(pairs.slice(i, i + 5))
  }

  for (const chunk of chunks) {
    const chunkResults = await Promise.allSettled(
      chunk.map(async ({ symbol, timeframe }) => {
        const context = await buildAnalysisContext(symbol, timeframe)
        const analysis = await analyzeMarket(context)
        return { symbol, timeframe, analysis }
      })
    )

    for (const r of chunkResults) {
      if (r.status === 'fulfilled') results.push(r.value)
    }
  }

  return results
}
