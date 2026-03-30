import type { StrategyParameters } from '@/types/database'
import type { SignalSystemConfig } from '@/features/paper-trading/services/signalRegistry'
import type { Timeframe } from '@/features/market-data/types'

// ─── Config ─────────────────────────────────────────────────────────────────

export interface AutoresearchConfig {
  /** Pairs to evaluate on (varied inputs — Karpathy principle) */
  pairs: { symbol: string; timeframe: Timeframe }[]
  /** Starting strategy parameters */
  baseParams: StrategyParameters
  /** Max iterations before stopping */
  maxIterations: number
  /** Target binary score (default: 5 = all criteria pass) */
  targetScore: number
  /** Simulated capital per pair */
  capitalPerPair: number
  /** Months of historical data to use */
  monthsBack: number
}

// ─── Mutation ───────────────────────────────────────────────────────────────

export type MutationCategory =
  | 'weight'      // Signal weight adjustment
  | 'sl_tp'       // Stop loss / take profit multipliers
  | 'indicator'   // Indicator periods (EMA, RSI, MACD, BB)
  | 'toggle'      // Signal enable/disable
  | 'threshold'   // Composite confidence threshold
  | 'trailing'    // Trailing stop config

export interface MutationResult {
  params: StrategyParameters
  hypothesis: string
  category: MutationCategory
  paramKey: string
  oldValue: number | boolean | string
  newValue: number | boolean | string
}

// ─── Evaluation ─────────────────────────────────────────────────────────────

export interface BinaryEvalResult {
  /** Which criteria passed [profitable, winRate, sharpe, drawdown, trades] */
  passed: boolean[]
  /** Count of passed criteria (0-5) */
  score: number
  /** Max possible score */
  maxScore: number
  /** Labels for each criterion */
  labels: string[]
}

export interface PairResult {
  symbol: string
  timeframe: string
  trades: number
  winRate: number
  netPnlPct: number
  sharpeRatio: number
  maxDrawdown: number
  profitFactor: number
  eval: BinaryEvalResult
}

export interface AggregateMetrics {
  avgWinRate: number
  avgNetPnlPct: number
  avgSharpe: number
  worstDrawdown: number
  totalTrades: number
  /** How many pairs improved vs previous best */
  pairsImproved: number
  pairsDegraded: number
}

// ─── Iteration ──────────────────────────────────────────────────────────────

export type IterationStatus = 'baseline' | 'keep' | 'discard' | 'crash'

export interface IterationResult {
  iteration: number
  score: number
  maxScore: number
  pct: number
  status: IterationStatus
  hypothesis: string
  category: MutationCategory | 'baseline'
  paramKey: string
  oldValue: string
  newValue: string
  pairResults: PairResult[]
  aggregate: AggregateMetrics
  paramsSnapshot: StrategyParameters
  durationMs: number
}

// ─── Run ────────────────────────────────────────────────────────────────────

export interface AutoresearchRun {
  id: string
  config: AutoresearchConfig
  baselineScore: number
  finalScore: number | null
  bestParams: StrategyParameters | null
  iterationsTotal: number
  iterationsKept: number
  status: 'running' | 'completed' | 'stopped'
  history: IterationResult[]
}
