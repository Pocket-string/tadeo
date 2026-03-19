'use server'

import { turboSimulate, optimizeStrategy } from '@/features/paper-trading/services/turboSimulator'
import type { SimResult, OptimizationResult } from '@/features/paper-trading/services/turboSimulator'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'

export async function runTurboSim(input: {
  symbol: string
  timeframe: Timeframe
  params: StrategyParameters
  capitalStart?: number
  monthsBack?: number
}): Promise<SimResult> {
  return turboSimulate(input)
}

export async function runOptimizer(input: {
  symbol: string
  timeframe: Timeframe
  baseParams: StrategyParameters
  capitalStart?: number
  monthsBack?: number
  generations?: number
  populationSize?: number
}): Promise<OptimizationResult> {
  return optimizeStrategy(input)
}

/**
 * Deploy optimized strategy to paper trading:
 * 1. Upsert strategy with optimized params
 * 2. Start paper trading session
 */
export async function deployOptimizedStrategy(input: {
  symbol: string
  timeframe: Timeframe
  params: StrategyParameters
  capitalStart?: number
  riskTier?: string
  metrics: { winRate: number; netPnlPct: number; sharpeRatio: number; totalTrades: number }
}): Promise<{ strategyId: string; sessionId: string }> {
  const { createClient } = await import('@/lib/supabase/server')
  const { redirect } = await import('next/navigation')

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return redirect('/login')

  const userId = user.id
  const strategyName = `Turbo-${input.symbol}-${input.timeframe} (WR:${(input.metrics.winRate * 100).toFixed(0)}% PnL:${(input.metrics.netPnlPct * 100).toFixed(1)}%)`

  // Upsert strategy with optimized params
  const { data: strategy, error: stratErr } = await supabase
    .from('strategies')
    .upsert({
      user_id: userId,
      name: strategyName,
      description: `Auto-optimized by Turbo Simulator. ${input.metrics.totalTrades} trades backtested. Sharpe: ${input.metrics.sharpeRatio.toFixed(2)}`,
      status: 'validated',
      parameters: input.params,
    }, { onConflict: 'user_id,name' })
    .select('id')
    .single()

  if (stratErr) {
    // If upsert fails (no unique constraint on name), just insert
    const { data: newStrat, error: insErr } = await supabase
      .from('strategies')
      .insert({
        user_id: userId,
        name: strategyName,
        description: `Auto-optimized by Turbo Simulator. ${input.metrics.totalTrades} trades backtested. Sharpe: ${input.metrics.sharpeRatio.toFixed(2)}`,
        status: 'validated',
        parameters: input.params,
      })
      .select('id')
      .single()

    if (insErr || !newStrat) throw new Error(`Failed to create strategy: ${insErr?.message}`)

    // Stop any existing active sessions for this symbol
    await supabase
      .from('paper_sessions')
      .update({ status: 'stopped', stopped_at: new Date().toISOString() })
      .eq('user_id', userId)
      .eq('symbol', input.symbol)
      .eq('status', 'active')

    // Start paper trading session
    const { data: session, error: sessErr } = await supabase
      .from('paper_sessions')
      .insert({
        user_id: userId,
        strategy_id: newStrat.id,
        symbol: input.symbol,
        timeframe: input.timeframe,
        initial_capital: input.capitalStart ?? 100,
        current_capital: input.capitalStart ?? 100,
        risk_tier: input.riskTier ?? 'moderate',
      })
      .select('id')
      .single()

    if (sessErr || !session) throw new Error(`Failed to start session: ${sessErr?.message}`)
    return { strategyId: newStrat.id, sessionId: session.id }
  }

  if (!strategy) throw new Error('Failed to upsert strategy')

  // Stop any existing active sessions for this symbol
  await supabase
    .from('paper_sessions')
    .update({ status: 'stopped', stopped_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('symbol', input.symbol)
    .eq('status', 'active')

  // Start paper trading session
  const { data: session, error: sessErr } = await supabase
    .from('paper_sessions')
    .insert({
      user_id: userId,
      strategy_id: strategy.id,
      symbol: input.symbol,
      timeframe: input.timeframe,
      initial_capital: input.capitalStart ?? 100,
      current_capital: input.capitalStart ?? 100,
      risk_tier: input.riskTier ?? 'moderate',
    })
    .select('id')
    .single()

  if (sessErr || !session) throw new Error(`Failed to start session: ${sessErr?.message}`)
  return { strategyId: strategy.id, sessionId: session.id }
}
