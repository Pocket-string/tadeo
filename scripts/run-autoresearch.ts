/**
 * Karpathy Autoresearch Loop for Trading Strategy Optimization
 *
 * Mutates ONE parameter per iteration → simulates across N pairs →
 * binary eval (5 criteria) → keep if better, discard if not → log everything.
 *
 * Run with: npx tsx scripts/run-autoresearch.ts [--iterations 100] [--pairs SOLUSDT,BTCUSDT]
 */

import { createClient } from '@supabase/supabase-js'
import type { OHLCVCandle, Timeframe } from '../src/features/market-data/types'
import type { StrategyParameters } from '../src/types/database'
import { FULL_SIGNAL_CONFIG } from '../src/features/paper-trading/services/signalRegistry'
import { PAIR_CONFIG, TRADING_PAIRS } from '../src/shared/lib/trading-pairs'
import type { AutoresearchConfig, IterationResult } from '../src/features/autoresearch/types'
import { runAutoresearchLoop, getBestFromHistory } from '../src/features/autoresearch/services/autoresearchLoop'
import type { CandleMap } from '../src/features/autoresearch/services/autoresearchLoop'
import { IterationLogger } from '../src/features/autoresearch/services/iterationLogger'
import { DEFAULT_STRATEGY_PARAMS } from '../src/types/database'

// ─── Environment ────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

// ─── CLI Args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2)
  let iterations = 100
  let pairsFilter: string[] | null = null
  let monthsBack = 6
  let capital = 100

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--iterations' && args[i + 1]) {
      iterations = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--pairs' && args[i + 1]) {
      pairsFilter = args[i + 1].split(',').map(s => s.trim().toUpperCase())
      i++
    } else if (args[i] === '--months' && args[i + 1]) {
      monthsBack = parseInt(args[i + 1], 10)
      i++
    } else if (args[i] === '--capital' && args[i + 1]) {
      capital = parseFloat(args[i + 1])
      i++
    }
  }

  return { iterations, pairsFilter, monthsBack, capital }
}

// ─── Load Candles ───────────────────────────────────────────────────────────

async function loadCandles(
  pairs: { symbol: string; timeframe: Timeframe }[],
  monthsBack: number,
): Promise<CandleMap> {
  const candleMap: CandleMap = {}
  const startDate = new Date()
  startDate.setMonth(startDate.getMonth() - monthsBack)

  console.log(`\nLoading candles for ${pairs.length} pair(s)...`)

  for (const { symbol, timeframe } of pairs) {
    const key = `${symbol}:${timeframe}`
    const { data, error } = await supabase
      .from('ohlcv_candles')
      .select('timestamp, open, high, low, close, volume')
      .eq('symbol', symbol)
      .eq('timeframe', timeframe)
      .gte('timestamp', startDate.toISOString())
      .order('timestamp', { ascending: true })
      .limit(50000)

    if (error) {
      console.warn(`  ⚠ ${key}: ${error.message}`)
      continue
    }

    if (!data || data.length < 50) {
      console.warn(`  ⚠ ${key}: only ${data?.length ?? 0} candles (need ≥50), skipping`)
      continue
    }

    candleMap[key] = data as OHLCVCandle[]
    console.log(`  ✓ ${key}: ${data.length} candles`)
  }

  return candleMap
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const { iterations, pairsFilter, monthsBack, capital } = parseArgs()

  // Build pairs list from PAIR_CONFIG
  const allPairs = TRADING_PAIRS.map(symbol => ({
    symbol,
    timeframe: PAIR_CONFIG[symbol].defaultTimeframe as Timeframe,
  }))

  const pairs = pairsFilter
    ? allPairs.filter(p => pairsFilter.includes(p.symbol))
    : allPairs

  if (pairs.length === 0) {
    console.error('No valid pairs found. Available:', TRADING_PAIRS.join(', '))
    process.exit(1)
  }

  // Build base params with FULL_SIGNAL_CONFIG embedded
  const baseParams: StrategyParameters = {
    ...DEFAULT_STRATEGY_PARAMS,
    signal_systems: FULL_SIGNAL_CONFIG.map(s => ({ ...s })),
  }

  const config: AutoresearchConfig = {
    pairs,
    baseParams,
    maxIterations: iterations,
    targetScore: 5,
    capitalPerPair: capital,
    monthsBack,
  }

  // Print header
  console.log('\n' + '═'.repeat(65))
  console.log('  AUTORESEARCH: Karpathy Loop for Trading Strategy')
  console.log('  Pairs: ' + pairs.map(p => `${p.symbol}/${p.timeframe}`).join(', '))
  console.log(`  Capital: $${capital} | Iterations: ${iterations} | Target: 5/5`)
  console.log('═'.repeat(65) + '\n')

  // Load candles
  const candleMap = await loadCandles(pairs, monthsBack)

  const activePairs = pairs.filter(p => candleMap[`${p.symbol}:${p.timeframe}`])
  if (activePairs.length === 0) {
    console.error('\nNo pairs with sufficient candle data. Run candle ingestion first.')
    process.exit(1)
  }

  // Update config with only active pairs
  config.pairs = activePairs

  // Setup logger
  const runId = new Date().toISOString().slice(0, 19).replace(/[:-]/g, '')
  const logger = new IterationLogger('data/autoresearch', runId)
  logger.init()

  // Run the loop
  const history: IterationResult[] = []
  let interrupted = false

  // Handle Ctrl+C gracefully
  process.on('SIGINT', () => {
    if (!interrupted) {
      interrupted = true
      console.log('\n\n  Interrupted! Finishing current iteration...\n')
    }
  })

  const loop = runAutoresearchLoop(config, candleMap)

  for await (const result of loop) {
    history.push(result)
    logger.log(result)

    if (interrupted) break

    // Save best to Supabase periodically (every 10 iterations)
    if (result.iteration > 0 && result.iteration % 10 === 0) {
      await saveBestToSupabase(runId, history)
    }
  }

  // Final save + report
  await saveBestToSupabase(runId, history)
  logger.printReport(history)

  // Print best params for easy copy
  const { bestParams, bestScore } = getBestFromHistory(history)
  console.log('\n  Best params (copy to strategy):')
  console.log(JSON.stringify(bestParams, null, 2))
}

// ─── Supabase Persistence ───────────────────────────────────────────────────

async function saveBestToSupabase(runId: string, history: IterationResult[]) {
  if (history.length === 0) return

  const { bestParams, bestScore, keptIterations } = getBestFromHistory(history)
  const baseline = history[0]

  try {
    await supabase.from('autoresearch_runs').upsert({
      id: runId,
      config: {},
      baseline_score: baseline.score,
      final_score: bestScore,
      best_params: bestParams,
      iterations_total: history.length - 1,
      iterations_kept: keptIterations.length - 1, // exclude baseline
      status: bestScore >= 5 ? 'completed' : 'running',
    }, { onConflict: 'id' })
  } catch {
    // DB logging is best-effort, don't crash the loop
  }
}

// ─── Run ────────────────────────────────────────────────────────────────────

main().catch(err => {
  console.error('Fatal error:', err)
  process.exit(1)
})
