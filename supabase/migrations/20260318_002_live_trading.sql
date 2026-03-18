-- ============================================
-- Phase 6: Live Trading Tables
-- ============================================

-- Live trading sessions
CREATE TABLE IF NOT EXISTS live_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  strategy_id UUID NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '1h',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped', 'emergency')),
  initial_capital DECIMAL(15,2) NOT NULL DEFAULT 1000,
  current_capital DECIMAL(15,2) NOT NULL DEFAULT 1000,
  total_trades INT NOT NULL DEFAULT 0,
  winning_trades INT NOT NULL DEFAULT 0,
  net_pnl DECIMAL(15,2) NOT NULL DEFAULT 0,
  max_drawdown_pct DECIMAL(8,4) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  pause_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE live_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own live sessions"
  ON live_sessions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Live trades (individual orders executed on exchange)
CREATE TABLE IF NOT EXISTS live_trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  session_id UUID NOT NULL REFERENCES live_sessions(id) ON DELETE CASCADE,
  strategy_id UUID NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('buy', 'sell')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'cancelled')),
  entry_price DECIMAL(18,8) NOT NULL,
  exit_price DECIMAL(18,8),
  quantity DECIMAL(18,8) NOT NULL,
  stop_loss DECIMAL(18,8),
  take_profit DECIMAL(18,8),
  pnl DECIMAL(15,2) NOT NULL DEFAULT 0,
  pnl_pct DECIMAL(8,4) NOT NULL DEFAULT 0,
  entry_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  exit_time TIMESTAMPTZ,
  exit_reason TEXT,
  exchange_order_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE live_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own live trades"
  ON live_trades FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_live_sessions_user ON live_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_strategy ON live_sessions(strategy_id);
CREATE INDEX IF NOT EXISTS idx_live_sessions_status ON live_sessions(status);
CREATE INDEX IF NOT EXISTS idx_live_trades_session ON live_trades(session_id);
CREATE INDEX IF NOT EXISTS idx_live_trades_status ON live_trades(status);
