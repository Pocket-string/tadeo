import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runDiscoveryLoop } from '@/features/strategy-discovery/services/discoveryAgent'
import { TRADING_PAIRS, PAIR_CONFIG } from '@/shared/lib/trading-pairs'
import type { Timeframe } from '@/features/market-data/types'
import type { StrategyParameters } from '@/types/database'

export const dynamic = 'force-dynamic'
export const maxDuration = 300 // 5 minutes for discovery

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret')

  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getServiceClient()

  // Get first user (single-tenant app)
  const { data: users } = await supabase.from('profiles').select('id').limit(1)
  if (!users?.length) {
    return NextResponse.json({ error: 'No users found' }, { status: 500 })
  }
  const userId = users[0].id

  // Build explicit symbol+timeframe pairs from config (avoids cross-product)
  const symbols = [...TRADING_PAIRS]
  const symbolTimeframePairs = symbols.map(s => ({
    symbol: s,
    timeframe: PAIR_CONFIG[s].defaultTimeframe as Timeframe,
  }))

  // Run discovery for ALL 10 pairs
  const result = await runDiscoveryLoop({
    symbols,
    timeframes: [...new Set(symbolTimeframePairs.map(p => p.timeframe))],
    symbolTimeframePairs,
    userId,
    hypothesesPerMarket: 3,
    minScore: 3,
    monthsBack: 6,
    trigger: 'cron',
  })

  // Auto-deploy: for pairs without active sessions, deploy best pending proposal
  const { data: activeSessions } = await supabase
    .from('paper_sessions')
    .select('symbol, timeframe')
    .eq('user_id', userId)
    .eq('status', 'active')

  const activeSet = new Set((activeSessions ?? []).map(s => `${s.symbol}:${s.timeframe}`))
  let deployed = 0

  for (const symbol of symbols) {
    const tf = PAIR_CONFIG[symbol].defaultTimeframe
    if (activeSet.has(`${symbol}:${tf}`)) continue

    // Get best pending proposal for this pair
    const { data: proposal } = await supabase
      .from('strategy_proposals')
      .select('*')
      .eq('user_id', userId)
      .eq('symbol', symbol)
      .eq('timeframe', tf)
      .eq('status', 'pending')
      .order('score', { ascending: false })
      .limit(1)
      .single()

    if (!proposal) continue

    const params = proposal.optimized_params as StrategyParameters
    const metrics = proposal.backtest_results as {
      winRate: number; netPnlPct: number; sharpeRatio: number; totalTrades: number
    }

    // Create strategy
    const stratName = `Discovery-${symbol}-${tf} (WR:${(metrics.winRate * 100).toFixed(0)}% PnL:${(metrics.netPnlPct * 100).toFixed(1)}%)`
    const { data: strategy } = await supabase
      .from('strategies')
      .insert({
        user_id: userId,
        name: stratName,
        description: `Auto-discovered. ${proposal.ai_rationale}. ${metrics.totalTrades} trades. Sharpe: ${metrics.sharpeRatio.toFixed(2)}. Walk-forward validated.`,
        status: 'validated',
        parameters: params,
      })
      .select('id')
      .single()

    if (!strategy) continue

    // Create paper session
    const config = PAIR_CONFIG[symbol]
    const { data: session } = await supabase
      .from('paper_sessions')
      .insert({
        user_id: userId,
        strategy_id: strategy.id,
        symbol,
        timeframe: tf,
        initial_capital: 100,
        current_capital: 100,
        risk_tier: config.riskTier,
      })
      .select('id')
      .single()

    if (session) {
      await supabase.from('strategy_proposals').update({
        status: 'deployed',
        reviewed_at: new Date().toISOString(),
        deployed_session_id: session.id,
      }).eq('id', proposal.id)
      deployed++
    }
  }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    deployed,
    ...result,
  })
}

/**
 * POST — Targeted discovery triggered by auto-retire.
 * Runs discovery for a specific symbol+timeframe with failure context.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const providedToken = authHeader?.replace('Bearer ', '')

  if (providedToken !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await req.json() as {
    symbol: string
    timeframe: string
    userId: string
    failureReason?: string
  }

  const { symbol, timeframe, userId, failureReason } = body
  if (!symbol || !timeframe || !userId) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const result = await runDiscoveryLoop({
    symbols: [symbol],
    timeframes: [timeframe as Timeframe],
    userId,
    hypothesesPerMarket: 2,
    minScore: 6, // Higher bar for auto-deployed sessions
    monthsBack: 6,
    trigger: 'auto-retire',
    failureContext: failureReason
      ? `SESIÓN RETIRADA (${symbol} ${timeframe}): ${failureReason}. Genera hipótesis que EVITEN este problema.`
      : undefined,
  })

  return NextResponse.json({
    ok: true,
    triggered_by: 'auto_retire',
    symbol,
    timeframe,
    timestamp: new Date().toISOString(),
    ...result,
  })
}
