'use client'

import { useState } from 'react'
import { runScanner, getAvailableData } from '@/actions/scanner'
import { createStrategyFromScanner } from '@/actions/strategies'
import type { ScanResult, Opportunity } from '../types'

function ScoreBar({ value, label }: { value: number; label: string }) {
  const color = value >= 70 ? 'bg-green-500' : value >= 50 ? 'bg-yellow-500' : 'bg-red-500'
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 text-zinc-400">{label}</span>
      <div className="flex-1 h-2 bg-zinc-800 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${value}%` }} />
      </div>
      <span className="w-8 text-right text-zinc-300">{value}</span>
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
    <span className={`px-2 py-0.5 text-xs rounded border ${colors[regime] ?? 'bg-zinc-700 text-zinc-300'}`}>
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
          <span className="font-bold text-lg text-white">{opp.symbol}</span>
          <span className="text-xs text-zinc-400">{opp.timeframe}</span>
          <RegimeBadge regime={opp.regime.regime} />
        </div>
        <div className="flex items-center gap-2">
          <span className={`text-2xl font-bold ${opp.score.total >= 70 ? 'text-green-400' : opp.score.total >= 50 ? 'text-yellow-400' : 'text-red-400'}`}>
            {opp.score.total}
          </span>
          <span className="text-xs text-zinc-500">/100</span>
        </div>
      </div>

      {/* Signal */}
      <div className="flex items-center gap-4">
        <span className={`text-xl font-bold uppercase ${signalColor}`}>
          {opp.signal}
        </span>
        <span className="text-zinc-300">@ ${opp.price.toFixed(2)}</span>
        <span className="text-xs text-zinc-500">R:R {opp.riskRewardRatio.toFixed(1)}:1</span>
      </div>

      {/* Stops */}
      <div className="grid grid-cols-3 gap-2 text-xs">
        <div className="bg-zinc-900 p-2 rounded">
          <span className="text-zinc-500 block">Stop Loss</span>
          <span className="text-red-400 font-mono">${opp.stopLoss.toFixed(2)}</span>
        </div>
        <div className="bg-zinc-900 p-2 rounded">
          <span className="text-zinc-500 block">Take Profit</span>
          <span className="text-green-400 font-mono">${opp.takeProfit.toFixed(2)}</span>
        </div>
        <div className="bg-zinc-900 p-2 rounded">
          <span className="text-zinc-500 block">ATR</span>
          <span className="text-zinc-300 font-mono">${opp.atr.toFixed(2)}</span>
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
          <span className="text-zinc-500">RSI:</span>{' '}
          <span className="text-zinc-300">{opp.indicators.rsi.toFixed(1)}</span>
        </div>
        <div>
          <span className="text-zinc-500">ADX:</span>{' '}
          <span className="text-zinc-300">{opp.indicators.adx.toFixed(1)}</span>
        </div>
        <div>
          <span className="text-zinc-500">MACD:</span>{' '}
          <span className={opp.indicators.macdHistogram > 0 ? 'text-green-400' : 'text-red-400'}>
            {opp.indicators.macdHistogram.toFixed(4)}
          </span>
        </div>
      </div>

      {/* Quick Backtest */}
      {opp.quickBacktest && (
        <div className="border-t border-zinc-700 pt-2 text-xs">
          <span className="text-zinc-500">Quick Backtest ({opp.quickBacktest.sampleSize} candles):</span>
          <div className="grid grid-cols-4 gap-2 mt-1">
            <div>
              <span className="text-zinc-500">Trades:</span>{' '}
              <span className="text-zinc-300">{opp.quickBacktest.metrics.totalTrades}</span>
            </div>
            <div>
              <span className="text-zinc-500">Win:</span>{' '}
              <span className={opp.quickBacktest.metrics.winRate > 0.5 ? 'text-green-400' : 'text-red-400'}>
                {(opp.quickBacktest.metrics.winRate * 100).toFixed(0)}%
              </span>
            </div>
            <div>
              <span className="text-zinc-500">PF:</span>{' '}
              <span className="text-zinc-300">{opp.quickBacktest.metrics.profitFactor.toFixed(2)}</span>
            </div>
            <div>
              <span className="text-zinc-500">Sharpe:</span>{' '}
              <span className="text-zinc-300">{opp.quickBacktest.metrics.sharpeRatio.toFixed(2)}</span>
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
  const [approveResult, setApproveResult] = useState<string | null>(null)
  const [availableData, setAvailableData] = useState<{ symbol: string; timeframe: string; candleCount: number; candle_count?: number }[]>([])

  async function handleScan() {
    setScanning(true)
    setError(null)
    setApproveResult(null)
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
      setApproveResult(`Estrategia "${result.name}" creada. Ve a Backtests > Scientific para validar.`)
    } catch (err) {
      setApproveResult(`Error: ${err instanceof Error ? err.message : 'Unknown'}`)
    } finally {
      setApprovingId(null)
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white">Opportunity Scanner</h1>
          <p className="text-zinc-400 text-sm">
            Escanea automáticamente todos los pares disponibles y rankea las mejores oportunidades
          </p>
        </div>
        <button
          onClick={handleScan}
          disabled={scanning}
          className="px-6 py-3 bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
        >
          {scanning ? 'Escaneando...' : 'Escanear Mercado'}
        </button>
      </div>

      {/* Available Data */}
      {availableData.length > 0 && (
        <div className="text-xs text-zinc-500">
          Datos disponibles: {availableData.map(d => `${d.symbol} ${d.timeframe} (${d.candleCount ?? d.candle_count ?? '?'})`).join(' | ')}
        </div>
      )}

      {error && (
        <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-4 text-red-400">
          {error}
        </div>
      )}

      {approveResult && (
        <div className="bg-blue-500/10 border border-blue-500/30 rounded-lg p-4 text-blue-400">
          {approveResult}
        </div>
      )}

      {/* Scan Results */}
      {result && (
        <>
          <div className="flex items-center gap-4 text-sm text-zinc-400">
            <span>Escaneados: {result.scannedPairs} pares × {result.scannedTimeframes} timeframes</span>
            <span>Duración: {result.scanDuration}ms</span>
            <span>Oportunidades: {result.opportunities.length}</span>
          </div>

          {result.opportunities.length === 0 ? (
            <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center">
              <p className="text-zinc-400 text-lg">No hay oportunidades con score {'>'} 60 en este momento</p>
              <p className="text-zinc-500 text-sm mt-2">
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
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-8 text-center space-y-4">
          <div className="text-4xl">🔍</div>
          <h2 className="text-xl font-bold text-white">Listo para escanear</h2>
          <p className="text-zinc-400 max-w-lg mx-auto">
            El scanner analiza todos tus pares disponibles, detecta el régimen de mercado,
            y solo presenta oportunidades con score {'>'} 60/100 en mercados con tendencia clara.
          </p>
          <div className="text-zinc-500 text-sm space-y-1">
            <p>Filtros activos: ADX {'>'} 20 (tendencia), ATR normal (no volátil), confluencia de indicadores</p>
            <p>Stops dinámicos basados en ATR (se adaptan a la volatilidad real)</p>
          </div>
        </div>
      )}
    </div>
  )
}
