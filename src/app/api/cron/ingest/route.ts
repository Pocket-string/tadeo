import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { ingestFromBinance, type IngestResult } from '@/features/market-data/services/ingestPipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const DEFAULT_BACKFILL_DAYS = 7

/**
 * Auto-ingest OHLCV candles for all active paper trading pairs.
 * Fetches only missing candles (from last DB timestamp to now).
 * Designed to run every 5 minutes via external cron.
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret')

  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()

  // 1. Get unique symbol+timeframe pairs from active sessions
  const { data: sessions, error: sessError } = await supabase
    .from('paper_sessions')
    .select('symbol, timeframe')
    .eq('status', 'active')

  if (sessError) {
    return NextResponse.json({ error: `Failed to query sessions: ${sessError.message}` }, { status: 500 })
  }

  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ ok: true, timestamp: new Date().toISOString(), pairs: 0, message: 'No active sessions' })
  }

  // 2. Build unique pairs + HTF bias timeframes
  const pairSet = new Map<string, Set<string>>()

  for (const s of sessions) {
    if (!pairSet.has(s.symbol)) pairSet.set(s.symbol, new Set())
    pairSet.get(s.symbol)!.add(s.timeframe)

    // Add HTF bias timeframe (mirrors computeHTFBias in paperEngine)
    const htf = (s.timeframe === '4h' || s.timeframe === '1d') ? '1d' : '4h'
    pairSet.get(s.symbol)!.add(htf)
  }

  // 3. For each pair, find last candle and ingest the gap
  const results: IngestResult[] = []
  const endDate = new Date().toISOString()

  for (const [symbol, timeframes] of pairSet) {
    for (const timeframe of timeframes) {
      try {
        // Find last candle in DB for this pair
        const { data: lastRow } = await supabase
          .from('ohlcv_candles')
          .select('timestamp')
          .eq('symbol', symbol)
          .eq('timeframe', timeframe)
          .order('timestamp', { ascending: false })
          .limit(1)
          .maybeSingle()

        const startDate = lastRow?.timestamp
          ?? new Date(Date.now() - DEFAULT_BACKFILL_DAYS * 24 * 60 * 60 * 1000).toISOString()

        const result = await ingestFromBinance(symbol, timeframe, startDate, endDate)
        results.push(result)
      } catch (err) {
        results.push({
          symbol,
          timeframe,
          fetched: 0,
          upserted: 0,
          errors: [err instanceof Error ? err.message : 'Unknown error'],
        })
      }
    }
  }

  const totalFetched = results.reduce((s, r) => s + r.fetched, 0)
  const totalUpserted = results.reduce((s, r) => s + r.upserted, 0)
  const errorResults = results.filter(r => r.errors.length > 0)

  return NextResponse.json({
    ok: errorResults.length === 0,
    timestamp: new Date().toISOString(),
    pairs: results.length,
    totalFetched,
    totalUpserted,
    errors: errorResults,
    results,
  })
}
