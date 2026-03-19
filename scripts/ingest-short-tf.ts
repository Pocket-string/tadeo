/**
 * Import 5m and 15m candles for all pairs from Binance.
 * Run with: npx tsx scripts/ingest-short-tf.ts
 */

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!

if (!SUPABASE_URL || !SUPABASE_KEY) {
  console.error('Set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

import { createClient } from '@supabase/supabase-js'
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY)

const PAIRS = ['ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'BTCUSDT']
const TIMEFRAMES = ['5m', '15m']

// Binance klines API
async function fetchBinanceCandles(symbol: string, interval: string, startTime: number, endTime: number) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${startTime}&endTime=${endTime}&limit=1000`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Binance API error: ${res.status}`)
  const data = await res.json()
  return (data as number[][]).map((k: number[]) => ({
    symbol,
    timeframe: interval,
    timestamp: new Date(k[0]).toISOString(),
    open: parseFloat(String(k[1])),
    high: parseFloat(String(k[2])),
    low: parseFloat(String(k[3])),
    close: parseFloat(String(k[4])),
    volume: parseFloat(String(k[5])),
  }))
}

async function ingestPair(symbol: string, timeframe: string, monthsBack: number) {
  const endTime = Date.now()
  const startTime = endTime - monthsBack * 30 * 24 * 60 * 60 * 1000

  let cursor = startTime
  let total = 0

  while (cursor < endTime) {
    const candles = await fetchBinanceCandles(symbol, timeframe, cursor, endTime)
    if (candles.length === 0) break

    // Batch upsert 500 at a time
    for (let i = 0; i < candles.length; i += 500) {
      const batch = candles.slice(i, i + 500)
      const { error } = await supabase
        .from('ohlcv_candles')
        .upsert(batch, { onConflict: 'symbol,timeframe,timestamp' })

      if (error) {
        console.error(`  Error upserting ${symbol} ${timeframe}: ${error.message}`)
        break
      }
      total += batch.length
    }

    // Move cursor past last candle
    const lastTs = new Date(candles[candles.length - 1].timestamp).getTime()
    if (lastTs <= cursor) break // No progress
    cursor = lastTs + 1

    // Rate limit
    await new Promise(r => setTimeout(r, 200))
  }

  return total
}

async function main() {
  console.log('Importing short timeframe data from Binance...\n')

  for (const symbol of PAIRS) {
    for (const tf of TIMEFRAMES) {
      const months = tf === '5m' ? 3 : 6 // 5m = 3 months, 15m = 6 months
      process.stdout.write(`${symbol} ${tf} (${months}mo)... `)
      try {
        const count = await ingestPair(symbol, tf, months)
        console.log(`${count} candles`)
      } catch (e) {
        console.log(`FAILED: ${e instanceof Error ? e.message : 'unknown'}`)
      }
    }
  }

  console.log('\nDone! Verifying...\n')

  for (const symbol of PAIRS) {
    for (const tf of TIMEFRAMES) {
      const { count } = await supabase
        .from('ohlcv_candles')
        .select('*', { count: 'exact', head: true })
        .eq('symbol', symbol)
        .eq('timeframe', tf)
      console.log(`${symbol} ${tf}: ${count} candles`)
    }
  }
}

main()
