'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { runBacktest } from '@/features/backtesting/services/backtestEngine'
import { runScientificBacktest, runWalkForward } from '@/features/backtesting/services/scientificBacktest'
import { reviewBacktest } from '@/features/backtesting/services/aiReview'
import { getCandles } from '@/features/market-data/services/marketDataService'
import type { StrategyParameters } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import type { ScientificBacktestOutput, WalkForwardResult, AIBacktestReview } from '@/features/backtesting/types'
import { z } from 'zod'

const RunBacktestSchema = z.object({
  strategyId: z.string().uuid(),
  symbol: z.string().min(1),
  timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  initialCapital: z.number().positive().default(10000),
})

export async function executeBacktest(input: {
  strategyId: string
  symbol: string
  timeframe: string
  startDate: string
  endDate: string
  initialCapital?: number
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const parsed = RunBacktestSchema.parse(input)

  // 1. Get strategy params
  const { data: strategy, error: stratError } = await supabase
    .from('strategies')
    .select('parameters')
    .eq('id', parsed.strategyId)
    .eq('user_id', user.id)
    .single()

  if (stratError || !strategy) throw new Error('Strategy not found')

  const params = strategy.parameters as StrategyParameters

  // 2. Get candles
  const candles = await getCandles({
    symbol: parsed.symbol,
    timeframe: parsed.timeframe as Timeframe,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
  })

  if (candles.length < 50) {
    throw new Error(`Not enough data: ${candles.length} candles (minimum 50)`)
  }

  // 3. Run backtest
  const output = runBacktest(candles, params, parsed.initialCapital)

  // 4. Save results
  const { data: btResult, error: btError } = await supabase
    .from('backtest_results')
    .insert({
      strategy_id: parsed.strategyId,
      status: 'completed',
      symbol: parsed.symbol,
      timeframe: parsed.timeframe,
      start_date: parsed.startDate,
      end_date: parsed.endDate,
      total_trades: output.metrics.totalTrades,
      winning_trades: output.metrics.winningTrades,
      losing_trades: output.metrics.losingTrades,
      win_rate: output.metrics.winRate,
      net_profit: output.metrics.netProfit,
      max_drawdown: output.metrics.maxDrawdown,
      sharpe_ratio: output.metrics.sharpeRatio,
      t_statistic: output.metrics.tStatistic,
      profit_factor: output.metrics.profitFactor,
    })
    .select('id')
    .single()

  if (btError) throw new Error(`Failed to save backtest: ${btError.message}`)

  // 5. Save trades (batch 200)
  if (output.trades.length > 0 && btResult) {
    const tradeRows = output.trades.map((t) => ({
      backtest_id: btResult.id,
      entry_time: t.entryTime,
      exit_time: t.exitTime,
      type: t.type,
      entry_price: t.entryPrice,
      exit_price: t.exitPrice,
      quantity: t.quantity,
      pnl: t.pnl,
      pnl_pct: t.pnlPct,
      exit_reason: t.exitReason,
    }))

    for (let i = 0; i < tradeRows.length; i += 200) {
      const batch = tradeRows.slice(i, i + 200)
      await supabase.from('backtest_trades').insert(batch)
    }
  }

  return {
    backtestId: btResult?.id,
    metrics: output.metrics,
    tradesCount: output.trades.length,
    equityCurve: output.equityCurve,
  }
}

/**
 * Execute scientific backtest with IS/OOS split + optional Walk-Forward + AI Review.
 */
export async function executeScientificBacktest(input: {
  strategyId: string
  symbol: string
  timeframe: string
  startDate: string
  endDate: string
  initialCapital?: number
  runWalkForwardAnalysis?: boolean
  runAIReview?: boolean
}): Promise<{
  scientific: ScientificBacktestOutput
  walkForward?: WalkForwardResult
  aiReview?: AIBacktestReview
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const parsed = RunBacktestSchema.parse(input)

  // 1. Get strategy
  const { data: strategy, error: stratError } = await supabase
    .from('strategies')
    .select('parameters')
    .eq('id', parsed.strategyId)
    .eq('user_id', user.id)
    .single()

  if (stratError || !strategy) throw new Error('Strategy not found')
  const params = strategy.parameters as StrategyParameters

  // 2. Get candles
  const candles = await getCandles({
    symbol: parsed.symbol,
    timeframe: parsed.timeframe as Timeframe,
    startDate: parsed.startDate,
    endDate: parsed.endDate,
  })

  if (candles.length < 100) {
    throw new Error(`Need at least 100 candles for scientific backtest (got ${candles.length})`)
  }

  // 3. Run scientific backtest (IS 70% / OOS 30%)
  const scientific = runScientificBacktest(candles, params, parsed.initialCapital)

  // 4. Optional Walk-Forward
  let walkForwardResult: WalkForwardResult | undefined
  if (input.runWalkForwardAnalysis && candles.length >= 350) {
    walkForwardResult = runWalkForward(candles, params, parsed.initialCapital, 5)
  }

  // 5. Optional AI Review
  let aiReview: AIBacktestReview | undefined
  if (input.runAIReview) {
    try {
      aiReview = await reviewBacktest(scientific, walkForwardResult, parsed.symbol, parsed.timeframe)
    } catch {
      // AI review is non-blocking: if it fails, continue without it
    }
  }

  // 6. Save OOS results to DB (the ones that matter)
  const oos = scientific.outOfSample.metrics
  await supabase
    .from('backtest_results')
    .insert({
      strategy_id: parsed.strategyId,
      status: 'completed',
      symbol: parsed.symbol,
      timeframe: parsed.timeframe,
      start_date: parsed.startDate,
      end_date: parsed.endDate,
      total_trades: oos.totalTrades,
      winning_trades: oos.winningTrades,
      losing_trades: oos.losingTrades,
      win_rate: oos.winRate,
      net_profit: oos.netProfit,
      max_drawdown: oos.maxDrawdown,
      sharpe_ratio: oos.sharpeRatio,
      t_statistic: oos.tStatistic,
      profit_factor: oos.profitFactor,
      is_out_of_sample: true,
    })

  return { scientific, walkForward: walkForwardResult, aiReview }
}

export async function getBacktestResults(strategyId?: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  let query = supabase
    .from('backtest_results')
    .select('*, strategies!inner(name, user_id)')
    .eq('strategies.user_id', user.id)
    .order('created_at', { ascending: false })

  if (strategyId) {
    query = query.eq('strategy_id', strategyId)
  }

  const { data, error } = await query.limit(50)

  if (error) throw new Error(`Failed to fetch backtests: ${error.message}`)
  return data ?? []
}

export async function getBacktestDetail(backtestId: string) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: bt, error: btError } = await supabase
    .from('backtest_results')
    .select('*, strategies!inner(name, user_id, parameters)')
    .eq('id', backtestId)
    .eq('strategies.user_id', user.id)
    .single()

  if (btError || !bt) throw new Error('Backtest not found')

  const { data: trades, error: trError } = await supabase
    .from('backtest_trades')
    .select('*')
    .eq('backtest_id', backtestId)
    .order('entry_time', { ascending: true })

  if (trError) throw new Error(`Failed to fetch trades: ${trError.message}`)

  return { ...bt, trades: trades ?? [] }
}
