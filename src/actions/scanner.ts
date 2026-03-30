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
import { FULL_SIGNAL_CONFIG } from '@/features/paper-trading/services/signalRegistry'

/**
 * Load best optimized params from autoresearch if available.
 * Falls back to defaults + FULL_SIGNAL_CONFIG.
 */
async function loadOptimizedParams(
  supabase: Awaited<ReturnType<typeof createClient>>
): Promise<StrategyParameters> {
  try {
    const { data } = await supabase
      .from('autoresearch_runs')
      .select('best_params')
      .eq('status', 'completed')
      .order('final_score', { ascending: false })
      .limit(1)
      .single()

    if (data?.best_params && typeof data.best_params === 'object') {
      return {
        ...DEFAULT_STRATEGY_PARAMS,
        ...data.best_params as Partial<StrategyParameters>,
        signal_systems: (data.best_params as Record<string, unknown>).signal_systems
          ? (data.best_params as StrategyParameters).signal_systems
          : FULL_SIGNAL_CONFIG.map(s => ({ ...s })),
      }
    }
  } catch {
    // No autoresearch results or table doesn't exist — use defaults
  }

  return {
    ...DEFAULT_STRATEGY_PARAMS,
    signal_systems: FULL_SIGNAL_CONFIG.map(s => ({ ...s })),
  }
}

export async function runScanner(
  config?: Partial<ScannerConfig>,
  params?: Partial<StrategyParameters>
) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const cfg = { ...DEFAULT_SCANNER_CONFIG, ...config }

  // Load optimized params from autoresearch, then merge with any explicit overrides
  const optimizedParams = await loadOptimizedParams(supabase)
  const strategyParams = { ...optimizedParams, ...params }

  async function getCandles(symbol: string, timeframe: Timeframe): Promise<OHLCVCandle[]> {
    const { data, error } = await supabase
      .from('ohlcv_candles')
      .select('*')
      .eq('symbol', symbol)
      .eq('timeframe', timeframe)
      .order('timestamp', { ascending: true })
      .limit(500)

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

  const { TRADING_PAIRS } = await import('@/shared/lib/trading-pairs')
  const pairs = [...TRADING_PAIRS]
  const timeframes = ['5m', '15m', '1h', '4h', '1d']
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
