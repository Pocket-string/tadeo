'use server'

import { z } from 'zod'

const BINANCE_BASE_URL = 'https://api.binance.com/api/v3'

// Binance kline interval mapping
const TIMEFRAME_MAP: Record<string, string> = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '30m': '30m',
  '1h': '1h',
  '4h': '4h',
  '1d': '1d',
  '1w': '1w',
}

const BinanceKlineSchema = z.tuple([
  z.number(), // open time
  z.string(), // open
  z.string(), // high
  z.string(), // low
  z.string(), // close
  z.string(), // volume
  z.number(), // close time
  z.string(), // quote asset volume
  z.number(), // number of trades
  z.string(), // taker buy base
  z.string(), // taker buy quote
  z.string(), // ignore
])

type BinanceKline = z.infer<typeof BinanceKlineSchema>

export interface FetchCandlesOptions {
  symbol: string
  timeframe: string
  startTime?: number
  endTime?: number
  limit?: number
}

export interface RawCandle {
  timestamp: string
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/**
 * Fetch candles from Binance public API (no API key needed).
 * Max 1000 candles per request.
 */
export async function fetchBinanceCandles(options: FetchCandlesOptions): Promise<RawCandle[]> {
  const interval = TIMEFRAME_MAP[options.timeframe]
  if (!interval) throw new Error(`Unsupported timeframe: ${options.timeframe}`)

  const params = new URLSearchParams({
    symbol: options.symbol.toUpperCase().replace('/', ''),
    interval,
    limit: String(options.limit ?? 1000),
  })

  if (options.startTime) params.set('startTime', String(options.startTime))
  if (options.endTime) params.set('endTime', String(options.endTime))

  const response = await fetch(`${BINANCE_BASE_URL}/klines?${params}`, {
    next: { revalidate: 60 },
  })

  if (!response.ok) {
    const text = await response.text()
    throw new Error(`Binance API error ${response.status}: ${text}`)
  }

  const raw: unknown[] = await response.json()

  return raw.map((item) => {
    const parsed = BinanceKlineSchema.parse(item)
    return klineToCandle(parsed)
  })
}

function klineToCandle(kline: BinanceKline): RawCandle {
  return {
    timestamp: new Date(kline[0]).toISOString(),
    open: parseFloat(kline[1]),
    high: parseFloat(kline[2]),
    low: parseFloat(kline[3]),
    close: parseFloat(kline[4]),
    volume: parseFloat(kline[5]),
  }
}

/**
 * Fetch all candles in a date range by paginating (1000 per request).
 * Pattern: data-pipeline batch fetch.
 */
export async function fetchCandlesRange(
  symbol: string,
  timeframe: string,
  startDate: string,
  endDate: string
): Promise<RawCandle[]> {
  const allCandles: RawCandle[] = []
  let startTime = new Date(startDate).getTime()
  const endTime = new Date(endDate).getTime()

  while (startTime < endTime) {
    const batch = await fetchBinanceCandles({
      symbol,
      timeframe,
      startTime,
      endTime,
      limit: 1000,
    })

    if (batch.length === 0) break

    allCandles.push(...batch)

    // Move start to after last candle
    const lastTs = new Date(batch[batch.length - 1].timestamp).getTime()
    if (lastTs <= startTime) break // Safety: avoid infinite loop
    startTime = lastTs + 1
  }

  return allCandles
}

/**
 * Get available symbols from Binance (top traded pairs).
 */
export async function fetchBinanceSymbols(): Promise<string[]> {
  const response = await fetch(`${BINANCE_BASE_URL}/ticker/24hr`, {
    next: { revalidate: 3600 },
  })

  if (!response.ok) throw new Error(`Binance API error: ${response.status}`)

  const data: { symbol: string; quoteVolume: string }[] = await response.json()

  // Return top 50 USDT pairs by volume
  return data
    .filter((t) => t.symbol.endsWith('USDT'))
    .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
    .slice(0, 50)
    .map((t) => t.symbol)
}
