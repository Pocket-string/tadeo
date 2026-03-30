'use client'

import { useState } from 'react'
import Link from 'next/link'
import { runScanner, getAvailableData } from '@/actions/scanner'
import { createStrategyFromScanner } from '@/actions/strategies'
import type { ScanResult, Opportunity } from '../types'

function ScoreBar({ value, label }: { value: number; label: string }) {
  const color = value >= 70 ? 'bg-green-500' : value >= 50 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-foreground/40">{label}</span>
      <div className="flex-1 h-2 bg-border rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right text-foreground">{value}</span>
    </div>
  )
}

function RegimeBadge({ regime }: { regime: string }) {
  const colors: Record<string, string> = {
    trending: 'bg-green-500/20 text-green-400 border-green-500/30',
    ranging: 'bg-yellow-500/20 text-yellow-400 border-yellow-500/30',
    volatile: 'bg-red-500/20 text-red-400 border-red-500/30',
    choppy: 'bg-red-500/20 text-red-400 border-red-500/30',
  }
  return (
    <span className={`px-2 py-0.5 text-xs rounded border ${colors[regime] ?? 'bg-foreground/10 text-foreground/60'}`}>
      {regime.toUpperCase()}
    </span>
  )
}

function OpportunityCard({
  opp,
  onApprove,
  isApproving,
}: {
  opp: Opportunity
  onApprove: (opp: Opportunity) => void
  isApproving: boolean
}) {
  const signalColor = opp.signal === 'buy' ? 'text-green-400' : 'text-red-400'
  const signalBg = opp.signal === 'buy' ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'

  return (
    <div className={`border rounded-lg p-4 ${signalBg} space-y-3`}>
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="font-bold text-lg text-foreground">{opp.symbol}</span>
          <span className="text-xs text-foreground/40">{opp.timeframe}</span>
          <RegimeBadge regime={opp.regime.regime} />
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-2xl font-bold ${opp.score.total >= 70 ? 'text-green-400' : opp.score.total >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
            {opp.score.total}
          </span>
          <span className="text-xs text-foreground/40">/100</span>
        </div>
      </div>

      {/* Signal + Composite Confidence */}
      <div className="flex items-center gap-4">
        <span className={`text-xl font-bold uppercase ${signalColor}`}>
          {opp.signal}
        </span>
        <span className="text-foreground">@ ${opp.price.toFixed(2)}</span>
        <span className="text-xs text-foreground/40">R:R {opp.riskRewardRatio.toFixed(1)}:1</span>
        <span className={`text-xs px-2 py-0.5 rounded ${opp.compositeConfidence >= 0.6 ? 'bg-green-500/20 text-green-400' : 'bg-yellow-500/20 text-yellow-400'}`}>
          {(opp.compositeConfidence * 100).toFixed(0)}% conf
        </span>
      </div>

      {/* Active Signals */}
      {opp.activeSignals.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {opp.activeSignals.map((sig, i) => {
            const isLong = sig.includes(':long')
            return (
              <span
                key={i}
                className={`text-[10px] px-1.5 py-0.5 rounded ${isLong ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}
              >
                {sig.split(':')[0]}
              </span>
            )
          })}
        </div>
      )}

      {/* Stops */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-surface border border-border p-2 rounded">
          <span className="text-foreground/40 block">Stop Loss</span>
          <span className="text-red-400 font-mono">${opp.stopLoss.toFixed(2)}</span>
        </div>
        <div className="bg-surface border border-border p-2 rounded">
          <span className="text-foreground/40 block">Take Profit</span>
          <span className="text-green-400 font-mono">${opp.takeProfit.toFixed(2)}</span>
        </div>
        <div className="bg-surface border border-border p-2 rounded">
          <span className="text-foreground/40 block">ATR</span>
          <span className="text-foreground font-mono">${opp.atr.toFixed(2)}</span>
        </div>
      </div>

      {/* Scores */}
      <div className="space-y-1">
        <ScoreBar value={opp.score.trend} label="Trend" />
        <ScoreBar value={opp.score.momentum} label="Momentum" />
        <ScoreBar value={opp.score.volatility} label="Vol" />
        <ScoreBar value={opp.score.volume} label="Volume" />
        <ScoreBar value={opp.score.riskReward} label="R:R" />
      </div>

      {/* Indicators */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <span className="text-foreground/40">RSI:</span>{' '}
          <span className="text-foreground">{opp.indicators.rsi.toFixed(1)}</span>
        </div>
        <div>
          <span className="text-foreground/40">ADX:</span>{' '}
          <span className="text-foreground">{opp.indicators.adx.toFixed(1)}</span>
        </div>
        <div>
          <span className="text-foreground/40">MACD:</span>{' '}
          <span className={opp.indicators.macdHistogram > 0 ? 'text-green-400' : 'text-red-400'}>
            {opp.indicators.macdHistogram.toFixed(4)}
          </span>
        </div>
      </div>

      {/* Quick Backtest */}
      {opp.quickBacktest && (
        <div className="border-t border-border pt-2 text-xs">
          <span className="text-foreground/40">Quick Backtest ({opp.quickBacktest.sampleSize} candles):</span>
          <div className="grid grid-cols-4 gap-2 mt-1">
            <div>
              <span className="text-foreground/40">Trades:</span>{' '}
              <span className="text-foreground">{opp.quickBacktest.metrics.totalTrades}</span>
            </div>
            <div>
              <span className="text-foreground/40">Win:</span>{' '}
              <span className={opp.quickBacktest.metrics.winRate > 0.5 ? 'text-green-400' : 'text-red-400'}>
                {(opp.quickBacktest.metrics.winRate * 100).toFixed(0)}%
              </span>
            </div>
            <div>
              <span className="text-foreground/40">PF:</span>{' '}
              <span className="text-foreground">{opp.quickBacktest.metrics.profitFactor.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-foreground/40">Sharpe:</span>{' '}
              <span className="text-foreground">{opp.quickBacktest.metrics.sharpeRatio.toFixed(2)}</span>
            </div>
          </div>
        </div>
      )}

      {/* Approve Button */}
      <button
        onClick={() => onApprove(opp)}
        disabled={isApproving}
        className={`w-full py-2 rounded font-medium text-sm transition-colors ${
          opp.signal === 'buy'
            ? 'bg-green-600 hover:bg-green-500 text-white'
            : 'bg-red-600 hover:bg-red-500 text-white'
        } disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {isApproving ? 'Creando estrategia...' : `Aprobar ${opp.signal.toUpperCase()} → Backtest Cientifico`}
      </button>
    </div>
  )
}

export default function ScannerDashboard() {
  const [scanning, setScanning] = useState(false)
  const [result, setResult] = useState<ScanResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  const [approvedStrategy, setApprovedStrategy] = useState<{ id: string; name: string } | null>(null)
  const [availableData, setAvailableData] = useState<{ symbol: string; timeframe: string; candleCount: number; candle_count?: number }[]>([])

  async function handleScan() {
    setScanning(true)
    setError(null)
    setApprovedStrategy(null)
    try {
      const data = await getAvailableData()
      setAvailableData(data)

      // Only scan pairs/timeframes that have data
      const pairs = [...new Set(data.map(d => d.symbol))]
      const timeframes = [...new Set(data.map(d => d.timeframe))] as ('1h' | '4h' | '1d')[]

      if (pairs.length === 0) {
        setError('No hay datos de mercado. Ingesta datos primero en Market Data.')
        return
      }

      const scanResult = await runScanner({ pairs, timeframes })
      setResult(scanResult)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error escaneando')
    } finally {
      setScanning(false)
    }
  }

  async function handleApprove(opp: Opportunity) {
    const id = `${opp.symbol}-${opp.timeframe}`
    setApprovingId(id)
    setApprovedStrategy(null)
    try {
      const strategyName = `Scanner ${opp.signal.toUpperCase()} ${opp.symbol} ${opp.timeframe} (Score: ${opp.score.total})`
      const result = await createStrategyFromScanner({
        name: strategyName,
        description: `Auto-detected by Scanner. Regime: ${opp.regime.regime}, ADX: ${opp.indicators.adx.toFixed(1)}, RSI: ${opp.indicators.rsi.toFixed(1)}, R:R: ${opp.riskRewardRatio.toFixed(1)}:1`,
        parameters: {
          ema_fast: 9,
          ema_slow: 21,
          rsi_period: 14,
          rsi_oversold: 30,
          rsi_overbought: 70,
          macd_fast: 12,
          macd_slow: 26,
          macd_signal: 9,
          bb_period: 20,
          bb_std_dev: 2,
          stop_loss_pct: Math.abs(opp.price - opp.stopLoss) / opp.price,
          take_profit_pct: Math.abs(opp.takeProfit - opp.price) / opp.price,
        },
      })
      setApprovedStrategy({ id: result.id, name: result.name })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Error creando estrategia')
    } finally {
      setApprovingId(null)
    }
  }

  return (
    <div className="p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h1 className="text-xl md:text-2xl font-bold text-foreground">Opportunity Scanner</h1>
          <p className="text-foreground/60 text-sm">
            Escanea automáticamente todos los pares disponibles y rankea las mejores oportunidades
          </p>
        </div>
        <button
          onClick={handleScan}
          disabled={scanning}
          className="w-full sm:w-auto px-6 py-3 bg-primary-500 hover:bg-primary-600 text-white rounded-xl font-medium transition-colors disabled:opacity-50"
        >
          {scanning ? 'Escaneando...' : 'Escanear Mercado'}
        </button>
      </div>

      {/* Available Data */}
      {availableData.length > 0 && (
        <div className="text-xs text-foreground/40">
          Datos disponibles: {availableData.map(d => `${d.symbol} ${d.timeframe} (${d.candleCount ?? d.candle_count ?? '?'})`).join(' | ')}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
          {error}
        </div>
      )}

      {/* Next step banner after approving an opportunity */}
      {approvedStrategy && (
        <div className="bg-green-500/10 border border-green-500/30 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <span className="text-green-400 text-lg">✅</span>
            <span className="font-semibold text-green-400">Estrategia creada exitosamente</span>
          </div>
          <p className="text-sm text-foreground/70">
            <span className="font-medium text-foreground">&ldquo;{approvedStrategy.name}&rdquo;</span> está lista para validarse.
            El siguiente paso es ejecutar el Backtest Científico para ver si esta estrategia ha funcionado históricamente.
          </p>
          <div className="bg-surface border border-border rounded-lg p-3 text-xs text-foreground/60 space-y-1">
            <p className="font-medium text-foreground/80">¿Qué pasa en el backtest?</p>
            <p>El sistema prueba la estrategia con datos históricos reales. Si el resultado es verde ✅, puedes activar el agente para que opere en modo simulado (paper trading) sin arriesgar dinero real.</p>
          </div>
          <Link
            href={`/backtests/scientific?strategy=${approvedStrategy.id}`}
            className="inline-flex items-center gap-2 px-5 py-2.5 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium text-sm transition-colors"
          >
            Ir al Backtest Científico →
          </Link>
        </div>
      )}

      {/* Scan Results */}
      {result && (
        <>
          <div className="flex flex-wrap items-center gap-4 text-sm text-foreground/60">
            <span>Escaneados: {result.scannedPairs} pares × {result.scannedTimeframes} timeframes</span>
            <span>Duración: {result.scanDuration}ms</span>
            <span>Oportunidades: {result.opportunities.length}</span>
          </div>

          {result.opportunities.length === 0 ? (
            <div className="bg-surface border border-border rounded-lg p-8 text-center">
              <p className="text-foreground/60 text-lg">No hay oportunidades con score {'>'} 60 en este momento</p>
              <p className="text-foreground/40 text-sm mt-2">
                El mercado puede estar lateral (choppy) o volátil. Esto es normal — el scanner protege tu capital.
              </p>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {result.opportunities.map((opp, i) => (
                <OpportunityCard
                  key={`${opp.symbol}-${opp.timeframe}-${i}`}
                  opp={opp}
                  onApprove={handleApprove}
                  isApproving={approvingId === `${opp.symbol}-${opp.timeframe}`}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Instructions when no scan yet */}
      {!result && !scanning && (
        <div className="bg-surface border border-border rounded-lg p-8 text-center space-y-4">
          <div className="text-4xl">🔍</div>
          <h2 className="text-xl font-bold text-foreground">Listo para escanear</h2>
          <p className="text-foreground/60 max-w-lg mx-auto">
            El scanner analiza todos tus pares disponibles, detecta el régimen de mercado,
            y solo presenta oportunidades con score {'>'} 60/100 en mercados con tendencia clara.
          </p>
          <div className="text-foreground/40 text-sm space-y-1">
            <p>Filtros activos: ADX {'>'} 20 (tendencia), ATR normal (no volátil), confluencia de indicadores</p>
            <p>Stops dinámicos basados en ATR (se adaptan a la volatilidad real)</p>
          </div>
        </div>
      )}
    </div>
  )
}
