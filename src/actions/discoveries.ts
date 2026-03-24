'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import type { StrategyParameters } from '@/types/database'
import type { ProposalRecord } from '@/features/strategy-discovery/types'

export interface DiscoveryRun {
  id: string
  trigger: string
  symbols: string[]
  timeframes: string[]
  hypotheses_generated: number
  hypotheses_tested: number
  proposals_saved: number
  proposals_rejected: number
  errors: string[]
  duration_ms: number | null
  started_at: string
  completed_at: string | null
  created_at: string
}

export async function getProposals(): Promise<ProposalRecord[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect('/login')

  const { data, error } = await supabase
    .from('strategy_proposals')
    .select('*')
    .eq('user_id', user.id)
    .order('score', { ascending: false })

  if (error) throw new Error(`Failed to fetch proposals: ${error.message}`)
  return (data ?? []) as ProposalRecord[]
}

export async function approveProposal(proposalId: string): Promise<{ strategyId: string; sessionId: string }> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect('/login')

  // Fetch the proposal
  const { data: proposal, error: fetchErr } = await supabase
    .from('strategy_proposals')
    .select('*')
    .eq('id', proposalId)
    .eq('user_id', user.id)
    .single()

  if (fetchErr || !proposal) throw new Error(`Proposal not found: ${fetchErr?.message}`)

  const params = proposal.optimized_params as StrategyParameters
  const metrics = proposal.backtest_results as {
    winRate: number
    netPnlPct: number
    sharpeRatio: number
    totalTrades: number
  }

  const strategyName = `Discovery-${proposal.symbol}-${proposal.timeframe} (WR:${(metrics.winRate * 100).toFixed(0)}% PnL:${(metrics.netPnlPct * 100).toFixed(1)}%)`

  // Create strategy
  const { data: strategy, error: stratErr } = await supabase
    .from('strategies')
    .insert({
      user_id: user.id,
      name: strategyName,
      description: `Auto-discovered by AI. ${proposal.ai_rationale}. ${metrics.totalTrades} trades backtested. Sharpe: ${metrics.sharpeRatio.toFixed(2)}`,
      status: 'validated',
      parameters: {
        ...params,
        signal_systems: proposal.signal_config ?? undefined,
      },
    })
    .select('id')
    .single()

  if (stratErr || !strategy) throw new Error(`Failed to create strategy: ${stratErr?.message}`)

  // Stop existing active sessions for this symbol
  await supabase
    .from('paper_sessions')
    .update({ status: 'stopped', stopped_at: new Date().toISOString() })
    .eq('user_id', user.id)
    .eq('symbol', proposal.symbol)
    .eq('status', 'active')

  // Start paper trading session
  const { data: session, error: sessErr } = await supabase
    .from('paper_sessions')
    .insert({
      user_id: user.id,
      strategy_id: strategy.id,
      symbol: proposal.symbol,
      timeframe: proposal.timeframe,
      initial_capital: 100,
      current_capital: 100,
      risk_tier: 'moderate',
    })
    .select('id')
    .single()

  if (sessErr || !session) throw new Error(`Failed to start session: ${sessErr?.message}`)

  // Update proposal status
  await supabase
    .from('strategy_proposals')
    .update({
      status: 'deployed',
      reviewed_at: new Date().toISOString(),
      deployed_session_id: session.id,
    })
    .eq('id', proposalId)

  revalidatePath('/discoveries')
  revalidatePath('/paper-trading')

  return { strategyId: strategy.id, sessionId: session.id }
}

export async function rejectProposal(proposalId: string): Promise<void> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect('/login')

  await supabase
    .from('strategy_proposals')
    .update({
      status: 'rejected',
      reviewed_at: new Date().toISOString(),
    })
    .eq('id', proposalId)
    .eq('user_id', user.id)

  revalidatePath('/discoveries')
}

export async function getDiscoveryRuns(limit = 10): Promise<DiscoveryRun[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect('/login')

  const { data, error } = await supabase
    .from('discovery_runs')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(limit)

  if (error) throw new Error(`Failed to fetch runs: ${error.message}`)
  return (data ?? []) as DiscoveryRun[]
}

export async function triggerManualDiscovery(minScore = 4): Promise<{
  proposals: number
  scanned: number
  tested: number
  errors: string[]
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect('/login')

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'

  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret) {
    return { proposals: 0, scanned: 0, tested: 0, errors: ['CRON_SECRET not configured'] }
  }

  // Fire-and-forget: trigger discovery without awaiting (avoids Traefik 60s timeout)
  // Results are tracked in discovery_runs table and will appear on page refresh
  fetch(`${baseUrl}/api/cron/discover?secret=${cronSecret}&minScore=${minScore}&trigger=manual`, {
    method: 'GET',
    signal: AbortSignal.timeout(290_000),
  }).catch(() => {})

  revalidatePath('/discoveries')
  return { proposals: -1, scanned: 0, tested: 0, errors: [] }
}
