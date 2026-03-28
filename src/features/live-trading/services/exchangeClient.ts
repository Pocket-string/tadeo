import crypto from 'crypto'
import type { ExchangeClient, ExchangeOrder, ExchangeBalance } from '../types'

const BINANCE_API = 'https://api.binance.com'

function signQuery(query: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex')
}

// ── Symbol Info Cache (LOT_SIZE, MIN_NOTIONAL, PRICE_FILTER) ──────────────
interface SymbolFilter {
  stepSize: number     // LOT_SIZE step (e.g. 0.01 for SOL)
  minQty: number       // LOT_SIZE minimum quantity
  minNotional: number  // MIN_NOTIONAL (e.g. 5 USDT)
  tickSize: number     // PRICE_FILTER tick size
}

const symbolInfoCache = new Map<string, SymbolFilter>()

/** Fetch and cache symbol trading rules from Binance exchangeInfo */
export async function getSymbolFilter(symbol: string): Promise<SymbolFilter> {
  if (symbolInfoCache.has(symbol)) return symbolInfoCache.get(symbol)!

  const response = await fetch(
    `${BINANCE_API}/api/v3/exchangeInfo?symbol=${symbol}`,
    { cache: 'no-store' }
  )
  if (!response.ok) {
    // Fallback defaults for SOLUSDT if API fails
    return { stepSize: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.01 }
  }

  const data = await response.json()
  const symbolInfo = data.symbols?.[0]
  if (!symbolInfo) {
    return { stepSize: 0.01, minQty: 0.01, minNotional: 5, tickSize: 0.01 }
  }

  const filters = symbolInfo.filters as { filterType: string; stepSize?: string; minQty?: string; minNotional?: string; tickSize?: string }[]

  const lotSize = filters.find(f => f.filterType === 'LOT_SIZE')
  const notional = filters.find(f => f.filterType === 'NOTIONAL') || filters.find(f => f.filterType === 'MIN_NOTIONAL')
  const priceFilter = filters.find(f => f.filterType === 'PRICE_FILTER')

  const info: SymbolFilter = {
    stepSize: parseFloat(lotSize?.stepSize || '0.01'),
    minQty: parseFloat(lotSize?.minQty || '0.01'),
    minNotional: parseFloat(notional?.minNotional || '5'),
    tickSize: parseFloat(priceFilter?.tickSize || '0.01'),
  }

  symbolInfoCache.set(symbol, info)
  return info
}

/** Round quantity down to the nearest valid step size */
export function roundQuantity(quantity: number, stepSize: number): number {
  const precision = Math.max(0, Math.round(-Math.log10(stepSize)))
  const factor = Math.pow(10, precision)
  return Math.floor(quantity * factor) / factor
}

/** Validate order meets Binance minimum requirements */
export function validateOrder(
  quantity: number,
  price: number,
  filter: SymbolFilter
): { valid: boolean; reason?: string } {
  if (quantity < filter.minQty) {
    return { valid: false, reason: `Quantity ${quantity} below minimum ${filter.minQty}` }
  }
  const notional = quantity * price
  if (notional < filter.minNotional) {
    return { valid: false, reason: `Notional ${notional.toFixed(2)} below minimum ${filter.minNotional}` }
  }
  return { valid: true }
}

/**
 * Binance Exchange Client for live trading.
 * Requires BINANCE_API_KEY and BINANCE_API_SECRET env vars.
 */
