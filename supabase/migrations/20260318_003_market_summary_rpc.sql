-- RPC function to get market data summary efficiently
-- Avoids pulling all rows to the client just to count them

CREATE OR REPLACE FUNCTION get_market_data_summary()
RETURNS TABLE (
  symbol TEXT,
  timeframe TEXT,
  count BIGINT,
  first_ts TIMESTAMPTZ,
  last_ts TIMESTAMPTZ
)
LANGUAGE sql
STABLE
SECURITY DEFINER
AS $$
  SELECT
    symbol,
    timeframe,
    COUNT(*) AS count,
    MIN(timestamp) AS first_ts,
    MAX(timestamp) AS last_ts
  FROM ohlcv_candles
  GROUP BY symbol, timeframe
  ORDER BY symbol, timeframe;
$$;
