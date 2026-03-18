'use server'

import { createServiceClient } from '@/lib/supabase/server'
import { fetchCandlesRange } from './binanceClient'

const BATCH_SIZE = 200 // Optimal for Supabase free tier (data-pipeline pattern)

export interface IngestResult {
  symbol: string
  timeframe: string
  fetched: number
  upserted: number
  errors: string[]
}

/**
 * Ingest candles from Binance into Supabase.
 * Uses batch upsert pattern (200 rows per batch) for optimal performance.
 */
export async function ingestFromBinance(
  symbol: string,
  timeframe: string,
  startDate: string,
  endDate: string
): Promise<IngestResult> {
  const result: IngestResult = {
    symbol,
    timeframe,
    fetched: 0,
    upserted: 0,
    errors: [],
  }

  // 1. Fetch from Binance
  const candles = await fetchCandlesRange(symbol, timeframe, startDate, endDate)
  result.fetched = candles.length

  if (candles.length === 0) return result

  // 2. Batch upsert into Supabase (200-row batches)
  const supabase = createServiceClient()

  for (let i = 0; i < candles.length; i += BATCH_SIZE) {
    const batch = candles.slice(i, i + BATCH_SIZE)
    const rows = batch.map((c) => ({
      symbol: symbol.toUpperCase().replace('/', ''),
      timeframe,
      timestamp: c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
    }))

    const { error } = await supabase
      .from('ohlcv_candles')
      .upsert(rows, { onConflict: 'symbol,timeframe,timestamp' })

    if (error) {
      result.errors.push(`Batch ${i}-${i + batch.length}: ${error.message}`)
    } else {
      result.upserted += batch.length
    }
  }

  return result
}

/**
 * Get ingestion status for all symbols in the database.
 */
export async function getIngestionStatus(): Promise<{
  symbol: string
  timeframe: string
  count: number
  firstCandle: string | null
  lastCandle: string | null
}[]> {
  const supabase = createServiceClient()

  const { data, error } = await supabase.rpc('get_ingestion_status')

  if (error) {
    // Fallback: manual query if RPC doesn't exist
    const { data: fallbackData, error: fallbackError } = await supabase
      .from('ohlcv_candles')
      .select('symbol, timeframe')
      .limit(1000)

    if (fallbackError) throw new Error(`Failed to get status: ${fallbackError.message}`)

    // Aggregate manually
    const groups = new Map<string, { count: number }>()
    for (const row of fallbackData ?? []) {
      const key = `${row.symbol}:${row.timeframe}`
      const g = groups.get(key) ?? { count: 0 }
      g.count++
      groups.set(key, g)
    }

    return Array.from(groups.entries()).map(([key, g]) => {
      const [symbol, timeframe] = key.split(':')
      return { symbol, timeframe, count: g.count, firstCandle: null, lastCandle: null }
    })
  }

  return data ?? []
}
