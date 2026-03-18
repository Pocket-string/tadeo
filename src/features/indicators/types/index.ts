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

export interface IndicatorConfig {
  emaFast: number
  emaSlow: number
  rsiPeriod: number
  macdFast: number
  macdSlow: number
  macdSignal: number
  bbPeriod: number
  bbStdDev: number
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
}
