'use client'

import { useState } from 'react'
import type { ScientificBacktestOutput, WalkForwardResult, AIBacktestReview, BacktestMetrics, MetricSemaphore } from '../types'

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const

interface Strategy { id: string; name: string }

export function ScientificBacktestRunner({ strategies }: { strategies: Strategy[] }) {
  const [strategyId, setStrategyId] = useState(strategies[0]?.id ?? '')
  const [symbol, setSymbol] = useState('BTCUSDT')
  const [timeframe, setTimeframe] = useState('1h')
  const [startDate, setStartDate] = useState(getMonthsAgo(6))
  const [endDate, setEndDate] = useState(today())
  const [capital, setCapital] = useState(10000)
  const [runWF, setRunWF] = useState(true)
  const [runAI, setRunAI] = useState(true)
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<{
    scientific: ScientificBacktestOutput
    walkForward?: WalkForwardResult
    aiReview?: AIBacktestReview
  } | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function handleRun(e: React.FormEvent) {
    e.preventDefault()
    setLoading(true)
    setResult(null)
    setError(null)
    try {
      const { executeScientificBacktest } = await import('@/actions/backtests')
      const data = await executeScientificBacktest({
        strategyId, symbol, timeframe, startDate, endDate,
        initialCapital: capital,
        runWalkForwardAnalysis: runWF,
        runAIReview: runAI,
      })
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error en backtest')
    } finally {
      setLoading(false)
    }
  }

  if (strategies.length === 0) {
    return (
      <div className="bg-surface border border-border rounded-lg p-8 text-center text-muted-foreground">
        Crea una estrategia primero.
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Form */}
      <div className="bg-surface border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">Backtest Cientifico</h2>
        <p className="text-sm text-muted-foreground mb-4">
          Divide datos en In-Sample (70%) y Out-of-Sample (30%). Detecta sobreajuste automaticamente.
        </p>
        <form onSubmit={handleRun} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Estrategia</label>
              <select value={strategyId} onChange={(e) => setStrategyId(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground">
                {strategies.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Simbolo</label>
              <input type="text" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono" />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Timeframe</label>
              <div className="flex gap-1">
                {TIMEFRAMES.map((tf) => (
                  <button key={tf} type="button" onClick={() => setTimeframe(tf)}
                    className={`px-2 py-1.5 text-xs rounded border transition-colors ${
                      timeframe === tf ? 'bg-primary text-primary-foreground border-primary'
                      : 'bg-background border-border text-muted-foreground hover:border-primary/50'}`}>
                    {tf}
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Fecha inicio</label>
              <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground" />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Fecha fin</label>
              <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground" />
            </div>
            <div>
              <label className="block text-sm font-medium text-muted-foreground mb-1">Capital ($)</label>
              <input type="number" value={capital} onChange={(e) => setCapital(Number(e.target.value))} min={100}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground" />
            </div>
          </div>

          <div className="flex gap-4">
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={runWF} onChange={(e) => setRunWF(e.target.checked)}
                className="rounded border-border" />
              Walk-Forward Analysis
            </label>
            <label className="flex items-center gap-2 text-sm text-muted-foreground">
              <input type="checkbox" checked={runAI} onChange={(e) => setRunAI(e.target.checked)}
                className="rounded border-border" />
              AI Review
            </label>
          </div>

          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-primary text-primary-foreground rounded-md font-medium text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors">
            {loading ? 'Ejecutando backtest cientifico...' : 'Ejecutar Backtest Cientifico'}
          </button>
        </form>
      </div>

      {error && <div className="p-4 rounded-md bg-red-500/10 border border-red-500/20 text-sm text-red-500">{error}</div>}

      {result && (
        <>
          {/* Semaphore Overview */}
          <SemaphoreCard semaphore={result.scientific.semaphore} />

          {/* IS vs OOS Comparison */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <MetricsCard title="In-Sample (70% — Entrenamiento)" metrics={result.scientific.inSample.metrics} badge="IS" />
            <MetricsCard title="Out-of-Sample (30% — Validacion)" metrics={result.scientific.outOfSample.metrics} badge="OOS" />
          </div>

          {/* Degradation */}
          <div className="bg-surface border border-border rounded-lg p-6">
            <h3 className="font-semibold text-foreground mb-3">Degradacion IS → OOS</h3>
            <div className="grid grid-cols-4 gap-4">
              <DegradationItem label="Win Rate" value={result.scientific.degradation.winRate} />
              <DegradationItem label="Sharpe" value={result.scientific.degradation.sharpeRatio} />
              <DegradationItem label="Profit Factor" value={result.scientific.degradation.profitFactor} />
              <DegradationItem label="Overall" value={result.scientific.degradation.overall} highlight />
            </div>
          </div>

          {/* Walk-Forward */}
          {result.walkForward && <WalkForwardCard wf={result.walkForward} />}

          {/* AI Review — HUMAN GATE */}
          {result.aiReview && <AIReviewCard review={result.aiReview} />}

          {/* Equity Curves */}
          <div className="bg-surface border border-border rounded-lg p-6">
            <h3 className="font-semibold text-foreground mb-3">Equity Curve (Combinado)</h3>
            <EquityCurveSimple data={result.scientific.combined.equityCurve} splitDate={result.scientific.splitDate} />
          </div>
        </>
      )}
    </div>
  )
}

function SemaphoreCard({ semaphore }: { semaphore: MetricSemaphore }) {
  const items = [
    { label: 't-Statistic', value: semaphore.tStatistic },
    { label: 'Win Rate', value: semaphore.winRate },
    { label: 'Sharpe', value: semaphore.sharpeRatio },
    { label: 'Drawdown', value: semaphore.maxDrawdown },
    { label: 'Profit Factor', value: semaphore.profitFactor },
    { label: 'Degradacion', value: semaphore.degradation },
  ]

  const overallColor = semaphore.overall === 'green' ? 'border-green-500 bg-green-500/5'
    : semaphore.overall === 'yellow' ? 'border-yellow-500 bg-yellow-500/5' : 'border-red-500 bg-red-500/5'
  const overallText = semaphore.overall === 'green' ? 'APROBADO' : semaphore.overall === 'yellow' ? 'PRECAUCION' : 'RECHAZADO'

  return (
    <div className={`border-2 rounded-lg p-6 ${overallColor}`}>
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-foreground">Semaforo de Validacion</h3>
        <span className={`px-4 py-1.5 rounded-full text-sm font-bold ${
          semaphore.overall === 'green' ? 'bg-green-500 text-white'
          : semaphore.overall === 'yellow' ? 'bg-yellow-500 text-black'
          : 'bg-red-500 text-white'}`}>
          {overallText}
        </span>
      </div>
      <div className="grid grid-cols-6 gap-3">
        {items.map((item) => (
          <div key={item.label} className="text-center">
            <div className={`w-4 h-4 rounded-full mx-auto mb-1 ${
              item.value === 'green' ? 'bg-green-500' : item.value === 'yellow' ? 'bg-yellow-500' : 'bg-red-500'}`} />
            <p className="text-xs text-muted-foreground">{item.label}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

function MetricsCard({ title, metrics, badge }: { title: string; metrics: BacktestMetrics; badge: string }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-5">
      <div className="flex items-center gap-2 mb-3">
        <span className="px-2 py-0.5 bg-primary/10 text-primary rounded text-xs font-bold">{badge}</span>
        <h3 className="font-semibold text-foreground text-sm">{title}</h3>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Metric label="Trades" value={metrics.totalTrades} />
        <Metric label="Win Rate" value={`${(metrics.winRate * 100).toFixed(1)}%`}
          color={metrics.winRate > 0.55 ? 'green' : metrics.winRate > 0.45 ? 'yellow' : 'red'} />
        <Metric label="Net P&L" value={`$${metrics.netProfit.toFixed(0)}`}
          color={metrics.netProfit > 0 ? 'green' : 'red'} />
        <Metric label="Sharpe" value={metrics.sharpeRatio.toFixed(2)}
          color={metrics.sharpeRatio > 1.5 ? 'green' : metrics.sharpeRatio > 1.0 ? 'yellow' : 'red'} />
        <Metric label="t-stat" value={metrics.tStatistic.toFixed(2)}
          color={metrics.tStatistic > 3 ? 'green' : metrics.tStatistic > 2 ? 'yellow' : 'red'} />
        <Metric label="Drawdown" value={`${(metrics.maxDrawdown * 100).toFixed(1)}%`}
          color={metrics.maxDrawdown < 0.15 ? 'green' : metrics.maxDrawdown < 0.25 ? 'yellow' : 'red'} />
      </div>
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: string | number; color?: 'green' | 'yellow' | 'red' }) {
  const c = color === 'green' ? 'text-green-500' : color === 'yellow' ? 'text-yellow-500' : color === 'red' ? 'text-red-500' : 'text-foreground'
  return (
    <div className="bg-background rounded p-2">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`font-bold ${c}`}>{value}</p>
    </div>
  )
}

function DegradationItem({ label, value, highlight }: { label: string; value: number; highlight?: boolean }) {
  const color = Math.abs(value) < 20 ? 'text-green-500' : Math.abs(value) < 40 ? 'text-yellow-500' : 'text-red-500'
  return (
    <div className={`bg-background rounded-md p-3 ${highlight ? 'ring-2 ring-primary/30' : ''}`}>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value.toFixed(1)}%</p>
    </div>
  )
}

function WalkForwardCard({ wf }: { wf: WalkForwardResult }) {
  return (
    <div className="bg-surface border border-border rounded-lg p-6">
      <h3 className="font-semibold text-foreground mb-3">Walk-Forward Analysis ({wf.windows.length} ventanas)</h3>
      <div className="flex gap-4 mb-4">
        <div className="bg-background rounded p-3">
          <p className="text-xs text-muted-foreground">Consistencia</p>
          <p className={`text-lg font-bold ${wf.consistency >= 0.6 ? 'text-green-500' : 'text-red-500'}`}>
            {(wf.consistency * 100).toFixed(0)}%
          </p>
        </div>
        <div className="bg-background rounded p-3">
          <p className="text-xs text-muted-foreground">Sharpe Agregado</p>
          <p className="text-lg font-bold text-foreground">{wf.aggregateTestMetrics.sharpeRatio.toFixed(2)}</p>
        </div>
        <div className="bg-background rounded p-3">
          <p className="text-xs text-muted-foreground">Win Rate Agregado</p>
          <p className="text-lg font-bold text-foreground">{(wf.aggregateTestMetrics.winRate * 100).toFixed(1)}%</p>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b border-border">
              <th className="text-left py-1 text-muted-foreground">#</th>
              <th className="text-right py-1 text-muted-foreground">Train WR</th>
              <th className="text-right py-1 text-muted-foreground">Test WR</th>
              <th className="text-right py-1 text-muted-foreground">Train Sharpe</th>
              <th className="text-right py-1 text-muted-foreground">Test Sharpe</th>
              <th className="text-right py-1 text-muted-foreground">Test P&L</th>
            </tr>
          </thead>
          <tbody>
            {wf.windows.map((w) => (
              <tr key={w.windowIndex} className="border-b border-border/30">
                <td className="py-1 font-mono">W{w.windowIndex + 1}</td>
                <td className="py-1 text-right">{(w.trainMetrics.winRate * 100).toFixed(0)}%</td>
                <td className={`py-1 text-right font-medium ${w.testMetrics.winRate > 0.5 ? 'text-green-500' : 'text-red-500'}`}>
                  {(w.testMetrics.winRate * 100).toFixed(0)}%
                </td>
                <td className="py-1 text-right">{w.trainMetrics.sharpeRatio.toFixed(2)}</td>
                <td className={`py-1 text-right font-medium ${w.testMetrics.sharpeRatio > 0 ? 'text-green-500' : 'text-red-500'}`}>
                  {w.testMetrics.sharpeRatio.toFixed(2)}
                </td>
                <td className={`py-1 text-right ${w.testMetrics.netProfit > 0 ? 'text-green-500' : 'text-red-500'}`}>
                  ${w.testMetrics.netProfit.toFixed(0)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

function AIReviewCard({ review }: { review: AIBacktestReview }) {
  const verdictColors = {
    approve: 'border-green-500 bg-green-500/5',
    caution: 'border-yellow-500 bg-yellow-500/5',
    reject: 'border-red-500 bg-red-500/5',
  }
  const verdictLabels = { approve: 'APROBADO', caution: 'PRECAUCION', reject: 'RECHAZADO' }
  const verdictBadge = {
    approve: 'bg-green-500 text-white',
    caution: 'bg-yellow-500 text-black',
    reject: 'bg-red-500 text-white',
  }

  return (
    <div className={`border-2 rounded-lg p-6 ${verdictColors[review.verdict]}`}>
      <div className="flex items-center gap-2 mb-4">
        <span className="px-2 py-1 bg-primary/10 text-primary rounded text-xs font-bold">AI REVIEW</span>
        <span className="px-2 py-1 bg-primary/10 text-primary rounded text-xs font-bold">HUMAN GATE</span>
        <span className={`px-3 py-1 rounded-full text-xs font-bold ml-auto ${verdictBadge[review.verdict]}`}>
          {verdictLabels[review.verdict]}
        </span>
      </div>

      <p className="text-sm text-foreground mb-4">{review.summary}</p>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
        <div>
          <p className="text-xs font-medium text-green-500 mb-1">Fortalezas</p>
          <ul className="text-xs text-muted-foreground space-y-1">
            {review.strengths.map((s, i) => <li key={i}>+ {s}</li>)}
          </ul>
        </div>
        <div>
          <p className="text-xs font-medium text-red-500 mb-1">Debilidades</p>
          <ul className="text-xs text-muted-foreground space-y-1">
            {review.weaknesses.map((w, i) => <li key={i}>- {w}</li>)}
          </ul>
        </div>
      </div>

      <div className="flex gap-4 text-xs mb-3">
        <span className="text-muted-foreground">
          Riesgo de Overfitting: <span className={`font-bold ${
            review.overfittingRisk === 'low' ? 'text-green-500' : review.overfittingRisk === 'medium' ? 'text-yellow-500' : 'text-red-500'
          }`}>{review.overfittingRisk.toUpperCase()}</span>
        </span>
        <span className="text-muted-foreground">
          Confianza: <span className="font-bold text-foreground">{(review.confidence * 100).toFixed(0)}%</span>
        </span>
      </div>

      <p className="text-sm text-foreground italic bg-background rounded-md p-3">
        {review.recommendation}
      </p>
    </div>
  )
}

function EquityCurveSimple({ data, splitDate }: {
  data: { timestamp: string; equity: number }[]
  splitDate: string
}) {
  if (data.length === 0) return null

  const min = Math.min(...data.map((d) => d.equity))
  const max = Math.max(...data.map((d) => d.equity))
  const range = max - min || 1
  const splitIdx = data.findIndex((d) => d.timestamp >= splitDate)

  // Simple SVG equity curve
  const w = 800
  const h = 200
  const points = data.map((d, i) => {
    const x = (i / (data.length - 1)) * w
    const y = h - ((d.equity - min) / range) * h
    return `${x},${y}`
  }).join(' ')

  const splitX = splitIdx > 0 ? (splitIdx / (data.length - 1)) * w : 0

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-48">
        {/* OOS background */}
        {splitX > 0 && (
          <rect x={splitX} y={0} width={w - splitX} height={h} fill="rgba(59,130,246,0.05)" />
        )}
        {/* Split line */}
        {splitX > 0 && (
          <line x1={splitX} y1={0} x2={splitX} y2={h} stroke="rgba(59,130,246,0.3)" strokeWidth={2} strokeDasharray="4" />
        )}
        {/* Equity line */}
        <polyline fill="none" stroke="rgb(34,197,94)" strokeWidth={2} points={points} />
        {/* Labels */}
        <text x={10} y={15} fill="rgb(156,163,175)" fontSize={12}>IS</text>
        {splitX > 0 && <text x={splitX + 10} y={15} fill="rgb(59,130,246)" fontSize={12}>OOS</text>}
        <text x={10} y={h - 5} fill="rgb(156,163,175)" fontSize={10}>${min.toFixed(0)}</text>
        <text x={w - 60} y={15} fill="rgb(156,163,175)" fontSize={10}>${max.toFixed(0)}</text>
      </svg>
    </div>
  )
}

function getMonthsAgo(months: number): string {
  const d = new Date()
  d.setMonth(d.getMonth() - months)
  return d.toISOString().split('T')[0]
}

function today(): string {
  return new Date().toISOString().split('T')[0]
}
