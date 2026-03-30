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
