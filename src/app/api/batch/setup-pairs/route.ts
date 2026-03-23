import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { TRADING_PAIRS, PAIR_CONFIG } from '@/shared/lib/trading-pairs'
import { ingestFromBinance } from '@/features/market-data/services/ingestPipeline'
import { runDiscoveryLoop } from '@/features/strategy-discovery/services/discoveryAgent'
import type { Timeframe } from '@/features/market-data/types'
import type { StrategyParameters } from '@/types/database'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export async function POST(req: NextRequest) {
  // Auth: CRON_SECRET
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (auth !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Optional: filter to specific symbols via query param (comma-separated)
  const symbolsParam = req.nextUrl.searchParams.get('symbols')
  const targetSymbols = symbolsParam
    ? symbolsParam.split(',').filter(s => (TRADING_PAIRS as readonly string[]).includes(s))
    : [...TRADING_PAIRS]

  const supabase = getServiceClient()

  // Get first user (single-tenant app)
  const { data: users } = await supabase.from('profiles').select('id').limit(1)
  if (!users || users.length === 0) {
    return NextResponse.json({ error: 'No users found' }, { status: 500 })
  }
  const userId = users[0].id

  // Get existing active sessions to skip
  const { data: activeSessions } = await supabase
    .from('paper_sessions')
    .select('symbol, timeframe')
    .eq('user_id', userId)
    .eq('status', 'active')

  const activeSymbols = new Set((activeSessions ?? []).map(s => s.symbol))

  const results: {
    symbol: string
    timeframe: string
    action: string
    proposals?: number
    sessionId?: string
    error?: string
  }[] = []

  for (const symbol of targetSymbols) {
    const config = PAIR_CONFIG[symbol as keyof typeof PAIR_CONFIG]
    const timeframe = config.defaultTimeframe

    // Skip if already has an active session
    if (activeSymbols.has(symbol)) {
      results.push({ symbol, timeframe, action: 'skipped_active' })
      continue
    }

    try {
      // Step 1: INGEST — primary timeframe + HTF for bias
      const startDate = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString()
      const endDate = new Date().toISOString()
      const htf = (timeframe === '4h' || timeframe === '1d') ? '1d' : '4h'

      const [primaryIngest, htfIngest] = await Promise.all([
        ingestFromBinance(symbol, timeframe, startDate, endDate),
        ingestFromBinance(symbol, htf, startDate, endDate),
      ])

      if (primaryIngest.fetched < 50) {
        results.push({ symbol, timeframe, action: 'skipped_no_data', error: `Only ${primaryIngest.fetched} candles` })
        continue
      }

      // Step 2: DISCOVERY — analyze + hypothesize + backtest + score (with walk-forward validation)
      const discovery = await runDiscoveryLoop({
        symbols: [symbol],
        timeframes: [timeframe as Timeframe],
        userId,
        hypothesesPerMarket: 5,
        minScore: 3,
        monthsBack: 6,
        trigger: 'batch-setup',
      })

      if (discovery.proposals === 0) {
        results.push({
          symbol,
          timeframe,
          action: 'no_valid_proposal',
          proposals: 0,
          error: discovery.errors.length > 0 ? discovery.errors[0] : 'All hypotheses failed walk-forward validation',
        })
        continue
      }

      // Step 3: AUTO-DEPLOY — approve best proposal
      const { data: bestProposal } = await supabase
        .from('strategy_proposals')
        .select('*')
        .eq('user_id', userId)
        .eq('symbol', symbol)
        .eq('timeframe', timeframe)
        .eq('status', 'pending')
        .order('score', { ascending: false })
        .limit(1)
        .single()

      if (!bestProposal) {
        results.push({ symbol, timeframe, action: 'no_proposal_found', proposals: discovery.proposals })
        continue
      }

      const params = bestProposal.optimized_params as StrategyParameters
      const metrics = bestProposal.backtest_results as {
        winRate: number
        netPnlPct: number
        sharpeRatio: number
        totalTrades: number
      }

      // Create strategy
      const strategyName = `Discovery-${symbol}-${timeframe} (WR:${(metrics.winRate * 100).toFixed(0)}% PnL:${(metrics.netPnlPct * 100).toFixed(1)}%)`
      const { data: strategy, error: stratErr } = await supabase
        .from('strategies')
        .insert({
          user_id: userId,
          name: strategyName,
          description: `Auto-discovered by AI. ${bestProposal.ai_rationale}. ${metrics.totalTrades} trades backtested. Sharpe: ${metrics.sharpeRatio.toFixed(2)}. Walk-forward validated.`,
          status: 'validated',
          parameters: params,
        })
        .select('id')
        .single()

      if (stratErr || !strategy) {
        results.push({ symbol, timeframe, action: 'strategy_create_failed', error: stratErr?.message })
        continue
      }

      // Create paper session
      const { data: session, error: sessErr } = await supabase
        .from('paper_sessions')
        .insert({
          user_id: userId,
          strategy_id: strategy.id,
          symbol,
          timeframe,
          initial_capital: 100,
          current_capital: 100,
          risk_tier: config.riskTier,
        })
        .select('id')
        .single()

      if (sessErr || !session) {
        results.push({ symbol, timeframe, action: 'session_create_failed', error: sessErr?.message })
        continue
      }

      // Mark proposal as deployed
      await supabase
        .from('strategy_proposals')
        .update({
          status: 'deployed',
          reviewed_at: new Date().toISOString(),
          deployed_session_id: session.id,
        })
        .eq('id', bestProposal.id)

      results.push({
        symbol,
        timeframe,
        action: 'deployed',
        proposals: discovery.proposals,
        sessionId: session.id,
      })

    } catch (err) {
      results.push({
        symbol,
        timeframe,
        action: 'error',
        error: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const deployed = results.filter(r => r.action === 'deployed').length
  const skipped = results.filter(r => r.action === 'skipped_active').length

  return NextResponse.json({
    ok: true,
    summary: `${deployed} deployed, ${skipped} skipped (already active), ${results.length - deployed - skipped} other`,
    results,
    timestamp: new Date().toISOString(),
  })
}
