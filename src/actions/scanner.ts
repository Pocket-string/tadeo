'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { scanMarket } from '@/features/scanner/services/scannerEngine'
import { DEFAULT_SCANNER_CONFIG } from '@/features/scanner/types'
import type { ScannerConfig } from '@/features/scanner/types'
import type { OHLCVCandle } from '@/features/market-data/types'
import type { Timeframe } from '@/features/market-data/types'
import type { StrategyParameters } from '@/types/database'
import { DEFAULT_STRATEGY_PARAMS } from '@/types/database'

export async function runScanner(
  config?: Partial<ScannerConfig>,
  params?: Partial<StrategyParameters>
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const cfg = { ...DEFAULT_SCANNER_CONFIG, ...config }
  const strategyParams = { ...DEFAULT_STRATEGY_PARAMS, ...params }

  // Function to fetch candles for a pair/timeframe from Supabase
  async function getCandles(symbol: string, timeframe: Timeframe): Promise<OHLCVCandle[]> {
    const { data, error } = await supabase
      .from('ohlcv_candles')
      .select('*')
      .eq('symbol', symbol)
      .eq('timeframe', timeframe)
      .order('timestamp', { ascending: true })
      .limit(500) // Last 500 candles for scanning

    if (error || !data) return []

    return data.map(row => ({
      id: row.id,
      symbol: row.symbol,
      timeframe: row.timeframe as Timeframe,
      timestamp: row.timestamp,
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume),
      created_at: row.created_at,
    }))
  }

  return scanMarket(getCandles, cfg, strategyParams)
}

export async function getAvailableData() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  // Query each known pair/timeframe individually
  const pairs = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT']
  const timeframes = ['1h', '4h', '1d']
  const results: { symbol: string; timeframe: string; candleCount: number }[] = []

  for (const symbol of pairs) {
    for (const tf of timeframes) {
      const { count } = await supabase
        .from('ohlcv_candles')
        .select('*', { count: 'exact', head: true })
        .eq('symbol', symbol)
        .eq('timeframe', tf)

      if (count && count > 0) {
        results.push({ symbol, timeframe: tf, candleCount: count })
      }
    }
  }

  return results
}
