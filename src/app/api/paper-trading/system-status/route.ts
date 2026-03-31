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

  // Check active sessions + last trade activity (not agent_log, which filters no_signal/hold)
  const [{ count: activeSessions }, { data: lastTrade }, { data: lastLog }] = await Promise.all([
    supabase
      .from('paper_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase
      .from('paper_trades')
      .select('entry_time')
      .order('entry_time', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabase
      .from('paper_agent_log')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  // Use the most recent activity from either trades or agent_log
  const lastTradeTime = lastTrade?.entry_time ?? null
  const lastLogTime = lastLog?.created_at ?? null
  const latestActivity = [lastTradeTime, lastLogTime]
    .filter(Boolean)
    .sort()
    .pop() ?? null

  const minutesSinceLastActivity = latestActivity
    ? Math.floor((Date.now() - new Date(latestActivity).getTime()) / 60000)
    : null

  // Cron healthy if activity in last 10 min (agent_log now caps at 20 entries per tick)
  const cronHealthy =
    (activeSessions ?? 0) === 0 ||
    minutesSinceLastActivity === null ||
    minutesSinceLastActivity < 10

  return NextResponse.json({
    activeSessions: activeSessions ?? 0,
    lastLogTime: latestActivity,
    minutesSinceLastLog: minutesSinceLastActivity,
    cronHealthy,
    timestamp: new Date().toISOString(),
  })
}
