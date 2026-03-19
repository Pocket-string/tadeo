-- Add risk_tier to paper_sessions for portfolio diversification
ALTER TABLE paper_sessions
  ADD COLUMN IF NOT EXISTS risk_tier TEXT DEFAULT 'moderate'
  CHECK (risk_tier IN ('conservative', 'moderate', 'aggressive'));

-- Update existing sessions to moderate
UPDATE paper_sessions SET risk_tier = 'moderate' WHERE risk_tier IS NULL;
