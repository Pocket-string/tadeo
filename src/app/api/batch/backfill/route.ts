import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { TRADING_PAIRS, PAIR_CONFIG, getPairTimeframes } from '@/shared/lib/trading-pairs'
import { ingestFromBinance, type IngestResult } from '@/features/market-data/services/ingestPipeline'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

/**
 * POST /api/batch/backfill — One-time historical data backfill.
 * Fetches candle history going back `months` months for all TRADING_PAIRS.
 * Idempotent: safe to re-run (upsert on symbol,timeframe,timestamp).
 */
export async function POST(req: NextRequest) {
  const auth = req.headers.get('authorization')?.replace('Bearer ', '')
  if (auth !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const months = parseInt(req.nextUrl.searchParams.get('months') ?? '9', 10)
  const symbolsParam = req.nextUrl.searchParams.get('symbols')
  const targetSymbols = symbolsParam
    ? symbolsParam.split(',').filter(s => (TRADING_PAIRS as readonly string[]).includes(s))
    : [...TRADING_PAIRS]

  const supabase = getServiceClient()
  const targetStart = new Date()
  targetStart.setMonth(targetStart.getMonth() - months)

  const results: {
    symbol: string
    timeframe: string
    action: string
    existingFrom?: string
    backfilledTo?: string
    fetched?: number
    upserted?: number
    error?: string
  }[] = []

  for (const symbol of targetSymbols) {
    const timeframes = getPairTimeframes(symbol as Parameters<typeof getPairTimeframes>[0])

    for (const timeframe of timeframes) {
      try {
        // Find earliest existing candle
        const { data: earliest } = await supabase
          .from('ohlcv_candles')
          .select('timestamp')
          .eq('symbol', symbol)
          .eq('timeframe', timeframe)
          .order('timestamp', { ascending: true })
          .limit(1)
          .maybeSingle()

        const existingFrom = earliest?.timestamp
          ? new Date(earliest.timestamp)
          : null

        // Skip if we already have data older than target
        if (existingFrom && existingFrom <= targetStart) {
          results.push({
            symbol,
            timeframe,
            action: 'already_backfilled',
            existingFrom: existingFrom.toISOString(),
          })
          continue
        }

        // Backfill: from target start to earliest existing (or to now if no data)
        const endDate = existingFrom?.toISOString() ?? new Date().toISOString()
        const result = await ingestFromBinance(
          symbol,
          timeframe,
          targetStart.toISOString(),
          endDate
        )

        results.push({
          symbol,
          timeframe,
          action: 'backfilled',
          existingFrom: existingFrom?.toISOString() ?? 'none',
          backfilledTo: targetStart.toISOString(),
          fetched: result.fetched,
          upserted: result.upserted,
          error: result.errors.length > 0 ? result.errors[0] : undefined,
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
  }

  const backfilled = results.filter(r => r.action === 'backfilled').length
  const skipped = results.filter(r => r.action === 'already_backfilled').length
  const totalFetched = results.reduce((s, r) => s + (r.fetched ?? 0), 0)
  const totalUpserted = results.reduce((s, r) => s + (r.upserted ?? 0), 0)

  return NextResponse.json({
    ok: true,
    summary: `${backfilled} backfilled, ${skipped} already OK, ${results.length - backfilled - skipped} errors`,
    months,
    totalFetched,
    totalUpserted,
    results,
    timestamp: new Date().toISOString(),
  })
}
