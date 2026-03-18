import { z } from 'zod'

export const TimeframeSchema = z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'])
export type Timeframe = z.infer<typeof TimeframeSchema>

export const OHLCVCandleSchema = z.object({
  timestamp: z.string(),
  open: z.number(),
  high: z.number(),
  low: z.number(),
  close: z.number(),
  volume: z.number(),
})

export type OHLCVCandle = z.infer<typeof OHLCVCandleSchema>

export const ImportCandlesSchema = z.object({
  symbol: z.string().min(1).max(20),
  timeframe: TimeframeSchema,
  candles: z.array(OHLCVCandleSchema).min(1),
})

export type ImportCandlesInput = z.infer<typeof ImportCandlesSchema>

export interface MarketDataQuery {
  symbol: string
  timeframe: Timeframe
  startDate: string
  endDate: string
  limit?: number
}
