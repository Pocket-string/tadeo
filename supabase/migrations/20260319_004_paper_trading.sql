-- ============================================
-- Phase 7: Paper Trading Tables
-- ============================================

-- Paper trading sessions
CREATE TABLE IF NOT EXISTS paper_sessions (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  strategy_id UUID NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '4h',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'stopped')),
  initial_capital DECIMAL(15,2) NOT NULL DEFAULT 10000,
  current_capital DECIMAL(15,2) NOT NULL DEFAULT 10000,
  total_trades INT NOT NULL DEFAULT 0,
  winning_trades INT NOT NULL DEFAULT 0,
  net_pnl DECIMAL(15,2) NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE paper_sessions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own paper sessions"
  ON paper_sessions FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Paper trades
CREATE TABLE IF NOT EXISTS paper_trades (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  strategy_id UUID NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  symbol TEXT NOT NULL,
  timeframe TEXT NOT NULL DEFAULT '4h',
  type TEXT NOT NULL CHECK (type IN ('buy', 'sell')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
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
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE paper_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can manage own paper trades"
  ON paper_trades FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_paper_sessions_user ON paper_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_paper_sessions_strategy ON paper_sessions(strategy_id);
CREATE INDEX IF NOT EXISTS idx_paper_sessions_status ON paper_sessions(status);
CREATE INDEX IF NOT EXISTS idx_paper_trades_strategy ON paper_trades(strategy_id);
CREATE INDEX IF NOT EXISTS idx_paper_trades_user ON paper_trades(user_id);
CREATE INDEX IF NOT EXISTS idx_paper_trades_status ON paper_trades(status);
