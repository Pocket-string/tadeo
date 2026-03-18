import { z } from 'zod'

export const MarketAnalysisSchema = z.object({
  trend: z.object({
    direction: z.enum(['bullish', 'bearish', 'neutral']),
    strength: z.enum(['strong', 'moderate', 'weak']),
    description: z.string(),
  }),
  momentum: z.object({
    rsiZone: z.enum(['overbought', 'neutral', 'oversold']),
    macdSignal: z.string().transform(v => {
      // Normalize AI responses to valid enum values
      const lower = v.toLowerCase().replace(/\s+/g, '_')
      const map: Record<string, string> = {
        bullish_cross: 'bullish_cross', bearish_cross: 'bearish_cross',
        converging: 'converging', diverging: 'diverging', neutral: 'neutral',
        bullish: 'converging', bearish: 'diverging',
        positive: 'converging', negative: 'diverging',
        bullish_momentum: 'converging', bearish_momentum: 'diverging',
      }
      return map[lower] ?? 'neutral'
    }),
    description: z.string(),
  }),
  volatility: z.object({
    state: z.enum(['squeeze', 'expanding', 'normal']),
    bbWidth: z.number(),
    description: z.string(),
  }),
  volumeAnalysis: z.string(),
  overallBias: z.enum(['strong_buy', 'buy', 'neutral', 'sell', 'strong_sell']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
})

export type MarketAnalysis = z.infer<typeof MarketAnalysisSchema>

// Normalize percentage values: if AI returns 3 (meaning 3%), convert to 0.03
const normalizePercent = (val: number, maxAsDecimal: number) =>
  val > maxAsDecimal * 2 ? val / 100 : val

export const StrategyProposalSchema = z.object({
  name: z.string(),
  description: z.string(),
  parameters: z.object({
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
    stop_loss_pct: z.number().transform(v => normalizePercent(v, 0.1)).pipe(z.number().min(0.005).max(0.1)),
    take_profit_pct: z.number().transform(v => normalizePercent(v, 0.2)).pipe(z.number().min(0.01).max(0.2)),
  }),
  reasoning: z.string(),
  riskLevel: z.enum(['conservative', 'moderate', 'aggressive']),
  suitableTimeframes: z.array(z.string()),
})

export type StrategyProposal = z.infer<typeof StrategyProposalSchema>

export interface AnalysisRequest {
  symbol: string
  timeframe: string
  candleCount: number
}

export interface AnalysisContext {
  symbol: string
  timeframe: string
  lastPrice: number
  priceChange24h: number
  emaFastValue: number
  emaSlowValue: number
  emaAlignment: string
  rsiValue: number
  macdHistogram: number
  macdCrossing: string
  bbUpper: number
  bbLower: number
  bbWidth: number
  bbPosition: string
  avgVolume: number
  lastVolume: number
  volumeRatio: number
  candleCount: number
}
