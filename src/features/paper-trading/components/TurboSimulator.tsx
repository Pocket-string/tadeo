'use client'

import { useState } from 'react'
import { runTurboSim, runOptimizer, deployOptimizedStrategy } from '@/actions/turbo'
import type { SimResult, OptimizationResult } from '../services/turboSimulator'
import type { StrategyParameters } from '@/types/database'
import { DEFAULT_STRATEGY_PARAMS } from '@/types/database'
import type { Timeframe } from '@/features/market-data/types'
import { RISK_TIERS, type RiskTier } from '../types'

import { TRADING_PAIRS } from '@/shared/lib/trading-pairs'

const SYMBOLS = [...TRADING_PAIRS]
const TIMEFRAMES: Timeframe[] = ['5m', '15m', '1h', '4h']
const RISK_TIER_KEYS: RiskTier[] = ['conservative', 'moderate', 'aggressive']

export function TurboSimulator() {
  const [symbol, setSymbol] = useState('SOLUSDT')
  const [timeframe, setTimeframe] = useState<Timeframe>('1h')
  const [capital, setCapital] = useState(100)
  const [months, setMonths] = useState(12)
  const [running, setRunning] = useState(false)
  const [optimizing, setOptimizing] = useState(false)
  const [simResult, setSimResult] = useState<SimResult | null>(null)
  const [optResult, setOptResult] = useState<OptimizationResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [multiResults, setMultiResults] = useState<SimResult[]>([])
  const [deploying, setDeploying] = useState(false)
  const [deployResult, setDeployResult] = useState<{ strategyId: string; sessionId: string } | null>(null)
  const [selectedRiskTier, setSelectedRiskTier] = useState<RiskTier>('moderate')
  const [showRiskSelector, setShowRiskSelector] = useState(false)

  const handleTurboSim = async () => {
    setRunning(true)
    setError(null)
    setSimResult(null)
    try {
      const result = await runTurboSim({
        symbol,
        timeframe: timeframe as Timeframe,
        params: DEFAULT_STRATEGY_PARAMS,
        capitalStart: capital,
        monthsBack: months,
      })
      setSimResult(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Simulation failed')
    } finally {
      setRunning(false)
    }
  }

  const handleMultiSim = async () => {
    setRunning(true)
    setError(null)
    setMultiResults([])
    try {
      const results: SimResult[] = []
      for (const sym of SYMBOLS) {
        for (const tf of TIMEFRAMES) {
          try {
            const r = await runTurboSim({
              symbol: sym,
              timeframe: tf as Timeframe,
              params: DEFAULT_STRATEGY_PARAMS,
              capitalStart: capital,
              monthsBack: months,
            })
            results.push(r)
          } catch {
            // Skip pairs without data
          }
        }
      }
      setMultiResults(results.sort((a, b) => b.metrics.netPnlPct - a.metrics.netPnlPct))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Multi-sim failed')
    } finally {
      setRunning(false)
    }
  }

  const handleOptimize = async () => {
    setOptimizing(true)
    setError(null)
    setOptResult(null)
    try {
      const baseParams = simResult?.params ?? DEFAULT_STRATEGY_PARAMS
      const result = await runOptimizer({
        symbol,
        timeframe: timeframe as Timeframe,
        baseParams,
        capitalStart: capital,
        monthsBack: months,
        generations: 30,
        populationSize: 15,
      })
      setOptResult(result)
      // Auto-show the best result
      setSimResult(result.best)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Optimization failed')
    } finally {
      setOptimizing(false)
    }
  }

  const handleDeploy = async () => {
    if (!simResult) return
    setDeploying(true)
    setDeployResult(null)
    try {
      const result = await deployOptimizedStrategy({
        symbol: simResult.symbol,
        timeframe: simResult.timeframe as Timeframe,
        params: simResult.params,
        capitalStart: capital,
        riskTier: selectedRiskTier,
        metrics: {
          winRate: simResult.metrics.winRate,
          netPnlPct: simResult.metrics.netPnlPct,
          sharpeRatio: simResult.metrics.sharpeRatio,
          totalTrades: simResult.metrics.totalTrades,
        },
      })
      setDeployResult(result)
      setShowRiskSelector(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Deploy failed')
    } finally {
      setDeploying(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* Controls */}
      <div className="bg-white rounded-2xl shadow-card p-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-xl font-heading font-semibold text-neutral-800">Turbo Simulator</h2>
            <p className="text-xs text-neutral-500">Meses de paper trading en segundos. Replay de datos historicos a velocidad maxima.</p>
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Simbolo</label>
            <select value={symbol} onChange={e => setSymbol(e.target.value)} className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm">
              {SYMBOLS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Timeframe</label>
            <div className="flex gap-1">
              {TIMEFRAMES.map(tf => (
                <button
                  key={tf}
                  onClick={() => setTimeframe(tf)}
                  className={`flex-1 px-2 py-2 text-xs rounded-lg border transition-colors ${
                    timeframe === tf ? 'bg-primary-500 text-white border-primary-500' : 'bg-white border-neutral-200 text-neutral-600 hover:border-primary-300'
                  }`}
                >
                  {tf}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Capital ($)</label>
            <input type="number" value={capital} onChange={e => setCapital(Number(e.target.value))} className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm" />
          </div>
          <div>
            <label className="block text-xs text-neutral-500 mb-1">Meses atras</label>
            <input type="number" value={months} onChange={e => setMonths(Number(e.target.value))} min={1} max={24} className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm" />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            onClick={handleTurboSim}
            disabled={running || optimizing}
            className="px-6 py-2.5 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition text-sm font-medium disabled:opacity-50"
          >
            {running ? 'Simulando...' : 'Turbo Sim'}
          </button>
          <button
            onClick={handleMultiSim}
            disabled={running || optimizing}
            className="px-6 py-2.5 bg-purple-600 text-white rounded-xl hover:bg-purple-700 transition text-sm font-medium disabled:opacity-50"
          >
            {running ? 'Escaneando...' : 'Scan ALL Pairs x Timeframes'}
          </button>
          <button
            onClick={handleOptimize}
            disabled={running || optimizing}
            className="px-6 py-2.5 bg-amber-600 text-white rounded-xl hover:bg-amber-700 transition text-sm font-medium disabled:opacity-50"
          >
            {optimizing ? 'Optimizando (200 variaciones)...' : 'AI Optimizer (Genetico)'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Single Sim Result */}
      {simResult && (
        <div className="bg-white rounded-2xl shadow-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-neutral-800">
              Resultado: {simResult.symbol} {simResult.timeframe}
            </h3>
            <span className="text-xs text-neutral-400">Calculado en {simResult.duration}ms</span>
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
            <MetricCard label="Trades" value={String(simResult.metrics.totalTrades)} />
            <MetricCard
              label="Win Rate"
              value={`${(simResult.metrics.winRate * 100).toFixed(1)}%`}
              color={simResult.metrics.winRate > 0.5 ? 'green' : 'red'}
            />
            <MetricCard
              label="PnL Neto"
              value={`${simResult.metrics.netPnl >= 0 ? '+' : ''}$${simResult.metrics.netPnl.toFixed(2)}`}
              color={simResult.metrics.netPnl >= 0 ? 'green' : 'red'}
            />
            <MetricCard
              label="PnL %"
              value={`${(simResult.metrics.netPnlPct * 100).toFixed(1)}%`}
              color={simResult.metrics.netPnlPct >= 0 ? 'green' : 'red'}
            />
            <MetricCard label="Profit Factor" value={simResult.metrics.profitFactor === Infinity ? '∞' : simResult.metrics.profitFactor.toFixed(2)} />
            <MetricCard label="Max Drawdown" value={`${(simResult.metrics.maxDrawdown * 100).toFixed(1)}%`} color="red" />
            <MetricCard label="Sharpe" value={simResult.metrics.sharpeRatio.toFixed(2)} />
            <MetricCard label="Trades/Mes" value={simResult.metrics.tradesPerMonth.toFixed(1)} />
          </div>

          {/* Verdict + Deploy */}
          <div className={`p-4 rounded-xl font-semibold text-lg flex items-center justify-between ${
            simResult.metrics.winRate > 0.55 && simResult.metrics.netPnlPct > 0.05 && simResult.metrics.maxDrawdown < 0.15
              ? 'bg-green-50 text-green-700 border border-green-200'
              : simResult.metrics.winRate > 0.45 && simResult.metrics.netPnlPct > 0
                ? 'bg-amber-50 text-amber-700 border border-amber-200'
                : 'bg-red-50 text-red-700 border border-red-200'
          }`}>
            <span>
              {simResult.metrics.winRate > 0.55 && simResult.metrics.netPnlPct > 0.05 && simResult.metrics.maxDrawdown < 0.15
                ? 'VIABLE — Candidata para paper trading real'
                : simResult.metrics.winRate > 0.45 && simResult.metrics.netPnlPct > 0
                  ? 'PROMETEDORA — Necesita optimizacion'
                  : 'NO VIABLE — Probar otros parametros'}
            </span>
            {simResult.metrics.netPnlPct > 0 && !showRiskSelector && !deployResult && (
              <button
                onClick={() => setShowRiskSelector(true)}
                disabled={deploying}
                className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition disabled:opacity-50"
              >
                Desplegar a Paper Trading
              </button>
            )}
          </div>

          {/* Risk Tier Selector */}
          {showRiskSelector && !deployResult && (
            <div className="bg-neutral-50 border border-neutral-200 rounded-xl p-4 space-y-3">
              <p className="text-sm font-medium text-neutral-700">Selecciona nivel de riesgo:</p>
              <div className="grid grid-cols-3 gap-3">
                {RISK_TIER_KEYS.map(tier => {
                  const cfg = RISK_TIERS[tier]
                  const colorMap = { blue: 'border-blue-400 bg-blue-50', amber: 'border-amber-400 bg-amber-50', red: 'border-red-400 bg-red-50' }
                  const selectedMap = { blue: 'ring-2 ring-blue-500', amber: 'ring-2 ring-amber-500', red: 'ring-2 ring-red-500' }
                  const isSelected = selectedRiskTier === tier
                  return (
                    <button
                      key={tier}
                      onClick={() => setSelectedRiskTier(tier)}
                      className={`p-3 rounded-xl border-2 text-left transition ${colorMap[cfg.color as keyof typeof colorMap]} ${isSelected ? selectedMap[cfg.color as keyof typeof selectedMap] : 'opacity-60 hover:opacity-80'}`}
                    >
                      <p className="text-sm font-semibold">{cfg.label}</p>
                      <p className="text-xs text-neutral-600 mt-0.5">{cfg.description}</p>
                      <p className="text-xs font-mono mt-1">{(cfg.riskPerTrade * 100).toFixed(0)}% por trade | {(cfg.allocation * 100).toFixed(0)}% cartera</p>
                    </button>
                  )
                })}
              </div>

              {/* Projected returns per tier */}
              {simResult && (
                <div className="bg-white rounded-lg p-3 border border-neutral-100">
                  <p className="text-xs text-neutral-500 mb-2">Proyeccion con ${capital} capital:</p>
                  <div className="grid grid-cols-3 gap-2 text-xs">
                    {RISK_TIER_KEYS.map(tier => {
                      const riskPct = RISK_TIERS[tier].riskPerTrade
                      const baseRisk = 0.02
                      const scaleFactor = riskPct / baseRisk
                      const projPnl = simResult.metrics.netPnl * scaleFactor
                      const projPct = simResult.metrics.netPnlPct * scaleFactor
                      const projDD = Math.min(simResult.metrics.maxDrawdown * scaleFactor, 1)
                      return (
                        <div key={tier} className={`text-center p-2 rounded-lg ${selectedRiskTier === tier ? 'bg-neutral-100 font-semibold' : ''}`}>
                          <p className="text-neutral-500">{RISK_TIERS[tier].label}</p>
                          <p className={projPnl >= 0 ? 'text-green-600' : 'text-red-600'}>
                            {projPnl >= 0 ? '+' : ''}${projPnl.toFixed(2)}
                          </p>
                          <p className={projPct >= 0 ? 'text-green-600' : 'text-red-600'}>
                            ({(projPct * 100).toFixed(1)}%)
                          </p>
                          <p className="text-red-500 text-[10px]">DD: {(projDD * 100).toFixed(1)}%</p>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              <div className="flex gap-2">
                <button
                  onClick={handleDeploy}
                  disabled={deploying}
                  className="px-4 py-2 bg-green-600 text-white text-sm rounded-lg hover:bg-green-700 transition disabled:opacity-50"
                >
                  {deploying ? 'Desplegando...' : `Desplegar (${RISK_TIERS[selectedRiskTier].label})`}
                </button>
                <button
                  onClick={() => setShowRiskSelector(false)}
                  className="px-4 py-2 bg-neutral-200 text-neutral-700 text-sm rounded-lg hover:bg-neutral-300 transition"
                >
                  Cancelar
                </button>
              </div>
            </div>
          )}

          {/* Deploy success */}
          {deployResult && (
            <div className="bg-green-100 border border-green-300 text-green-800 px-4 py-3 rounded-xl text-sm">
              Estrategia desplegada ({RISK_TIERS[selectedRiskTier].label}). Sesion de paper trading activa — activa Auto-Tick abajo para monitoreo automatico.
            </div>
          )}

          {/* Regime */}
          <div className="text-xs text-neutral-500">
            Regimen detectado: <span className="font-medium text-neutral-700">{simResult.regime.regime.toUpperCase()}</span>
            {' | '}ADX: {simResult.regime.adx.toFixed(1)} | Confianza: {(simResult.regime.confidence * 100).toFixed(0)}%
          </div>

          {/* Params used */}
          <div className="bg-neutral-50 rounded-xl p-3">
            <p className="text-[10px] uppercase tracking-wider text-neutral-400 mb-1">Parametros</p>
            <p className="text-xs text-neutral-600 font-mono">
              EMA {simResult.params.ema_fast}/{simResult.params.ema_slow} | RSI {simResult.params.rsi_period} ({simResult.params.rsi_oversold}/{simResult.params.rsi_overbought}) | MACD {simResult.params.macd_fast}/{simResult.params.macd_slow}/{simResult.params.macd_signal} | BB {simResult.params.bb_period}/{simResult.params.bb_std_dev} | SL/TP ATR×{simResult.params.stop_loss_pct}/{simResult.params.take_profit_pct}
            </p>
          </div>

          {/* Trade List */}
          {simResult.trades.length > 0 && (
            <div className="max-h-64 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-neutral-500 border-b">
                    <th className="text-left py-1">#</th>
                    <th className="text-left py-1">Tipo</th>
                    <th className="text-right py-1">Entrada</th>
                    <th className="text-right py-1">Salida</th>
                    <th className="text-right py-1">PnL</th>
                    <th className="text-right py-1">%</th>
                    <th className="text-left py-1">Razon</th>
                  </tr>
                </thead>
                <tbody>
                  {simResult.trades.map((t, i) => (
                    <tr key={i} className="border-b border-neutral-50">
                      <td className="py-1 text-neutral-400">{i + 1}</td>
                      <td className="py-1">
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${t.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                          {t.type.toUpperCase()}
                        </span>
                      </td>
                      <td className="text-right py-1">${t.entryPrice.toFixed(2)}</td>
                      <td className="text-right py-1">${t.exitPrice.toFixed(2)}</td>
                      <td className={`text-right py-1 font-medium ${t.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(2)}
                      </td>
                      <td className={`text-right py-1 ${t.pnlPct >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {(t.pnlPct * 100).toFixed(1)}%
                      </td>
                      <td className="py-1 text-neutral-400">{t.exitReason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Multi-Sim Results */}
      {multiResults.length > 0 && (
        <div className="bg-white rounded-2xl shadow-card p-6 space-y-4">
          <h3 className="font-semibold text-neutral-800">Scan Completo: {multiResults.length} combinaciones</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-neutral-500 border-b">
                  <th className="text-left py-2">Par</th>
                  <th className="text-left py-2">TF</th>
                  <th className="text-right py-2">Trades</th>
                  <th className="text-right py-2">Win %</th>
                  <th className="text-right py-2">PnL %</th>
                  <th className="text-right py-2">PF</th>
                  <th className="text-right py-2">Sharpe</th>
                  <th className="text-right py-2">Max DD</th>
                  <th className="text-right py-2">T/Mes</th>
                  <th className="text-left py-2">Regimen</th>
                  <th className="text-left py-2">Veredicto</th>
                </tr>
              </thead>
              <tbody>
                {multiResults.map((r, i) => {
                  const viable = r.metrics.winRate > 0.55 && r.metrics.netPnlPct > 0.05 && r.metrics.maxDrawdown < 0.15
                  const promising = r.metrics.winRate > 0.45 && r.metrics.netPnlPct > 0
                  return (
                    <tr key={i} className={`border-b border-neutral-50 ${viable ? 'bg-green-50' : promising ? 'bg-amber-50/50' : ''}`}>
                      <td className="py-2 font-medium">{r.symbol}</td>
                      <td className="py-2">{r.timeframe}</td>
                      <td className="text-right py-2">{r.metrics.totalTrades}</td>
                      <td className={`text-right py-2 font-medium ${r.metrics.winRate > 0.5 ? 'text-green-600' : 'text-red-600'}`}>
                        {(r.metrics.winRate * 100).toFixed(1)}%
                      </td>
                      <td className={`text-right py-2 font-medium ${r.metrics.netPnlPct > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {(r.metrics.netPnlPct * 100).toFixed(1)}%
                      </td>
                      <td className="text-right py-2">{r.metrics.profitFactor === Infinity ? '∞' : r.metrics.profitFactor.toFixed(2)}</td>
                      <td className="text-right py-2">{r.metrics.sharpeRatio.toFixed(2)}</td>
                      <td className="text-right py-2 text-red-600">{(r.metrics.maxDrawdown * 100).toFixed(1)}%</td>
                      <td className="text-right py-2">{r.metrics.tradesPerMonth.toFixed(1)}</td>
                      <td className="py-2 text-xs">{r.regime.regime}</td>
                      <td className="py-2">
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-medium ${
                          viable ? 'bg-green-100 text-green-700' : promising ? 'bg-amber-100 text-amber-700' : 'bg-red-100 text-red-700'
                        }`}>
                          {viable ? 'VIABLE' : promising ? 'PROMETEDORA' : 'NO VIABLE'}
                        </span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Optimization Results */}
      {optResult && (
        <div className="bg-white rounded-2xl shadow-card p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="font-semibold text-neutral-800">Optimizador Genetico</h3>
            <span className="text-xs text-neutral-400">{optResult.explored} variaciones exploradas</span>
          </div>

          {optResult.improvements.length > 0 ? (
            <div className="space-y-2">
              <p className="text-sm text-green-600 font-medium">
                {optResult.improvements.length} mejoras encontradas
              </p>
              <div className="bg-green-50 rounded-xl p-4">
                <p className="text-xs text-green-700 font-medium mb-2">Mejor resultado encontrado:</p>
                <div className="grid grid-cols-4 gap-3 text-sm">
                  <div>Win Rate: <span className="font-bold">{(optResult.best.metrics.winRate * 100).toFixed(1)}%</span></div>
                  <div>PnL: <span className="font-bold">{(optResult.best.metrics.netPnlPct * 100).toFixed(1)}%</span></div>
                  <div>Sharpe: <span className="font-bold">{optResult.best.metrics.sharpeRatio.toFixed(2)}</span></div>
                  <div>Trades: <span className="font-bold">{optResult.best.metrics.totalTrades}</span></div>
                </div>
              </div>
              <p className="text-xs text-neutral-500">
                Parametros optimizados: EMA {optResult.best.params.ema_fast}/{optResult.best.params.ema_slow} | RSI {optResult.best.params.rsi_period} | SL/TP ATR×{optResult.best.params.stop_loss_pct}/{optResult.best.params.take_profit_pct}
              </p>
            </div>
          ) : (
            <p className="text-sm text-amber-600">No se encontraron mejoras sobre los parametros base.</p>
          )}

          {/* Top 10 Results */}
          <div>
            <p className="text-xs text-neutral-500 mb-2">Top 10 combinaciones:</p>
            <div className="overflow-x-auto max-h-48 overflow-y-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-white">
                  <tr className="text-neutral-500 border-b">
                    <th className="text-left py-1">#</th>
                    <th className="text-right py-1">Win%</th>
                    <th className="text-right py-1">PnL%</th>
                    <th className="text-right py-1">PF</th>
                    <th className="text-right py-1">Sharpe</th>
                    <th className="text-right py-1">Trades</th>
                    <th className="text-left py-1">EMA</th>
                    <th className="text-left py-1">SL/TP</th>
                  </tr>
                </thead>
                <tbody>
                  {optResult.allResults.map((r, i) => (
                    <tr key={i} className={`border-b border-neutral-50 ${i === 0 ? 'bg-green-50' : ''}`}>
                      <td className="py-1">{i + 1}</td>
                      <td className={`text-right py-1 ${r.metrics.winRate > 0.5 ? 'text-green-600' : 'text-red-600'}`}>
                        {(r.metrics.winRate * 100).toFixed(1)}%
                      </td>
                      <td className={`text-right py-1 ${r.metrics.netPnlPct > 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {(r.metrics.netPnlPct * 100).toFixed(1)}%
                      </td>
                      <td className="text-right py-1">{r.metrics.profitFactor === Infinity ? '∞' : r.metrics.profitFactor.toFixed(2)}</td>
                      <td className="text-right py-1">{r.metrics.sharpeRatio.toFixed(2)}</td>
                      <td className="text-right py-1">{r.metrics.totalTrades}</td>
                      <td className="py-1 font-mono">{r.params.ema_fast}/{r.params.ema_slow}</td>
                      <td className="py-1 font-mono">{r.params.stop_loss_pct}/{r.params.take_profit_pct}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

function MetricCard({ label, value, color }: { label: string; value: string; color?: 'green' | 'red' }) {
  return (
    <div className="bg-neutral-50 rounded-xl p-3">
      <p className="text-[10px] text-neutral-400 uppercase">{label}</p>
      <p className={`text-sm font-bold ${color === 'green' ? 'text-green-600' : color === 'red' ? 'text-red-600' : 'text-neutral-800'}`}>
        {value}
      </p>
    </div>
  )
}
