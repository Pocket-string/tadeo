// ============================================
// Risk Tiers — 3 levels for portfolio diversification
// ============================================
export type RiskTier = 'conservative' | 'moderate' | 'aggressive'

export const RISK_TIERS: Record<RiskTier, {
  label: string
  riskPerTrade: number  // fraction of capital risked per trade
  description: string
  color: string
  allocation: number    // suggested % of total portfolio
}> = {
  conservative: {
    label: 'Conservador',
    riskPerTrade: 0.01,  // 1% per trade
    description: 'SL tight, 1% riesgo. Para capital principal.',
    color: 'blue',
    allocation: 0.50,    // 50% of portfolio
  },
  moderate: {
    label: 'Moderado',
    riskPerTrade: 0.03,  // 3% per trade
    description: 'Balance riesgo/retorno. Core de la cartera.',
    color: 'amber',
    allocation: 0.35,    // 35% of portfolio
  },
  aggressive: {
    label: 'Agresivo',
    riskPerTrade: 0.07,  // 7% per trade
    description: 'Max crecimiento. Solo capital que puedes perder.',
    color: 'red',
    allocation: 0.15,    // 15% of portfolio
  },
}

export interface PaperSession {
  id: string
  user_id: string
  strategy_id: string
  symbol: string
  timeframe: string
  status: 'active' | 'paused' | 'stopped'
  initial_capital: number
  current_capital: number
  total_trades: number
  winning_trades: number
  net_pnl: number
  risk_tier: RiskTier | null
  max_drawdown: number | null
  started_at: string
  stopped_at: string | null
  created_at: string
}

export interface PaperTrade {
  id: string
  user_id: string
  strategy_id: string
  symbol: string
  timeframe: string
  type: 'buy' | 'sell'
  status: 'open' | 'closed'
  entry_price: number
  exit_price: number | null
  quantity: number
  stop_loss: number | null
  take_profit: number | null
  pnl: number
  pnl_pct: number
  entry_time: string
  exit_time: string | null
  exit_reason: string | null
  metadata: Record<string, unknown> | null
  created_at: string
}

export interface LivePrice {
  symbol: string
  price: number
  change24h: number
  volume24h: number
  timestamp: string
}

export interface PaperDashboardData {
  session: PaperSession
  openTrades: PaperTrade[]
  closedTrades: PaperTrade[]
  currentPrice: LivePrice | null
  pnlHistory: { timestamp: string; pnl: number }[]
}
