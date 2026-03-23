import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret')

  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'http://localhost:3000'
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.CRON_SECRET}`,
  }

  // Tick paper and live sessions in parallel
  const [paperResult, liveResult] = await Promise.allSettled([
    fetch(`${baseUrl}/api/paper-trading/tick-all`, { method: 'POST', headers, body: '{}' }),
    fetch(`${baseUrl}/api/live-trading/tick-all`, { method: 'POST', headers, body: '{}' }),
  ])

  const paperData = paperResult.status === 'fulfilled' ? await paperResult.value.json() : { error: paperResult.reason?.message }
  const liveData = liveResult.status === 'fulfilled' ? await liveResult.value.json() : { error: liveResult.reason?.message }

  return NextResponse.json({
    ok: true,
    timestamp: new Date().toISOString(),
    paper: paperData,
    live: liveData,
  })
}
