/**
 * Scan all pairs × short timeframes through the optimizer.
 * Run with: npx tsx scripts/scan-short-tf.ts
 */
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const PAIRS = ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'BTCUSDT']
const TIMEFRAMES = ['5m', '15m', '1h']

async function checkDataAvailability() {
  console.log('Checking data availability...\n')

  for (const symbol of PAIRS) {
    for (const tf of TIMEFRAMES) {
      const { count } = await supabase
        .from('ohlcv_candles')
        .select('*', { count: 'exact', head: true })
        .eq('symbol', symbol)
        .eq('timeframe', tf)

      console.log(`${symbol} ${tf}: ${count ?? 0} candles`)
    }
  }
}

checkDataAvailability()
