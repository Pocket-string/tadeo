export interface EMAResult {
  timestamp: string
  value: number
}

export interface MACDResult {
  timestamp: string
  macd: number
  signal: number
  histogram: number
}

export interface RSIResult {
  timestamp: string
  value: number
}

export interface BollingerBandsResult {
  timestamp: string
  upper: number
  middle: number
  lower: number
  bandwidth: number
}

export interface ATRResult {
  timestamp: string
  value: number
}

export interface ADXResult {
  timestamp: string
  adx: number
  plusDI: number
  minusDI: number
}

export type MarketRegime = 'trending' | 'ranging' | 'volatile' | 'choppy'

export interface RegimeResult {
  regime: MarketRegime
  adx: number
  atrRatio: number // current ATR / avg ATR
  emaCrossCount: number // crosses in last 20 candles
  confidence: number // 0-1
}

export interface IndicatorConfig {
  emaFast: number
  emaSlow: number
  rsiPeriod: number
  macdFast: number
  macdSlow: number
  macdSignal: number
  bbPeriod: number
  bbStdDev: number
  atrPeriod: number
  adxPeriod: number
}

export const DEFAULT_INDICATOR_CONFIG: IndicatorConfig = {
  emaFast: 9,
  emaSlow: 21,
  rsiPeriod: 14,
  macdFast: 12,
  macdSlow: 26,
  macdSignal: 9,
  bbPeriod: 20,
  bbStdDev: 2,
  atrPeriod: 14,
  adxPeriod: 14,
}
