'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const
const POPULAR_SYMBOLS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'XRPUSDT', 'ADAUSDT', 'DOGEUSDT', 'AVAXUSDT']

interface IngestResult {
  symbol: string
  timeframe: string
  fetched: number
  upserted: number
  errors: string[]
}

export function IngestForm() {
  const router = useRouter()
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [timeframe, setTimeframe] = useState('1h')
  const [startDate, setStartDate] = useState(getDefaultStart())
  const [endDate, setEndDate] = useState(getDefaultEnd())
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<IngestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)
    setError(null)

    try {
      const res = await fetch('/api/ingest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, timeframe, startDate, endDate }),
      })

      const data = await res.json()

      if (!res.ok && res.status !== 207) {
        throw new Error(data.error || 'Failed to ingest')
      }

      setResult(data)
      router.refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error desconocido')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="bg-surface border border-border rounded-lg p-6">
      <h2 className="text-lg font-semibold text-foreground mb-4">Ingestar Datos de Binance</h2>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Simbolo
            </label>
            <div className="flex gap-2">
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="flex-1 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
              >
                {POPULAR_SYMBOLS.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                placeholder="O escribe..."
                className="w-32 bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Timeframe
            </label>
            <div className="flex gap-1">
              {TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  onClick={() => setTimeframe(tf)}
                  className={`px-3 py-2 text-xs rounded-md border transition-colors ${
                    timeframe === tf
                      ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-border text-muted-foreground hover:border-primary/50'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Fecha inicio
            </label>
            <input
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">
              Fecha fin
            </label>
            <input
              type="date"
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
            />
          </div>
        </div>

        <button
          type="submit"
          disabled={loading}
          className="w-full py-2.5 bg-primary text-primary-foreground rounded-md font-medium text-sm hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Ingesting...' : `Ingestar ${symbol} ${timeframe}`}
        </button>
      </form>

      {result && (
        <div className={`mt-4 p-4 rounded-md text-sm ${
          result.errors.length > 0
            ? 'bg-yellow-500/10 border border-yellow-500/20'
            : 'bg-green-500/10 border border-green-500/20'
        }`}>
          <p className="font-medium">
            {result.errors.length > 0 ? 'Parcialmente completado' : 'Ingesta completada'}
          </p>
          <p className="mt-1">
            Obtenidos: {result.fetched.toLocaleString()} | Guardados: {result.upserted.toLocaleString()}
          </p>
          {result.errors.length > 0 && (
            <ul className="mt-2 text-xs text-yellow-600">
              {result.errors.map((e, i) => <li key={i}>{e}</li>)}
            </ul>
          )}
        </div>
      )}

      {error && (
        <div className="mt-4 p-4 rounded-md text-sm bg-red-500/10 border border-red-500/20 text-red-500">
          {error}
        </div>
      )}
    </div>
  )
}

function getDefaultStart(): string {
  const d = new Date()
  d.setMonth(d.getMonth() - 3)
  return d.toISOString().split('T')[0]
}

function getDefaultEnd(): string {
  return new Date().toISOString().split('T')[0]
}