export function createBinanceClient(): ExchangeClient {
  const apiKey = process.env.BINANCE_API_KEY
  const apiSecret = process.env.BINANCE_API_SECRET

  if (!apiKey || !apiSecret) {
    throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are required for live trading')
  }

  async function signedRequest(
    method: 'GET' | 'POST' | 'DELETE',
    endpoint: string,
    params: Record<string, string> = {}
  ): Promise<Response> {
    const timestamp = Date.now().toString()
    const allParams = { ...params, timestamp }
    const query = new URLSearchParams(allParams).toString()
    const signature = signQuery(query, apiSecret!)

    const url = `${BINANCE_API}${endpoint}?${query}&signature=${signature}`

    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey!,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      cache: 'no-store',
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Binance API error ${response.status}: ${text}`)
    }

    return response
  }

  return {
    async placeOrder(params) {
      // Apply LOT_SIZE compliance
      const filter = await getSymbolFilter(params.symbol)
      const roundedQty = roundQuantity(params.quantity, filter.stepSize)

      const price = params.price ?? (await this.getPrice(params.symbol))
      const validation = validateOrder(roundedQty, price, filter)
      if (!validation.valid) {
        throw new Error(`Order validation failed: ${validation.reason}`)
      }

      const orderParams: Record<string, string> = {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        quantity: roundedQty.toFixed(Math.max(0, Math.round(-Math.log10(filter.stepSize)))),
      }

      if (params.type === 'LIMIT' && params.price) {
        orderParams.price = params.price.toFixed(Math.max(0, Math.round(-Math.log10(filter.tickSize))))
        orderParams.timeInForce = 'GTC'
      }

      const response = await signedRequest('POST', '/api/v3/order', orderParams)
      const data = await response.json()

      return {
        orderId: String(data.orderId),
        symbol: data.symbol,
        side: data.side,
        type: data.type,
        quantity: parseFloat(data.origQty),
        price: data.price ? parseFloat(data.price) : null,
        stopPrice: null,
        status: data.status,
        filledPrice: data.fills?.length > 0
          ? data.fills.reduce((s: number, f: { price: string; qty: string }) =>
            s + parseFloat(f.price) * parseFloat(f.qty), 0) / parseFloat(data.executedQty || '1')
          : null,
        filledQty: parseFloat(data.executedQty || '0'),
        commission: data.fills?.reduce((s: number, f: { commission: string }) =>
          s + parseFloat(f.commission), 0) ?? 0,
        commissionAsset: data.fills?.[0]?.commissionAsset ?? null,
        timestamp: new Date(data.transactTime).toISOString(),
      }
    },

    async cancelOrder(symbol, orderId) {
      await signedRequest('DELETE', '/api/v3/order', {
        symbol,
        orderId,
      })
    },

    async getOrder(symbol, orderId) {
      const response = await signedRequest('GET', '/api/v3/order', {
        symbol,
        orderId,
      })
      const data = await response.json()

      return {
        orderId: String(data.orderId),
        symbol: data.symbol,
        side: data.side,
        type: data.type,
        quantity: parseFloat(data.origQty),
        price: data.price ? parseFloat(data.price) : null,
        stopPrice: data.stopPrice ? parseFloat(data.stopPrice) : null,
        status: data.status,
        filledPrice: parseFloat(data.price || '0'),
        filledQty: parseFloat(data.executedQty || '0'),
        commission: 0,
        commissionAsset: null,
        timestamp: new Date(data.time).toISOString(),
      }
    },

    async getBalance() {
      const response = await signedRequest('GET', '/api/v3/account')
      const data = await response.json()

      return (data.balances as { asset: string; free: string; locked: string }[])
        .filter((b) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
        .map((b) => ({
          asset: b.asset,
          free: parseFloat(b.free),
          locked: parseFloat(b.locked),
        }))
    },

    async getPrice(symbol) {
      const response = await fetch(`${BINANCE_API}/api/v3/ticker/price?symbol=${symbol}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Failed to get price for ${symbol}`)
      const data = await response.json()
      return parseFloat(data.price)
    },
  }
}

/**
 * Simulated exchange client for testing without real API keys.
 * Uses live Binance prices but doesn't execute real orders.
 */
export function createSimulatedClient(): ExchangeClient {
  let orderCounter = 0

  return {
    async placeOrder(params) {
      const price = await this.getPrice(params.symbol)
      orderCounter++
      return {
        orderId: `SIM-${orderCounter}`,
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        quantity: params.quantity,
        price: params.type === 'LIMIT' ? params.price ?? price : price,
        stopPrice: null,
        status: 'FILLED',
        filledPrice: price,
        filledQty: params.quantity,
        commission: params.quantity * price * 0.001,
        commissionAsset: params.side === 'BUY' ? params.symbol.replace('USDT', '').replace('USDC', '') : 'USDT',
        timestamp: new Date().toISOString(),
      }
    },

    async cancelOrder() {
      // No-op for simulated
    },

    async getOrder(_symbol, orderId) {
      return {
        orderId,
        symbol: _symbol,
        side: 'BUY' as const,
        type: 'MARKET' as const,
        quantity: 0,
        price: null,
        stopPrice: null,
        status: 'FILLED' as const,
        filledPrice: 0,
        filledQty: 0,
        commission: 0,
        commissionAsset: null,
        timestamp: new Date().toISOString(),
      }
    },

    async getBalance() {
      return [{ asset: 'USDT', free: 10000, locked: 0 }]
    },

    async getPrice(symbol) {
      const response = await fetch(`${BINANCE_API}/api/v3/ticker/price?symbol=${symbol}`, {
        cache: 'no-store',
      })
      if (!response.ok) throw new Error(`Failed to get price for ${symbol}`)
      const data = await response.json()
      return parseFloat(data.price)
    },
  }
}
