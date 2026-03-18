'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { fetchBinanceSymbols } from '@/features/market-data/services/binanceClient'
import { ingestFromBinance } from '@/features/market-data/services/ingestPipeline'
import { z } from 'zod'

interface MarketDataSummaryRow {
  symbol: string
  timeframe: string
  count: number
  first: string
  last: string
}

export async function getMarketDataSummary(): Promise<MarketDataSummaryRow[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Use RPC or raw query for efficient aggregation
  const { data, error } = await supabase
    .rpc('get_market_data_summary')

  if (error) {
    // Fallback: discover unique symbol/timeframe pairs by sampling multiple offsets
    // Supabase default limit is 1000 rows, so we sample at different positions
    const uniquePairs = new Map<string, { symbol: string; timeframe: string }>()

    for (const offset of [0, 1000, 3000, 7000, 12000]) {
      const { data: sample } = await supabase
        .from('ohlcv_candles')
        .select('symbol, timeframe')
        .range(offset, offset + 999)

      if (!sample || sample.length === 0) break
      for (const row of sample) {
        uniquePairs.set(`${row.symbol}|${row.timeframe}`, row)
      }
    }

    // For each pair, get exact count + first/last timestamps
    const results = await Promise.all(
      Array.from(uniquePairs.values()).map(async ({ symbol, timeframe }) => {
        const [countRes, firstRes, lastRes] = await Promise.all([
          supabase
            .from('ohlcv_candles')
            .select('id', { count: 'exact', head: true })
            .eq('symbol', symbol)
            .eq('timeframe', timeframe),
          supabase
            .from('ohlcv_candles')
            .select('timestamp')
            .eq('symbol', symbol)
            .eq('timeframe', timeframe)
            .order('timestamp', { ascending: true })
            .limit(1)
            .single(),
          supabase
            .from('ohlcv_candles')
            .select('timestamp')
            .eq('symbol', symbol)
            .eq('timeframe', timeframe)
            .order('timestamp', { ascending: false })
            .limit(1)
            .single(),
        ])

        return {
          symbol,
          timeframe,
          count: countRes.count ?? 0,
          first: firstRes.data?.timestamp ?? '',
          last: lastRes.data?.timestamp ?? '',
        }
      })
    )

    return results
  }

  return (data ?? []).map((row: { symbol: string; timeframe: string; count: number; first_ts: string; last_ts: string }) => ({
    symbol: row.symbol,
    timeframe: row.timeframe,
    count: Number(row.count),
    first: row.first_ts,
    last: row.last_ts,
  }))
}

const IngestSchema = z.object({
  symbol: z.string().min(1),
  timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
})

export async function triggerIngest(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const parsed = IngestSchema.parse({
    symbol: formData.get('symbol'),
    timeframe: formData.get('timeframe'),
    startDate: formData.get('startDate'),
    endDate: formData.get('endDate'),
  })

  return await ingestFromBinance(
    parsed.symbol,
    parsed.timeframe,
    parsed.startDate,
    parsed.endDate
  )
}

export async function getAvailableBinanceSymbols() {
  return await fetchBinanceSymbols()
}
