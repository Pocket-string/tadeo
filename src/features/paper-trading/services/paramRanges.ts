/**
 * Discrete parameter ranges for strategy optimization.
 * Shared between turboSimulator (genetic), singleMutator (Karpathy), and scanner.
 * Extracted from turboSimulator.ts because 'use server' files cannot export non-async values.
 */
export const PARAM_RANGES = {
  ema_fast: [3, 5, 7, 9, 12, 15, 20],
  ema_slow: [15, 20, 21, 26, 30, 40, 50, 60],
  rsi_period: [7, 10, 14, 21],
  rsi_oversold: [20, 25, 30, 35],
  rsi_overbought: [65, 70, 75, 80],
  macd_fast: [8, 10, 12, 15],
  macd_slow: [20, 24, 26, 30],
  macd_signal: [7, 9, 12],
  bb_period: [14, 20, 25],
  bb_std_dev: [1.5, 2, 2.5],
  // KEY INSIGHT: tight SL + wide TP = let winners run, cut losers fast
  stop_loss_pct: [0.5, 0.7, 0.8, 1.0, 1.2, 1.5],  // ATR multipliers (tighter)
  take_profit_pct: [2.0, 2.5, 3.0, 4.0, 5.0, 6.0, 8.0], // ATR multipliers (wider)
} as const

// ─── Signal System Weight Ranges ──────────────────────────────────────────────
// Based on live trade performance data (234 trades, 2026-03-24 analysis):
// - ema-cross:long WR 87.5% → proven, keep high
// - bb-mean-rev:long 13W/0L → star signal
// - adx-trend:short WR 7.1% → toxic
// - double-pattern:short WR 33% → toxic
// - rsi-divergence:long WR 25.8% → toxic
export const SIGNAL_WEIGHT_RANGES: Record<string, readonly number[]> = {
  'ema-cross':       [0.3, 0.5, 0.8, 1.0, 1.2, 1.5],
  'bb-mean-rev':     [0.3, 0.5, 0.8, 1.0, 1.3, 1.5],
  'adx-trend':       [0.2, 0.3, 0.5, 0.8, 1.0, 1.2],
  'double-pattern':  [0.2, 0.3, 0.5, 0.8, 1.0],
  'rsi-divergence':  [0.2, 0.3, 0.4, 0.5, 0.7, 1.0],
  'volume-confirm':  [0.5, 0.8, 1.0, 1.2],
  'engulfing-sr':    [0.3, 0.5, 0.8, 1.0, 1.3, 1.5],
} as const

// Trailing stop mode options
export const TRAILING_STOP_MODES = ['atr', 'ema'] as const
export const TRAILING_EMA_PERIODS = [10, 15, 20, 30, 40] as const

// All 7 signal system IDs
export const SIGNAL_IDS = [
  'ema-cross', 'bb-mean-rev', 'adx-trend', 'double-pattern',
  'rsi-divergence', 'volume-confirm', 'engulfing-sr',
] as const
