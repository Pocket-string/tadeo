import crypto from 'crypto'
import type { ExchangeClient, ExchangeOrder, ExchangeBalance } from '../types'

const BINANCE_API = 'https://api.binance.com'

function signQuery(query: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(query).digest('hex')
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
      const orderParams: Record<string, string> = {
        symbol: params.symbol,
        side: params.side,
        type: params.type,
        quantity: params.quantity.toFixed(8),
      }

      if (params.type === 'LIMIT' && params.price) {
        orderParams.price = params.price.toFixed(8)
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
