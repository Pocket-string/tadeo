import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export const dynamic = 'force-dynamic'

/**
 * GET /api/paper-trading/system-status
 * Returns system health: active sessions count, last trade time, cron health.
 * No auth required — only returns aggregate counts, no sensitive data.
 */
export async function GET() {
  const supabase = getServiceClient()

  const [{ count: activeSessions }, { data: lastTrade }] = await Promise.all([
    supabase
      .from('paper_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase
      .from('paper_trades')
      .select('exit_time')
      .eq('status', 'closed')
      .not('exit_time', 'is', null)
      .order('exit_time', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const lastTradeTime = lastTrade?.exit_time ?? null
  const minutesSinceLastTrade = lastTradeTime
    ? Math.floor((Date.now() - new Date(lastTradeTime).getTime()) / 60000)
    : null

  // Cron is considered healthy if a trade was closed in the last 30 min
  // OR if there are no active sessions (nothing to do)
  const cronHealthy =
    (activeSessions ?? 0) === 0 ||
    minutesSinceLastTrade === null ||
    minutesSinceLastTrade < 30

  return NextResponse.json({
    activeSessions: activeSessions ?? 0,
    lastTradeTime,
    minutesSinceLastTrade,
    cronHealthy,
    timestamp: new Date().toISOString(),
  })
}
