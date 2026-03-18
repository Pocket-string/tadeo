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
