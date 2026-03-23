'use client'

import { useState, useEffect } from 'react'
import type { FullAnalysisResult } from '@/actions/ai-analysis'
import type { StrategyProposal, MarketAnalysis } from '../types'

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const

export function AIAnalysisPanel({ availableSymbols }: { availableSymbols: string[] }) {
  const [symbol, setSymbol] = useState(availableSymbols[0] ?? 'BTCUSDT')
  const [timeframe, setTimeframe] = useState('1h')
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState<FullAnalysisResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [history, setHistory] = useState<{ id: string; name: string; created_at: string; session?: { status: string; net_pnl: number; total_trades: number; winning_trades: number } }[]>([])
  const [multiAnalysis, setMultiAnalysis] = useState<{ symbol: string; timeframe: string; analysis: MarketAnalysis }[]>([])
  const [multiLoading, setMultiLoading] = useState(false)

  useEffect(() => {
    import('@/actions/ai-analysis').then(({ getAIStrategyHistory }) => {
      getAIStrategyHistory().then(setHistory).catch(() => {})
    })
  }, [saved])

  async function handleAnalyze() {
    setLoading(true)
    setResult(null)
    setError(null)
    setSaved(false)

    try {
      const { runFullAnalysis } = await import('@/actions/ai-analysis')
      const data = await runFullAnalysis({ symbol, timeframe })
      setResult(data)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error en analisis AI')
    } finally {
      setLoading(false)
    }
  }

  async function handleApprove(proposal: StrategyProposal) {
    setSaving(true)
    try {
      const { approveAndSaveStrategy } = await import('@/actions/ai-analysis')
      await approveAndSaveStrategy(proposal)
      setSaved(true)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error al guardar estrategia')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Input Form */}
      <div className="bg-surface border border-border rounded-lg p-6">
        <h2 className="text-lg font-semibold text-foreground mb-4">AI Market Analyst</h2>
        <p className="text-sm text-muted-foreground mb-4">
          La IA analiza indicadores tecnicos y propone una estrategia optimizada. Tu decides si aprobarla.
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Simbolo</label>
            {availableSymbols.length > 0 ? (
              <select
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
              >
                {availableSymbols.map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : (
              <input
                type="text"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value.toUpperCase())}
                className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground font-mono"
              />
            )}
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

          <div className="flex items-end gap-2">
            <button
              onClick={handleAnalyze}
              disabled={loading}
              className="flex-1 py-2.5 bg-primary text-primary-foreground rounded-md font-medium text-sm hover:bg-primary/90 disabled:opacity-50 transition-colors"
            >
              {loading ? 'Analizando...' : 'Analizar con AI'}
            </button>
            <button
              onClick={async () => {
                setMultiLoading(true)
                setMultiAnalysis([])
                try {
                  const { runQuickAnalysisAll } = await import('@/actions/ai-analysis')
                  const data = await runQuickAnalysisAll()
                  setMultiAnalysis(data)
                } catch {
                  setError('Error al analizar multiples simbolos')
                } finally {
                  setMultiLoading(false)
                }
              }}
              disabled={multiLoading}
              className="py-2.5 px-4 border border-border rounded-md text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors disabled:opacity-50 whitespace-nowrap"
            >
              {multiLoading ? 'Escaneando...' : 'Analizar activos'}
            </button>
          </div>
        </div>
      </div>

      {/* Multi-Symbol Analysis Grid */}
      {multiAnalysis.length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-6">
          <h3 className="font-semibold text-foreground mb-4">Analisis Multi-Simbolo</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">Par</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">Tendencia</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">RSI</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">Volatilidad</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">Sesgo</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Confianza</th>
                </tr>
              </thead>
              <tbody>
                {multiAnalysis.map(({ symbol: s, timeframe: tf, analysis: a }) => (
                  <tr
                    key={`${s}-${tf}`}
                    className="border-b border-border/50 hover:bg-background/50 cursor-pointer"
                    onClick={() => { setSymbol(s); setTimeframe(tf); }}
                  >
                    <td className="py-2.5 font-mono font-medium text-foreground">{s} <span className="text-muted-foreground text-xs">{tf}</span></td>
                    <td className="py-2.5">
                      <span className={a.trend.direction === 'bullish' ? 'text-green-500' : a.trend.direction === 'bearish' ? 'text-red-500' : 'text-yellow-500'}>
                        {a.trend.direction === 'bullish' ? '↑' : a.trend.direction === 'bearish' ? '↓' : '→'} {a.trend.strength}
                      </span>
                    </td>
                    <td className="py-2.5">
                      <span className={a.momentum.rsiZone === 'oversold' ? 'text-green-500' : a.momentum.rsiZone === 'overbought' ? 'text-red-500' : 'text-muted-foreground'}>
                        {a.momentum.rsiZone}
                      </span>
                    </td>
                    <td className="py-2.5 text-muted-foreground capitalize">{a.volatility.state}</td>
                    <td className="py-2.5"><OverallBiasBadge bias={a.overallBias} /></td>
                    <td className="py-2.5 text-right font-mono">{Math.round(a.confidence * 100)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground mt-2">Click en un par para analizarlo en detalle</p>
        </div>
      )}

      {/* AI Strategy History */}
      {history.length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-6">
          <h3 className="font-semibold text-foreground mb-3">Historial de Estrategias AI</h3>
          <div className="space-y-2">
            {history.map(h => (
              <div key={h.id} className="flex items-center justify-between text-sm p-2 bg-background rounded-md">
                <div>
                  <span className="text-foreground font-medium">{h.name.replace('[AI Generated] ', '')}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    {new Date(h.created_at).toLocaleDateString('es')}
                  </span>
                </div>
                {h.session ? (
                  <div className="flex items-center gap-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                      h.session.status === 'active' ? 'bg-green-500/10 text-green-500' : 'bg-foreground/10 text-muted-foreground'
                    }`}>
                      {h.session.status}
                    </span>
                    <span className={`font-mono text-sm ${h.session.net_pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                      {h.session.net_pnl >= 0 ? '+' : ''}${h.session.net_pnl.toFixed(2)}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {h.session.total_trades > 0 ? `WR: ${Math.round((h.session.winning_trades / h.session.total_trades) * 100)}%` : '0 trades'}
                    </span>
                  </div>
                ) : (
                  <span className="text-xs text-muted-foreground">Sin sesion activa</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-md bg-red-500/10 border border-red-500/20 text-sm text-red-500">
          {error}
        </div>
      )}

      {/* Analysis Results */}
      {result && (
        <>
          {/* Market Analysis */}
          <div className="bg-surface border border-border rounded-lg p-6">
            <h3 className="font-semibold text-foreground mb-4">Analisis de Mercado</h3>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
              {/* Trend */}
              <div className="bg-background rounded-md p-4">
                <p className="text-xs text-muted-foreground mb-1">Tendencia</p>
                <div className="flex items-center gap-2">
                  <BiasIcon bias={result.analysis.trend.direction} />
                  <span className="font-medium text-foreground capitalize">
                    {result.analysis.trend.direction}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    ({result.analysis.trend.strength})
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{result.analysis.trend.description}</p>
              </div>

              {/* Momentum */}
              <div className="bg-background rounded-md p-4">
                <p className="text-xs text-muted-foreground mb-1">Momentum</p>
                <div className="flex items-center gap-2">
                  <span className="font-mono text-foreground">RSI: {result.context.rsiValue.toFixed(1)}</span>
                  <span className={`text-xs px-1.5 py-0.5 rounded ${
                    result.analysis.momentum.rsiZone === 'oversold' ? 'bg-green-500/10 text-green-500'
                    : result.analysis.momentum.rsiZone === 'overbought' ? 'bg-red-500/10 text-red-500'
                    : 'bg-yellow-500/10 text-yellow-500'
                  }`}>
                    {result.analysis.momentum.rsiZone}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{result.analysis.momentum.description}</p>
              </div>

              {/* Volatility */}
              <div className="bg-background rounded-md p-4">
                <p className="text-xs text-muted-foreground mb-1">Volatilidad</p>
                <div className="flex items-center gap-2">
                  <span className="font-medium text-foreground capitalize">{result.analysis.volatility.state}</span>
                  <span className="text-xs text-muted-foreground">
                    BB Width: {result.analysis.volatility.bbWidth.toFixed(4)}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground mt-2">{result.analysis.volatility.description}</p>
              </div>
            </div>

            {/* Overall */}
            <div className="flex items-center justify-between p-4 bg-background rounded-md">
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground">Sesgo General:</span>
                <OverallBiasBadge bias={result.analysis.overallBias} />
              </div>
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">Confianza:</span>
                <ConfidenceBar value={result.analysis.confidence} />
              </div>
            </div>

            <p className="text-sm text-muted-foreground mt-3 italic">
              {result.analysis.reasoning}
            </p>
          </div>

          {/* Strategy Proposal — HUMAN GATE */}
          <div className="bg-surface border-2 border-primary/30 rounded-lg p-6">
            <div className="flex items-center gap-2 mb-4">
              <span className="px-2 py-1 bg-primary/10 text-primary rounded text-xs font-bold">HUMAN GATE</span>
              <h3 className="font-semibold text-foreground">Estrategia Propuesta por AI</h3>
            </div>

            <div className="mb-4">
              <h4 className="font-medium text-foreground">{result.proposal.name}</h4>
              <p className="text-sm text-muted-foreground mt-1">{result.proposal.description}</p>
              <div className="flex gap-2 mt-2">
                <span className={`text-xs px-2 py-0.5 rounded ${
                  result.proposal.riskLevel === 'conservative' ? 'bg-green-500/10 text-green-500'
                  : result.proposal.riskLevel === 'moderate' ? 'bg-yellow-500/10 text-yellow-500'
                  : 'bg-red-500/10 text-red-500'
                }`}>
                  {result.proposal.riskLevel}
                </span>
                {result.proposal.suitableTimeframes.map((tf) => (
                  <span key={tf} className="text-xs px-2 py-0.5 rounded bg-primary/10 text-primary">
                    {tf}
                  </span>
                ))}
              </div>
            </div>

            {/* Parameters Grid */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
              {Object.entries(result.proposal.parameters).map(([key, val]) => (
                <div key={key} className="bg-background rounded-md p-2">
                  <p className="text-xs text-muted-foreground">{formatParamName(key)}</p>
                  <p className="font-mono font-medium text-foreground">
                    {key.includes('pct') ? `${(Number(val) * 100).toFixed(1)}%` : String(val)}
                  </p>
                </div>
              ))}
            </div>

            <p className="text-sm text-muted-foreground mb-4 italic">
              {result.proposal.reasoning}
            </p>

            {/* Approval Buttons */}
            <div className="flex gap-3">
              {saved ? (
                <div className="flex-1 py-2.5 bg-green-500/10 border border-green-500/20 rounded-md text-center text-sm text-green-500 font-medium">
                  Estrategia guardada. Ve a Estrategias para hacer backtest.
                </div>
              ) : (
                <>
                  <button
                    onClick={() => handleApprove(result.proposal)}
                    disabled={saving}
                    className="flex-1 py-2.5 bg-green-600 text-white rounded-md font-medium text-sm hover:bg-green-700 disabled:opacity-50 transition-colors"
                  >
                    {saving ? 'Guardando...' : 'Aprobar y Guardar Estrategia'}
                  </button>
                  <button
                    onClick={handleAnalyze}
                    disabled={loading}
                    className="px-4 py-2.5 border border-border rounded-md text-sm text-muted-foreground hover:text-foreground hover:border-primary/50 transition-colors"
                  >
                    Regenerar
                  </button>
                </>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function BiasIcon({ bias }: { bias: string }) {
  if (bias === 'bullish') return <span className="text-green-500 text-lg">↑</span>
  if (bias === 'bearish') return <span className="text-red-500 text-lg">↓</span>
  return <span className="text-yellow-500 text-lg">→</span>
}

function OverallBiasBadge({ bias }: { bias: string }) {
  const colors: Record<string, string> = {
    strong_buy: 'bg-green-500 text-white',
    buy: 'bg-green-500/20 text-green-500',
    neutral: 'bg-yellow-500/20 text-yellow-500',
    sell: 'bg-red-500/20 text-red-500',
    strong_sell: 'bg-red-500 text-white',
  }
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-bold ${colors[bias] ?? 'bg-gray-500/20 text-gray-500'}`}>
      {bias.replace('_', ' ').toUpperCase()}
    </span>
  )
}

function ConfidenceBar({ value }: { value: number }) {
  const pct = Math.round(value * 100)
  const color = pct >= 70 ? 'bg-green-500' : pct >= 40 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2">
      <div className="w-24 h-2 bg-background rounded-full overflow-hidden">
        <div className={`h-full rounded-full ${color}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-mono text-foreground">{pct}%</span>
    </div>
  )
}

function formatParamName(key: string): string {
  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (l) => l.toUpperCase())
    .replace('Pct', '%')
    .replace('Bb', 'BB')
    .replace('Ema', 'EMA')
    .replace('Rsi', 'RSI')
    .replace('Macd', 'MACD')
}
