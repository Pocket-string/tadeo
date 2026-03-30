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

// Timeframes optimized by fee-to-reward ratio (2026-03-29 analysis)
// With $100 capital and 0.1% Binance fees:
//   15m: fee/reward > 18% for ALL pairs — INVIABLE
//   1h:  fee/reward 8-10% for high-vol altcoins — viable
//   4h:  fee/reward 3-6% for all pairs — sweet spot
export const PAIR_CONFIG: Record<TradingPair, PairConfig> = {
  BTCUSDT:  { tier: 'large', defaultTimeframe: '4h',  riskTier: 'conservative' },
  ETHUSDT:  { tier: 'large', defaultTimeframe: '4h',  riskTier: 'moderate' },
  SOLUSDT:  { tier: 'mid',   defaultTimeframe: '1h',  riskTier: 'moderate' },
  XRPUSDT:  { tier: 'mid',   defaultTimeframe: '4h',  riskTier: 'conservative' },
  BNBUSDT:  { tier: 'mid',   defaultTimeframe: '4h',  riskTier: 'conservative' },
  DOGEUSDT: { tier: 'small', defaultTimeframe: '1h',  riskTier: 'moderate' },
  ADAUSDT:  { tier: 'small', defaultTimeframe: '1h',  riskTier: 'moderate' },
  LINKUSDT: { tier: 'small', defaultTimeframe: '1h',  riskTier: 'moderate' },
  SUIUSDT:  { tier: 'small', defaultTimeframe: '1h',  riskTier: 'conservative' },
  AVAXUSDT: { tier: 'small', defaultTimeframe: '1h',  riskTier: 'moderate' },
}

/** Get the higher-timeframe used for trend bias, given a primary timeframe */
export function getHTFTimeframe(primaryTf: string): string {
  return (primaryTf === '4h' || primaryTf === '1d') ? '1d' : '4h'
}

/** Get all timeframes needed for a pair (primary + HTF for bias) */
export function getPairTimeframes(symbol: TradingPair): string[] {
  const primary = PAIR_CONFIG[symbol].defaultTimeframe
  const htf = getHTFTimeframe(primary)
  return primary === htf ? [primary] : [primary, htf]
}
