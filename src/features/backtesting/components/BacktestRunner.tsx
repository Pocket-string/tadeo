'use client'

import { useState } from 'react'

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const

interface Strategy {
  id: string
  name: string
}

interface BacktestResult {
  backtestId: string
  metrics: {
    totalTrades: number
    winningTrades: number
    losingTrades: number
    winRate: number
    netProfit: number
    maxDrawdown: number
    sharpeRatio: number
    tStatistic: number
    profitFactor: number
  }
  tradesCount: number
}

export function BacktestRunner({ strategies }: { strategies: Strategy[] }) {
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? '')
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [timeframe, setTimeframe] = useState('1h')
  const [startDate, setStartDate] = useState(getDefaultStart())
  const [endDate, setEndDate] = useState(getDefaultEnd())
  const [capital, setCapital] = useState(10000)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<BacktestResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRun(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)
    setError(null)

    try {
      const { executeBacktest } = await import('@/actions/backtests')
      const data = await executeBacktest({
        strategyId,
        symbol,
        timeframe,
        startDate,
        endDate,
        initialCapital: capital,
      })
      setResult(data as BacktestResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error ejecutando backtest')
    } finally {
      setLoading(false)
    }
  }

  if (strategies.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-lg p-8 text-center">
        <p className="text-muted-foreground">Crea una estrategia primero para ejecutar backtests.</p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="bg-surface border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Ejecutar Backtest</h2>
        <form onSubmit={handleRun} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Estrategia</label>
              <select
                value={strategyId}
                onChange={(e) => setStrategyId(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
              >
                {strategies.map((s) => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Simbolo</label>
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Timeframe</label>
              <div className="flex gap-1">
                {TIMEFRAMES.map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => setTimeframe(tf)}
                    className={`px-2 py-1.5 text-xs rounded border transition-colors ${
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
              <label className="block text-sm font-medium text-muted-foreground mb-1">Capital Inicial ($)</label>
              <input
                type="number"
                value={capital}
                onChange={(e) => setCapital(Number(e.target.value))}
                min={100}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Fecha inicio</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Fecha fin</label>
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
            className="w-full py-2.5 bg-primary text-primary-foreground rounded-md font-medium text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
          >
            {loading ? 'Ejecutando backtest...' : 'Ejecutar Backtest'}
          </button>
        </form>
      </div>

      {result && <BacktestResultCard result={result} />}

      {error && (
        <div className="p-4 rounded-md bg-red-500/10 border border-red-500/20 text-sm text-red-500">
          {error}
        </div>
      )}
    </div>
  )
}

function BacktestResultCard({ result }: { result: BacktestResult }) {
  const m = result.metrics
  return (
    <div className="bg-surface border border-border rounded-lg p-6">
      <h3 className="font-semibold text-foreground mb-4">Resultados</h3>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        <MetricCard label="Total Trades" value={m.totalTrades} />
        <MetricCard
          label="Win Rate"
          value={`${(m.winRate * 100).toFixed(1)}%`}
          color={m.winRate > 0.55 ? 'green' : m.winRate > 0.45 ? 'yellow' : 'red'}
        />
        <MetricCard
          label="Net Profit"
          value={`$${m.netProfit.toFixed(2)}`}
          color={m.netProfit > 0 ? 'green' : 'red'}
        />
        <MetricCard
          label="Sharpe Ratio"
          value={m.sharpeRatio.toFixed(2)}
          color={m.sharpeRatio > 1.5 ? 'green' : m.sharpeRatio > 1.0 ? 'yellow' : 'red'}
        />
        <MetricCard
          label="t-Statistic"
          value={m.tStatistic.toFixed(2)}
          color={m.tStatistic > 3.0 ? 'green' : m.tStatistic > 2.0 ? 'yellow' : 'red'}
        />
        <MetricCard
          label="Max Drawdown"
          value={`${(m.maxDrawdown * 100).toFixed(1)}%`}
          color={m.maxDrawdown < 0.15 ? 'green' : m.maxDrawdown < 0.25 ? 'yellow' : 'red'}
        />
        <MetricCard
          label="Profit Factor"
          value={m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2)}
          color={m.profitFactor > 1.5 ? 'green' : m.profitFactor > 1.0 ? 'yellow' : 'red'}
        />
        <MetricCard label="Winning" value={m.winningTrades} />
        <MetricCard label="Losing" value={m.losingTrades} />
        <MetricCard label="Trades Saved" value={result.tradesCount} />
      </div>
    </div>
  )
}

function MetricCard({ label, value, color }: {
  label: string
  value: string | number
  color?: 'green' | 'yellow' | 'red'
}) {
  const colorClass = color === 'green'
    ? 'text-green-500'
    : color === 'yellow'
      ? 'text-yellow-500'
      : color === 'red'
        ? 'text-red-500'
        : 'text-foreground'

  return (
    <div className="bg-background rounded-md p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold mt-1 ${colorClass}`}>{value}</p>
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
