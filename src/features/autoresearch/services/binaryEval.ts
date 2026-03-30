import type { SimResult } from '@/features/paper-trading/services/turboSimulator'
import type { BinaryEvalResult, PairResult, AggregateMetrics } from '../types'

// ─── Binary Evaluation Criteria ─────────────────────────────────────────────
// Calibrated for $100 capital, 0.2% roundtrip Binance fees.
// Each criterion is pass/fail — never continuous scales (Karpathy principle).

const CRITERIA = [
  { label: 'profitable', test: (m: SimResult['metrics']) => m.netPnlPct > 0 },
  { label: 'winRate≥42%', test: (m: SimResult['metrics']) => m.winRate >= 0.42 },
  { label: 'sharpe>0', test: (m: SimResult['metrics']) => m.sharpeRatio > 0 },
  { label: 'DD<20%', test: (m: SimResult['metrics']) => m.maxDrawdown < 0.20 },
  { label: 'trades≥15', test: (m: SimResult['metrics']) => m.totalTrades >= 15 },
] as const

/**
 * Evaluate a single SimResult against 5 binary criteria.
 */
export function evaluateBinary(result: SimResult): BinaryEvalResult {
  const passed = CRITERIA.map(c => c.test(result.metrics))
  return {
    passed,
    score: passed.filter(Boolean).length,
    maxScore: CRITERIA.length,
    labels: CRITERIA.map(c => c.label),
  }
}

/**
 * Evaluate a SimResult and return a full PairResult.
 */
export function evaluatePair(result: SimResult): PairResult {
  return {
    symbol: result.symbol,
    timeframe: result.timeframe,
    trades: result.metrics.totalTrades,
    winRate: result.metrics.winRate,
    netPnlPct: result.metrics.netPnlPct,
    sharpeRatio: result.metrics.sharpeRatio,
    maxDrawdown: result.metrics.maxDrawdown,
    profitFactor: result.metrics.profitFactor,
    eval: evaluateBinary(result),
  }
}

/**
 * Aggregate results across multiple pairs.
 * Score = minimum score across all pairs (conservative — weakest link).
 */
export function aggregatePairResults(
  pairResults: PairResult[],
  previousBest?: PairResult[],
): { score: number; aggregate: AggregateMetrics } {
  const n = pairResults.length
  if (n === 0) return { score: 0, aggregate: emptyAggregate() }

  // Conservative: use minimum score across pairs (not average)
  const score = Math.min(...pairResults.map(p => p.eval.score))

  // Count improvements vs degradations
  let pairsImproved = 0
  let pairsDegraded = 0
  if (previousBest) {
    for (const pr of pairResults) {
      const prev = previousBest.find(p => p.symbol === pr.symbol && p.timeframe === pr.timeframe)
      if (prev) {
        if (pr.eval.score > prev.eval.score) pairsImproved++
        else if (pr.eval.score < prev.eval.score) pairsDegraded++
      }
    }
  }

  return {
    score,
    aggregate: {
      avgWinRate: pairResults.reduce((s, p) => s + p.winRate, 0) / n,
      avgNetPnlPct: pairResults.reduce((s, p) => s + p.netPnlPct, 0) / n,
      avgSharpe: pairResults.reduce((s, p) => s + p.sharpeRatio, 0) / n,
      worstDrawdown: Math.max(...pairResults.map(p => p.maxDrawdown)),
      totalTrades: pairResults.reduce((s, p) => s + p.trades, 0),
      pairsImproved,
      pairsDegraded,
    },
  }
}

function emptyAggregate(): AggregateMetrics {
  return {
    avgWinRate: 0,
    avgNetPnlPct: 0,
    avgSharpe: 0,
    worstDrawdown: 0,
    totalTrades: 0,
    pairsImproved: 0,
    pairsDegraded: 0,
  }
}
