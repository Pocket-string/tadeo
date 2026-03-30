import type { StrategyParameters } from '@/types/database'
import type { OHLCVCandle } from '@/features/market-data/types'
import { simulateOnCandles } from '@/features/paper-trading/services/turboSimulator'
import { evaluatePair, aggregatePairResults } from './binaryEval'
import { mutateSingle } from './singleMutator'
import type {
  AutoresearchConfig,
  IterationResult,
  PairResult,
  IterationStatus,
} from '../types'

// ─── Karpathy Autoresearch Loop ─────────────────────────────────────────────
// Autonomous loop: mutate ONE param → simulate on N pairs → binary eval → keep/discard

export interface CandleMap {
  [key: string]: OHLCVCandle[] // key = "SYMBOL:TIMEFRAME"
}

/**
 * Run the full autoresearch loop as an AsyncGenerator.
 * Yields one IterationResult per completed iteration (for real-time logging).
 */
export async function* runAutoresearchLoop(
  config: AutoresearchConfig,
  candleMap: CandleMap,
): AsyncGenerator<IterationResult> {
  const { pairs, baseParams, maxIterations, targetScore, capitalPerPair } = config

  // ── Baseline (iteration 0) ──
  const baselinePairs = await evaluateAllPairs(pairs, baseParams, capitalPerPair, candleMap)
  const { score: baselineScore, aggregate: baselineAgg } = aggregatePairResults(baselinePairs)

  const baselineResult: IterationResult = {
    iteration: 0,
    score: baselineScore,
    maxScore: 5,
    pct: baselineScore / 5,
    status: 'baseline',
    hypothesis: 'Initial parameters (no mutation)',
    category: 'baseline',
    paramKey: '-',
    oldValue: '-',
    newValue: '-',
    pairResults: baselinePairs,
    aggregate: baselineAgg,
    paramsSnapshot: { ...baseParams },
    durationMs: 0,
  }
  yield baselineResult

  // ── Loop State ──
  let bestScore = baselineScore
  let bestParams = { ...baseParams }
  let bestPairResults = baselinePairs
  let bestAvgPnlPct = baselineAgg.avgNetPnlPct
  let consecutiveDiscards = 0

  // ── Autonomous Loop ──
  for (let iter = 1; iter <= maxIterations; iter++) {
    const start = performance.now()
    let status: IterationStatus = 'discard'

    try {
      // MUTATE — one change
      const mutation = mutateSingle(bestParams)

      // GENERATE — simulate across all pairs
      const pairResults = await evaluateAllPairs(
        pairs, mutation.params, capitalPerPair, candleMap,
      )
      const { score, aggregate } = aggregatePairResults(pairResults, bestPairResults)

      // DECIDE — keep if better (conservative: no pair degraded by >1)
      const shouldKeep = score > bestScore
        || (score === bestScore && aggregate.avgNetPnlPct > bestAvgPnlPct && aggregate.pairsDegraded === 0)

      if (shouldKeep) {
        bestScore = score
        bestParams = { ...mutation.params }
        bestPairResults = pairResults
        bestAvgPnlPct = aggregate.avgNetPnlPct
        status = 'keep'
        consecutiveDiscards = 0
      } else {
        status = 'discard'
        consecutiveDiscards++
      }

      const durationMs = Math.round(performance.now() - start)

      yield {
        iteration: iter,
        score: shouldKeep ? score : bestScore,
        maxScore: 5,
        pct: (shouldKeep ? score : bestScore) / 5,
        status,
        hypothesis: mutation.hypothesis,
        category: mutation.category,
        paramKey: mutation.paramKey,
        oldValue: String(mutation.oldValue),
        newValue: String(mutation.newValue),
        pairResults,
        aggregate,
        paramsSnapshot: shouldKeep ? { ...mutation.params } : { ...bestParams },
        durationMs,
      }

      // Check if target reached
      if (bestScore >= targetScore) {
        return // Generator completes
      }
    } catch (err) {
      const durationMs = Math.round(performance.now() - start)
      yield {
        iteration: iter,
        score: bestScore,
        maxScore: 5,
        pct: bestScore / 5,
        status: 'crash',
        hypothesis: `Error: ${err instanceof Error ? err.message : String(err)}`,
        category: 'baseline',
        paramKey: '-',
        oldValue: '-',
        newValue: '-',
        pairResults: [],
        aggregate: {
          avgWinRate: 0, avgNetPnlPct: 0, avgSharpe: 0,
          worstDrawdown: 0, totalTrades: 0, pairsImproved: 0, pairsDegraded: 0,
        },
        paramsSnapshot: { ...bestParams },
        durationMs,
      }
    }
  }
}

/**
 * Get the best params found by the loop (call after generator completes).
 */
export function getBestFromHistory(history: IterationResult[]): {
  bestParams: StrategyParameters
  bestScore: number
  keptIterations: IterationResult[]
} {
  const kept = history.filter(h => h.status === 'keep' || h.status === 'baseline')
  const best = kept.reduce((a, b) => (a.score >= b.score ? a : b), kept[0])
  return {
    bestParams: best.paramsSnapshot,
    bestScore: best.score,
    keptIterations: kept,
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function evaluateAllPairs(
  pairs: AutoresearchConfig['pairs'],
  params: StrategyParameters,
  capital: number,
  candleMap: CandleMap,
): Promise<PairResult[]> {
  const results: PairResult[] = []

  for (const { symbol, timeframe } of pairs) {
    const key = `${symbol}:${timeframe}`
    const candles = candleMap[key]
    if (!candles || candles.length < 50) continue

    const simResult = await simulateOnCandles(candles, params, capital, symbol, timeframe)
    results.push(evaluatePair(simResult))
  }

  return results
}
