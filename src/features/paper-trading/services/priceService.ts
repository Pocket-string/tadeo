'use server'

import type { LivePrice } from '../types'

const BINANCE_BASE = 'https://api.binance.com/api/v3'

/**
 * Get current price for a symbol from Binance.
 */
export async function getLivePrice(symbol: string): Promise<LivePrice> {
  const res = await fetch(`${BINANCE_BASE}/ticker/24hr?symbol=${symbol.toUpperCase()}`, {
    next: { revalidate: 5 },
  })

  if (!res.ok) throw new Error(`Price fetch failed: ${res.status}`)

  const data = await res.json()

  return {
    symbol: data.symbol,
    price: parseFloat(data.lastPrice),
    change24h: parseFloat(data.priceChangePercent),
    volume24h: parseFloat(data.volume),
    timestamp: new Date().toISOString(),
  }
}

/**
 * Get prices for multiple symbols.
 */
export async function getLivePrices(symbols: string[]): Promise<LivePrice[]> {
  const results = await Promise.allSettled(
    symbols.map((s) => getLivePrice(s))
  )

  return results
    .filter((r): r is PromiseFulfilledResult<LivePrice> => r.status === 'fulfilled')
    .map((r) => r.value)
}
