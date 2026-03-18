// ============================================
// TIPOS DEL DOMINIO - Trading Algoritmico
// ============================================

export type UserRole = 'trader' | 'admin'

export interface Profile {
  id: string
  email: string
  full_name: string | null
  avatar_url: string | null
  role: UserRole
  created_at: string
  updated_at: string
}

// ============================================
// Datos de Mercado (OHLCV)
// ============================================

export interface OHLCVCandle {
  id: string
  symbol: string
  timeframe: Timeframe
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume: number
  created_at: string
}

export type Timeframe = '1m' | '5m' | '15m' | '30m' | '1h' | '4h' | '1d' | '1w'

// ============================================
// Indicadores Tecnicos
// ============================================

export interface IndicatorValue {
  timestamp: string
  value: number
}

export interface MACDValue {
  timestamp: string
  macd: number
  signal: number
  histogram: number
}

export interface BollingerBandsValue {
  timestamp: string
  upper: number
  middle: number
  lower: number
  bandwidth: number
}

// ============================================
// Senales de Trading
// ============================================

export type SignalType = 'buy' | 'sell'
export type SignalStrength = 'weak' | 'moderate' | 'strong'

export interface TradingSignal {
  id: string
  symbol: string
  timestamp: string
  type: SignalType
  strength: SignalStrength
  price: number
  indicators: SignalIndicators
  confidence: number // 0-1
  created_at: string
}

export interface SignalIndicators {
  ema_cross: boolean
  macd_cross: boolean
  rsi_oversold: boolean
  rsi_overbought: boolean
  bollinger_squeeze: boolean
}

// ============================================
// Estrategias
// ============================================

export type StrategyStatus = 'draft' | 'backtesting' | 'validated' | 'live' | 'paused' | 'retired'

export interface Strategy {
  id: string
  user_id: string
  name: string
  description: string | null
  status: StrategyStatus
  parameters: StrategyParameters
  created_at: string
  updated_at: string
}

export interface StrategyParameters {
  ema_fast: number      // e.g. 9
  ema_slow: number      // e.g. 21
  rsi_period: number    // e.g. 14
  rsi_oversold: number  // e.g. 30
  rsi_overbought: number // e.g. 70
  macd_fast: number     // e.g. 12
  macd_slow: number     // e.g. 26
  macd_signal: number   // e.g. 9
  bb_period: number     // e.g. 20
  bb_std_dev: number    // e.g. 2
  stop_loss_pct: number // e.g. 0.02 (2%)
  take_profit_pct: number // e.g. 0.04 (4%)
}

// ============================================
// Backtesting
// ============================================

export type BacktestStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface BacktestResult {
  id: string
  strategy_id: string
  status: BacktestStatus
  symbol: string
  timeframe: Timeframe
  start_date: string
  end_date: string
  // Metricas de rendimiento
  total_trades: number
  winning_trades: number
  losing_trades: number
  win_rate: number          // 0-1
  net_profit: number
  max_drawdown: number      // 0-1
  sharpe_ratio: number
  t_statistic: number       // > 3.0 = estadisticamente significativo
  profit_factor: number
  // Metadata
  is_in_sample: boolean
  is_out_of_sample: boolean
  created_at: string
}

export interface BacktestTrade {
  id: string
  backtest_id: string
  entry_time: string
  exit_time: string
  type: SignalType
  entry_price: number
  exit_price: number
  quantity: number
  pnl: number
  pnl_pct: number
  exit_reason: 'signal' | 'stop_loss' | 'take_profit' | 'end_of_period'
}

// ============================================
// Ordenes (Paper Trading / Live)
// ============================================

export type OrderStatus = 'pending' | 'filled' | 'cancelled' | 'rejected'
export type OrderType = 'market' | 'limit' | 'stop' | 'stop_limit'

export interface Order {
  id: string
  strategy_id: string
  symbol: string
  type: OrderType
  side: SignalType
  quantity: number
  price: number | null       // null for market orders
  stop_price: number | null
  status: OrderStatus
  filled_price: number | null
  filled_at: string | null
  is_paper: boolean          // true = paper trading
  created_at: string
  updated_at: string
}

// ============================================
// Constantes por defecto (NO hardcodear en codigo)
// ============================================

export const DEFAULT_STRATEGY_PARAMS: StrategyParameters = {
  ema_fast: 9,
  ema_slow: 21,
  rsi_period: 14,
  rsi_oversold: 30,
  rsi_overbought: 70,
  macd_fast: 12,
  macd_slow: 26,
  macd_signal: 9,
  bb_period: 20,
  bb_std_dev: 2,
  stop_loss_pct: 0.02,
  take_profit_pct: 0.04,
}

// ============================================
// Permisos por Rol
// ============================================

export const ROLE_PERMISSIONS = {
  admin: {
    canViewAllStrategies: true,
    canManageUsers: true,
    canViewAnalytics: true,
    canExecuteLive: true,
  },
  trader: {
    canViewAllStrategies: false,
    canManageUsers: false,
    canViewAnalytics: true,
    canExecuteLive: false,
  },
} as const

export type Permission = keyof typeof ROLE_PERMISSIONS.admin

export function hasPermission(role: UserRole, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role][permission]
}
