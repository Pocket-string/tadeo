-- ============================================
-- Migration: ohlcv_candles table
-- Fase 1: Fundamentacion y Captura de Datos
-- ============================================

-- Tabla principal de datos historicos OHLCV
CREATE TABLE IF NOT EXISTS ohlcv_candles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  symbol text NOT NULL,
  timeframe text NOT NULL,
  timestamp timestamptz NOT NULL,
  open decimal NOT NULL,
  high decimal NOT NULL,
  low decimal NOT NULL,
  close decimal NOT NULL,
  volume decimal NOT NULL DEFAULT 0,
  created_at timestamptz DEFAULT now(),
  CONSTRAINT ohlcv_unique_candle UNIQUE (symbol, timeframe, timestamp)
);

-- Indice para queries rapidos por symbol + timeframe + rango de fechas
CREATE INDEX IF NOT EXISTS idx_ohlcv_symbol_timeframe_ts
  ON ohlcv_candles (symbol, timeframe, timestamp DESC);

-- RLS habilitado desde dia 0
ALTER TABLE ohlcv_candles ENABLE ROW LEVEL SECURITY;

-- Politica: cualquier usuario autenticado puede leer datos de mercado
CREATE POLICY "Authenticated users can read market data"
  ON ohlcv_candles FOR SELECT
  TO authenticated
  USING (true);

-- Politica: solo admins pueden insertar/actualizar datos
CREATE POLICY "Admins can insert market data"
  ON ohlcv_candles FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM profiles
      WHERE profiles.id = auth.uid()
      AND profiles.role = 'admin'
    )
  );

-- Politica: service role puede hacer todo (para ingesta automatizada)
CREATE POLICY "Service role full access"
  ON ohlcv_candles FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Tabla de estrategias
CREATE TABLE IF NOT EXISTS strategies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  status text NOT NULL DEFAULT 'draft',
  parameters jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_strategies_user ON strategies (user_id);

ALTER TABLE strategies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can CRUD own strategies"
  ON strategies FOR ALL
  TO authenticated
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

-- Trigger updated_at automatico
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER strategies_updated_at
  BEFORE UPDATE ON strategies
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- Tabla de resultados de backtesting
CREATE TABLE IF NOT EXISTS backtest_results (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  strategy_id uuid NOT NULL REFERENCES strategies(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'pending',
  symbol text NOT NULL,
  timeframe text NOT NULL,
  start_date timestamptz NOT NULL,
  end_date timestamptz NOT NULL,
  total_trades int DEFAULT 0,
  winning_trades int DEFAULT 0,
  losing_trades int DEFAULT 0,
  win_rate decimal DEFAULT 0,
  net_profit decimal DEFAULT 0,
  max_drawdown decimal DEFAULT 0,
  sharpe_ratio decimal DEFAULT 0,
  t_statistic decimal DEFAULT 0,
  profit_factor decimal DEFAULT 0,
  is_in_sample boolean DEFAULT true,
  is_out_of_sample boolean DEFAULT false,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE backtest_results ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own backtest results"
  ON backtest_results FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM strategies
      WHERE strategies.id = backtest_results.strategy_id
      AND strategies.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own backtest results"
  ON backtest_results FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM strategies
      WHERE strategies.id = backtest_results.strategy_id
      AND strategies.user_id = auth.uid()
    )
  );

-- Tabla de trades individuales del backtest
CREATE TABLE IF NOT EXISTS backtest_trades (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  backtest_id uuid NOT NULL REFERENCES backtest_results(id) ON DELETE CASCADE,
  entry_time timestamptz NOT NULL,
  exit_time timestamptz NOT NULL,
  type text NOT NULL,
  entry_price decimal NOT NULL,
  exit_price decimal NOT NULL,
  quantity decimal NOT NULL DEFAULT 1,
  pnl decimal NOT NULL DEFAULT 0,
  pnl_pct decimal NOT NULL DEFAULT 0,
  exit_reason text NOT NULL DEFAULT 'signal'
);

ALTER TABLE backtest_trades ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own backtest trades"
  ON backtest_trades FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM backtest_results br
      JOIN strategies s ON s.id = br.strategy_id
      WHERE br.id = backtest_trades.backtest_id
      AND s.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert own backtest trades"
  ON backtest_trades FOR INSERT
  TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM backtest_results br
      JOIN strategies s ON s.id = br.strategy_id
      WHERE br.id = backtest_trades.backtest_id
      AND s.user_id = auth.uid()
    )
  );
