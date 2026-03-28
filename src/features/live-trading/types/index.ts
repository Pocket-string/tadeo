// ============================================
// Live Trading Types
// ============================================

export type LiveSessionStatus = 'active' | 'paused' | 'stopped' | 'emergency'

export interface LiveSession {
  id: string
  user_id: string
  strategy_id: string
  symbol: string
  timeframe: string
  status: LiveSessionStatus
  initial_capital: number
  current_capital: number
  total_trades: number
  winning_trades: number
  net_pnl: number
  max_drawdown_pct: number
  risk_tier: 'conservative' | 'moderate' | 'aggressive' | null
  started_at: string
  stopped_at: string | null
  paused_at: string | null
  pause_reason: string | null
  created_at: string
}

export interface LiveTrade {
  id: string
  user_id: string
  session_id: string
  strategy_id: string
  symbol: string
  type: 'buy' | 'sell'
  status: 'open' | 'closed' | 'cancelled'
  entry_price: number
  exit_price: number | null
  quantity: number
  stop_loss: number
  take_profit: number
  pnl: number
  pnl_pct: number
  entry_time: string
  exit_time: string | null
  exit_reason: string | null
  exchange_order_id: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

// ============================================
// Risk Management
// ============================================

export interface RiskConfig {
  maxPositionSizePct: number     // Max % of capital per trade (e.g., 0.02 = 2%)
  maxDailyDrawdownPct: number    // Pause if daily DD exceeds this (e.g., 0.05 = 5%)
  maxTotalDrawdownPct: number    // Kill switch if total DD exceeds this (e.g., 0.15 = 15%)
  maxOpenPositions: number       // Max concurrent open positions
  maxDailyTrades: number         // Max trades per day
  cooldownAfterLossStreak: number // Pause after N consecutive losses
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  maxPositionSizePct: 0.02,
  maxDailyDrawdownPct: 0.05,
  maxTotalDrawdownPct: 0.15,
  maxOpenPositions: 3,
  maxDailyTrades: 10,
  cooldownAfterLossStreak: 3,
}

export interface RiskCheckResult {
  allowed: boolean
  reason: string
  riskLevel: 'low' | 'medium' | 'high' | 'critical'
  checks: {
    positionSize: boolean
    dailyDrawdown: boolean
    totalDrawdown: boolean
    openPositions: boolean
    dailyTrades: boolean
    lossStreak: boolean
  }
}

// ============================================
// Exchange Abstraction
// ============================================

export interface ExchangeOrder {
  orderId: string
  symbol: string
  side: 'BUY' | 'SELL'
  type: 'MARKET' | 'LIMIT' | 'STOP_LOSS_LIMIT'
  quantity: number
  price: number | null
  stopPrice: number | null
  status: 'NEW' | 'FILLED' | 'PARTIALLY_FILLED' | 'CANCELLED' | 'REJECTED'
  filledPrice: number | null
  filledQty: number
  commission: number
  commissionAsset: string | null
  timestamp: string
}

export interface ExchangeBalance {
  asset: string
  free: number
  locked: number
}

export interface ExchangeClient {
  placeOrder(params: {
    symbol: string
    side: 'BUY' | 'SELL'
    type: 'MARKET' | 'LIMIT'
    quantity: number
    price?: number
  }): Promise<ExchangeOrder>
  cancelOrder(symbol: string, orderId: string): Promise<void>
  getOrder(symbol: string, orderId: string): Promise<ExchangeOrder>
  getBalance(): Promise<ExchangeBalance[]>
  getPrice(symbol: string): Promise<number>
}

// ============================================
// AI Advisor
// ============================================

export interface DailyReport {
  date: string
  sessionId: string
  metrics: {
    tradesExecuted: number
    winRate: number
    netPnl: number
    maxDrawdown: number
    sharpeEstimate: number
  }
  paperComparison: {
    paperPnl: number
    livePnl: number
    divergencePct: number
  } | null
  aiAnalysis: string
  recommendation: 'continue' | 'adjust' | 'pause' | 'stop'
}
