import type { Timeframe } from '@/features/market-data/types'
import type { RegimeResult } from '@/features/indicators/types'
import type { BacktestMetrics } from '@/features/backtesting/types'

export interface ScannerConfig {
  pairs: string[]
  timeframes: Timeframe[]
  minScore: number // 0-100, default 60
  maxResults: number // default 10
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'DOGEUSDT', 'ADAUSDT', 'AVAXUSDT'],
  timeframes: ['1h', '4h'],
  minScore: 40,
  maxResults: 10,
}

export interface OpportunityScore {
  trend: number      // 0-100: ADX strength + EMA alignment
  momentum: number   // 0-100: RSI positioning + MACD histogram
  volatility: number // 0-100: ATR in goldilocks zone
  volume: number     // 0-100: Volume vs 20-period avg
  riskReward: number // 0-100: R:R ratio quality
  total: number      // 0-100: weighted average
}

export interface Opportunity {
  symbol: string
  timeframe: Timeframe
  signal: 'buy' | 'sell'
  price: number
  score: OpportunityScore
  regime: RegimeResult
  stopLoss: number
  takeProfit: number
  riskRewardRatio: number
  atr: number
  compositeConfidence: number // 0-1, from 7-signal composite system
  activeSignals: string[] // e.g. ['ema-cross:long(75%)', 'bb-mean-rev:long(60%)']
  indicators: {
    emaFast: number
    emaSlow: number
    rsi: number
    macdHistogram: number
    adx: number
    bbPosition: number // 0-1, where in Bollinger Bands
  }
  quickBacktest?: {
    metrics: BacktestMetrics
    sampleSize: number
  }
  timestamp: string
}

export interface ScanResult {
  opportunities: Opportunity[]
  scannedPairs: number
  scannedTimeframes: number
  scanDuration: number // ms
  timestamp: string
}
