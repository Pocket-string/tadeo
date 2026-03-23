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

  const [{ count: activeSessions }, { data: lastLog }] = await Promise.all([
    supabase
      .from('paper_sessions')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'active'),
    supabase
      .from('paper_agent_log')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const lastLogTime = lastLog?.created_at ?? null
  const minutesSinceLastLog = lastLogTime
    ? Math.floor((Date.now() - new Date(lastLogTime).getTime()) / 60000)
    : null

  // Cron is healthy if agent logged an event in the last 10 min
  // OR if there are no active sessions (nothing to do)
  const cronHealthy =
    (activeSessions ?? 0) === 0 ||
    minutesSinceLastLog === null ||
    minutesSinceLastLog < 10

  return NextResponse.json({
    activeSessions: activeSessions ?? 0,
    lastLogTime,
    minutesSinceLastLog,
    cronHealthy,
    timestamp: new Date().toISOString(),
  })
}
