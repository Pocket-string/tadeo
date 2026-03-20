import { z } from 'zod'
import type { StrategyParameters } from '@/types/database'
import type { SignalSystemConfig } from '@/features/paper-trading/services/signalRegistry'

export interface StrategyHypothesis {
  symbol: string
  timeframe: string
  signalConfig: SignalSystemConfig[]
  baseParams: StrategyParameters
  rationale: string
}

export interface DiscoveryResult {
  hypothesis: StrategyHypothesis
  backtestMetrics: {
    totalTrades: number
    winRate: number
    netPnlPct: number
    profitFactor: number
    maxDrawdown: number
    sharpeRatio: number
    tradesPerMonth: number
  }
  score: number
  aiReview: {
    verdict: 'approve' | 'caution' | 'reject'
    confidence: number
    summary: string
    overfittingRisk: 'low' | 'medium' | 'high'
  }
  optimizedParams: StrategyParameters
}

export interface ProposalRecord {
  id: string
  user_id: string
  symbol: string
  timeframe: string
  signal_config: SignalSystemConfig[]
  optimized_params: StrategyParameters
  backtest_results: DiscoveryResult['backtestMetrics']
  ai_rationale: string
  ai_review_verdict: string
  score: number
  status: 'pending' | 'approved' | 'rejected' | 'deployed'
  created_at: string
  reviewed_at: string | null
  deployed_session_id: string | null
}

export const HypothesisResponseSchema = z.object({
  hypotheses: z.array(z.object({
    signalSystems: z.array(z.object({
      id: z.string(),
      weight: z.number().min(0).max(2),
      enabled: z.boolean(),
    })),
    params: z.object({
      ema_fast: z.number().int().min(3).max(50),
      ema_slow: z.number().int().min(10).max(200),
      rsi_period: z.number().int().min(5).max(30),
      rsi_overbought: z.number().min(60).max(90),
      rsi_oversold: z.number().min(10).max(40),
      macd_fast: z.number().int().min(5).max(20),
      macd_slow: z.number().int().min(15).max(50),
      macd_signal: z.number().int().min(5).max(15),
      bb_period: z.number().int().min(10).max(30),
      bb_std_dev: z.number().min(1).max(3),
      stop_loss_pct: z.number().min(0.3).max(3),
      take_profit_pct: z.number().min(1).max(10),
    }),
    rationale: z.string(),
  })),
})

export type HypothesisResponse = z.infer<typeof HypothesisResponseSchema>
