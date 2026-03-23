// ============================================
// Single source of truth for all trading pairs
// ============================================

export const TRADING_PAIRS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'BNBUSDT',
  'DOGEUSDT', 'ADAUSDT', 'LINKUSDT', 'SUIUSDT', 'AVAXUSDT',
] as const

export type TradingPair = (typeof TRADING_PAIRS)[number]

export interface PairConfig {
  tier: 'large' | 'mid' | 'small'
  defaultTimeframe: string
  riskTier: 'conservative' | 'moderate' | 'aggressive'
}

export const PAIR_CONFIG: Record<TradingPair, PairConfig> = {
  BTCUSDT:  { tier: 'large', defaultTimeframe: '1h',  riskTier: 'moderate' },
  ETHUSDT:  { tier: 'large', defaultTimeframe: '1h',  riskTier: 'moderate' },
  SOLUSDT:  { tier: 'mid',   defaultTimeframe: '5m',  riskTier: 'moderate' },
  XRPUSDT:  { tier: 'mid',   defaultTimeframe: '15m', riskTier: 'conservative' },
  BNBUSDT:  { tier: 'mid',   defaultTimeframe: '15m', riskTier: 'moderate' },
  DOGEUSDT: { tier: 'small', defaultTimeframe: '15m', riskTier: 'conservative' },
  ADAUSDT:  { tier: 'small', defaultTimeframe: '15m', riskTier: 'conservative' },
  LINKUSDT: { tier: 'small', defaultTimeframe: '15m', riskTier: 'conservative' },
  SUIUSDT:  { tier: 'small', defaultTimeframe: '15m', riskTier: 'conservative' },
  AVAXUSDT: { tier: 'small', defaultTimeframe: '15m', riskTier: 'conservative' },
}
