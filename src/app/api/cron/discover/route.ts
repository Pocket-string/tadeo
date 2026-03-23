import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { runDiscoveryLoop } from '@/features/strategy-discovery/services/discoveryAgent'
import type { Timeframe } from '@/features/market-data/types'

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

  // Get the first user with active sessions (single-tenant for now)
  const { data: session } = await supabase
    .from('paper_sessions')
    .select('user_id, symbol, timeframe')
    .eq('status', 'active')
    .limit(1)
    .single()

  if (!session) {
    return NextResponse.json({ message: 'No active sessions found', proposals: 0 })
  }

  // Discover unique symbol+timeframe pairs from active sessions
  const { data: activeSessions } = await supabase
    .from('paper_sessions')
    .select('symbol, timeframe')
    .eq('status', 'active')
    .eq('user_id', session.user_id)

  const symbolSet = new Set<string>()
  const timeframeSet = new Set<Timeframe>()

  for (const s of activeSessions ?? []) {
    symbolSet.add(s.symbol)
    timeframeSet.add(s.timeframe as Timeframe)
  }

  const result = await runDiscoveryLoop({
    symbols: Array.from(symbolSet),
    timeframes: Array.from(timeframeSet),
    userId: session.user_id,
    hypothesesPerMarket: 3,
    minScore: 5,
    monthsBack: 6,
    trigger: 'cron',
  })

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
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
