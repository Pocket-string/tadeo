'use server'

import { createClient } from '@/lib/supabase/server'
import type { MarketDataQuery, OHLCVCandle, ImportCandlesInput } from '../types'

export async function getCandles(query: MarketDataQuery): Promise<OHLCVCandle[]> {
  const supabase = await createClient()

  let q = supabase
    .from('ohlcv_candles')
    .select('timestamp, open, high, low, close, volume')
    .eq('symbol', query.symbol)
    .eq('timeframe', query.timeframe)
    .gte('timestamp', query.startDate)
    .lte('timestamp', query.endDate)
    .order('timestamp', { ascending: true })

  // Default high limit to avoid Supabase's 1000-row default
  q = q.limit(query.limit ?? 10000)

  const { data, error } = await q

  if (error) throw new Error(`Failed to fetch candles: ${error.message}`)
  return data ?? []
}

export async function importCandles(input: ImportCandlesInput): Promise<{ inserted: number }> {
  const supabase = await createClient()

  const rows = input.candles.map((c: OHLCVCandle) => ({
    symbol: input.symbol,
    timeframe: input.timeframe,
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }))

  const { error, count } = await supabase
    .from('ohlcv_candles')
    .upsert(rows, { onConflict: 'symbol,timeframe,timestamp' })

  if (error) throw new Error(`Failed to import candles: ${error.message}`)
  return { inserted: count ?? rows.length }
}

export async function getAvailableSymbols(): Promise<string[]> {
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('ohlcv_candles')
    .select('symbol')
    .limit(1000)

  if (error) throw new Error(`Failed to fetch symbols: ${error.message}`)

  const unique = [...new Set((data ?? []).map(r => r.symbol))]
  return unique.sort()
}

export async function getCandleCount(symbol: string, timeframe: string): Promise<number> {
  const supabase = await createClient()

  const { count, error } = await supabase
    .from('ohlcv_candles')
    .select('id', { count: 'exact', head: true })
    .eq('symbol', symbol)
    .eq('timeframe', timeframe)

  if (error) throw new Error(`Failed to count candles: ${error.message}`)
  return count ?? 0
}
