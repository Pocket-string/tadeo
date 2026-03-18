import type { StrategyParameters, SignalType } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'

export interface BacktestConfig {
  strategyId: string
  symbol: string
  timeframe: Timeframe
  startDate: string
  endDate: string
  parameters: StrategyParameters
  initialCapital: number
  isInSample: boolean
}

export interface BacktestTradeResult {
  entryTime: string
  exitTime: string
  type: SignalType
  entryPrice: number
  exitPrice: number
  quantity: number
  pnl: number
  pnlPct: number
  exitReason: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_period'
}

export interface BacktestMetrics {
  totalTrades: number
  winningTrades: number
  losingTrades: number
  winRate: number
  netProfit: number
  maxDrawdown: number
  sharpeRatio: number
  tStatistic: number
  profitFactor: number
}

export interface BacktestOutput {
  metrics: BacktestMetrics
  trades: BacktestTradeResult[]
  equityCurve: { timestamp: string; equity: number }[]
}

// --- Scientific Backtesting (Phase 4) ---

export interface ScientificBacktestOutput {
  inSample: BacktestOutput
  outOfSample: BacktestOutput
  combined: BacktestOutput
  splitIndex: number
  splitDate: string
  degradation: MetricDegradation
  semaphore: MetricSemaphore
}

export interface MetricDegradation {
  winRate: number       // (IS - OOS) / IS as percentage
  sharpeRatio: number
  profitFactor: number
  overall: number       // average degradation
}

export interface MetricSemaphore {
  tStatistic: 'green' | 'yellow' | 'red'
  winRate: 'green' | 'yellow' | 'red'
  sharpeRatio: 'green' | 'yellow' | 'red'
  maxDrawdown: 'green' | 'yellow' | 'red'
  profitFactor: 'green' | 'yellow' | 'red'
  degradation: 'green' | 'yellow' | 'red'
  overall: 'green' | 'yellow' | 'red'
}

export interface WalkForwardWindow {
  windowIndex: number
  trainStart: string
  trainEnd: string
  testStart: string
  testEnd: string
  trainMetrics: BacktestMetrics
  testMetrics: BacktestMetrics
}

export interface WalkForwardResult {
  windows: WalkForwardWindow[]
  aggregateTestMetrics: BacktestMetrics
  consistency: number  // % of windows where test is profitable
}

export interface AIBacktestReview {
  verdict: 'approve' | 'caution' | 'reject'
  confidence: number
  summary: string
  strengths: string[]
  weaknesses: string[]
  overfittingRisk: 'low' | 'medium' | 'high'
  recommendation: string
}
