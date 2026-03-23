import { NextRequest, NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { ingestFromBinance, type IngestResult } from '@/features/market-data/services/ingestPipeline'
import { TRADING_PAIRS, getPairTimeframes, getHTFTimeframe } from '@/shared/lib/trading-pairs'
import type { TradingPair } from '@/shared/lib/trading-pairs'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

const DEFAULT_BACKFILL_DAYS = 270 // 9 months — enough for discovery's 6-month lookback

/**
 * Auto-ingest OHLCV candles.
 * Phase 1: Active paper trading sessions (priority — always runs).
 * Phase 2: ALL TRADING_PAIRS baseline (enables discovery for pairs without sessions).
 * Designed to run every 5 minutes via external cron.
 */
export async function GET(req: NextRequest) {
  const startTime = Date.now()
  const secret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret')

  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = createServiceClient()
  const results: IngestResult[] = []
  const endDate = new Date().toISOString()
  const ingested = new Set<string>() // Track "symbol:timeframe" already handled

  // ── Phase 1: Active sessions (priority) ──
  const { data: sessions, error: sessError } = await supabase
    .from('paper_sessions')
    .select('symbol, timeframe')
    .eq('status', 'active')

  if (sessError) {
    return NextResponse.json({ error: `Failed to query sessions: ${sessError.message}` }, { status: 500 })
  }

  const pairSet = new Map<string, Set<string>>()

  for (const s of (sessions ?? [])) {
    if (!pairSet.has(s.symbol)) pairSet.set(s.symbol, new Set())
    pairSet.get(s.symbol)!.add(s.timeframe)

    const htf = getHTFTimeframe(s.timeframe)
    pairSet.get(s.symbol)!.add(htf)
  }

  for (const [symbol, timeframes] of pairSet) {
    for (const timeframe of timeframes) {
      const key = `${symbol}:${timeframe}`
      ingested.add(key)
      try {
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

  // ── Phase 2: Baseline data for ALL TRADING_PAIRS (enables discovery) ──
  const elapsed = Date.now() - startTime
  if (elapsed < 100_000) { // Only if < 100s elapsed (leave 20s buffer)
    for (const symbol of TRADING_PAIRS) {
      if (Date.now() - startTime > 100_000) break

      const timeframes = getPairTimeframes(symbol)
      for (const timeframe of timeframes) {
        const key = `${symbol}:${timeframe}`
        if (ingested.has(key)) continue
        ingested.add(key)

        try {
          // Check freshness: skip if last candle is < 1 hour old
          const { data: lastRow } = await supabase
            .from('ohlcv_candles')
            .select('timestamp')
            .eq('symbol', symbol)
            .eq('timeframe', timeframe)
            .order('timestamp', { ascending: false })
            .limit(1)
            .maybeSingle()

          if (lastRow?.timestamp) {
            const age = Date.now() - new Date(lastRow.timestamp).getTime()
            if (age < 60 * 60 * 1000) continue // Fresh enough (< 1h)
          }

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
