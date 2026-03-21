'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  startSession,
  stopSession,
  tickSession,
  monitorPaperSession,
  getPaperSessions,
  getPaperDashboard,
  getStrategiesForPaper,
} from '@/actions/paper-trading'
import type { PaperSession, PaperDashboardData, LivePrice } from '../types'
import type { MonitorReport, DivergenceAlert } from '../services/aiMonitor'
import { StrategyHealthIndicator, getStrategyDescription, METRIC_TOOLTIPS } from './StrategyHealthIndicator'

export function PaperTradingDashboard() {
  const [sessions, setSessions] = useState<PaperSession[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<PaperDashboardData | null>(null)
  const [monitor, setMonitor] = useState<MonitorReport | null>(null)
  const [strategies, setStrategies] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [tickLoading, setTickLoading] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // New session form
  const [newStrategyId, setNewStrategyId] = useState('')
  const [newSymbol, setNewSymbol] = useState('BTCUSDT')
  const [newTimeframe, setNewTimeframe] = useState('1h')
  const [newCapital, setNewCapital] = useState(10000)

  const loadSessions = useCallback(async () => {
    try {
      const [sess, strats] = await Promise.all([getPaperSessions(), getStrategiesForPaper()])
      setSessions(sess)
      setStrategies(strats)
      if (strats.length > 0 && !newStrategyId) setNewStrategyId(strats[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading sessions')
    } finally {
      setLoading(false)
    }
  }, [newStrategyId])

  const loadDashboard = useCallback(async (sessionId: string) => {
    try {
      const data = await getPaperDashboard(sessionId)
      setDashboard(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading dashboard')
    }
  }, [])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (activeSession) loadDashboard(activeSession)
  }, [activeSession, loadDashboard])

  // Auto-refresh price + session cards every 15 seconds
  useEffect(() => {
    if (!activeSession || !dashboard?.session || dashboard.session.status !== 'active') return
    const interval = setInterval(() => {
      loadDashboard(activeSession)
      loadSessions()
    }, 15000)
    return () => clearInterval(interval)
  }, [activeSession, dashboard?.session?.status, loadDashboard, loadSessions])

  const handleStartSession = async () => {
    if (!newStrategyId) return
    setError(null)
    try {
      const session = await startSession({
        strategyId: newStrategyId,
        symbol: newSymbol,
        timeframe: newTimeframe,
        initialCapital: newCapital,
      })
      setShowNewSession(false)
      await loadSessions()
      setActiveSession(session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error starting session')
    }
  }

  const handleStopSession = async (id: string) => {
    if (!confirm('¿Detener esta sesión? Se cerrarán todas las posiciones abiertas.')) return
    try {
      await stopSession(id)
      await loadSessions()
      if (activeSession === id) {
        await loadDashboard(id)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error stopping session')
    }
  }

  const handleTick = async () => {
    if (!activeSession) return
    setTickLoading(true)
    setError(null)
    try {
      const result = await tickSession(activeSession)
      await loadDashboard(activeSession)
      await loadSessions()
      // Show result briefly
      if (result.action !== 'hold') {
        setError(null)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error executing tick')
    } finally {
      setTickLoading(false)
    }
  }

  const handleMonitor = async () => {
    if (!activeSession) return
    try {
      const report = await monitorPaperSession(activeSession)
      setMonitor(report)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error running monitor')
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => (
          <div key={i} className="h-32 bg-white rounded-2xl animate-pulse" />
        ))}
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {/* Header + New Session */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-heading font-semibold text-neutral-800">Paper Trading</h2>
        <button
          onClick={() => setShowNewSession(!showNewSession)}
          className="px-4 py-2 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition text-sm font-medium"
        >
          {showNewSession ? 'Cancelar' : '+ Nueva Sesión'}
        </button>
      </div>

      {/* New Session Form */}
      {showNewSession && (
        <div className="bg-white rounded-2xl shadow-card p-6 space-y-4">
          <h3 className="font-semibold text-neutral-800">Iniciar Sesión de Paper Trading</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Estrategia</label>
              <select
                value={newStrategyId}
                onChange={e => setNewStrategyId(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
              >
                {strategies.map(s => (
                  <option key={s.id} value={s.id}>{s.name}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Símbolo</label>
              <input
                value={newSymbol}
                onChange={e => setNewSymbol(e.target.value.toUpperCase())}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
                placeholder="BTCUSDT"
              />
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Timeframe</label>
              <select
                value={newTimeframe}
                onChange={e => setNewTimeframe(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
              >
                {['1m', '5m', '15m', '30m', '1h', '4h', '1d'].map(tf => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Capital Inicial</label>
              <input
                type="number"
                value={newCapital}
                onChange={e => setNewCapital(Number(e.target.value))}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
              />
            </div>
          </div>
          <button
            onClick={handleStartSession}
            disabled={!newStrategyId || strategies.length === 0}
            className="px-6 py-2 bg-green-600 text-white rounded-xl hover:bg-green-700 transition text-sm font-medium disabled:opacity-50"
          >
            Iniciar Sesión
          </button>
          {strategies.length === 0 && (
            <p className="text-xs text-amber-600">Necesitas crear una estrategia primero.</p>
          )}
        </div>
      )}

      {/* Server Cron Status + Recent Activity */}
      <div className="bg-white rounded-2xl shadow-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-neutral-800">Auto-Tick</h3>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-green-600 font-medium">Cron activo — cada 1 min</span>
            </span>
          </div>
          <span className="text-xs text-neutral-400">Gestionado por servidor</span>
        </div>
        {/* Recent closed trades across all sessions — acts as activity log */}
        {sessions.length > 0 && dashboard?.closedTrades && dashboard.closedTrades.length > 0 && (
          <div className="border-t pt-3">
            <p className="text-xs text-neutral-500 mb-2">Últimas operaciones cerradas</p>
            <div className="space-y-1.5">
              {[...dashboard.closedTrades].reverse().slice(0, 5).map(trade => (
                <div key={trade.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${trade.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {trade.type.toUpperCase()}
                    </span>
                    <span className="text-neutral-500">{trade.exit_reason}</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-neutral-400">{new Date(trade.exit_time ?? '').toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}</span>
                    <span className={`font-medium ${Number(trade.pnl) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {Number(trade.pnl) >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(2)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Sessions List */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sessions.map(session => (
          <div
            key={session.id}
            onClick={() => setActiveSession(session.id)}
            className={`bg-white rounded-2xl shadow-card p-4 cursor-pointer transition border-2 ${
              activeSession === session.id ? 'border-primary-500' : 'border-transparent hover:border-primary-200'
            }`}
          >
            <div className="flex items-center justify-between mb-2">
              <span className="font-semibold text-neutral-800">{session.symbol}</span>
              <div className="flex items-center gap-1.5">
                {session.risk_tier && (
                  <span className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                    session.risk_tier === 'conservative' ? 'bg-blue-100 text-blue-700' :
                    session.risk_tier === 'aggressive' ? 'bg-red-100 text-red-700' :
                    'bg-amber-100 text-amber-700'
                  }`}>
                    {session.risk_tier === 'conservative' ? 'CONS' : session.risk_tier === 'aggressive' ? 'AGR' : 'MOD'}
                  </span>
                )}
                <StatusBadge status={session.status} />
              </div>
            </div>
            {/* Health indicator + strategy description */}
            <div className="mb-2">
              <StrategyHealthIndicator
                grade={null}
                winRate={session.total_trades > 0 ? session.winning_trades / session.total_trades : 0}
                totalTrades={session.total_trades}
                netPnl={Number(session.net_pnl)}
              />
            </div>
            <div className="text-xs text-neutral-500 space-y-1">
              <div>Timeframe: {session.timeframe}</div>
              <div>Capital: ${Number(session.current_capital).toLocaleString()}</div>
              <div className={`font-medium ${Number(session.net_pnl) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                PnL: {Number(session.net_pnl) >= 0 ? '+' : ''}${Number(session.net_pnl).toFixed(2)}
              </div>
              <div>Trades: {session.total_trades} ({session.winning_trades} ganados)</div>
            </div>
            {session.status === 'active' && (
              <button
                onClick={e => { e.stopPropagation(); handleStopSession(session.id) }}
                className="mt-3 w-full px-3 py-1.5 bg-red-100 text-red-700 rounded-lg text-xs font-medium hover:bg-red-200 transition"
              >
                Detener Sesión
              </button>
            )}
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="col-span-full text-center py-12 text-neutral-400">
            No hay sesiones de paper trading. Crea una para empezar.
          </div>
        )}
      </div>

      {/* Active Session Dashboard */}
      {activeSession && dashboard && (
        <div className="space-y-4">
          {/* Controls */}
          {dashboard.session.status === 'active' && (
            <div className="bg-white rounded-2xl shadow-card p-4 flex items-center gap-3">
              <button
                onClick={handleTick}
                disabled={tickLoading}
                className="px-4 py-2 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition text-sm font-medium disabled:opacity-50"
              >
                {tickLoading ? 'Procesando...' : 'Ejecutar Tick'}
              </button>
              <button
                onClick={handleMonitor}
                className="px-4 py-2 bg-amber-500 text-white rounded-xl hover:bg-amber-600 transition text-sm font-medium"
              >
                AI Monitor
              </button>
              {dashboard.currentPrice && (
                <div className="ml-auto text-right">
                  <div className="text-xs text-neutral-500">Precio Actual</div>
                  <div className="font-semibold text-neutral-800">${dashboard.currentPrice.price.toLocaleString()}</div>
                  <div className={`text-xs ${dashboard.currentPrice.change24h >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    {dashboard.currentPrice.change24h >= 0 ? '+' : ''}{dashboard.currentPrice.change24h.toFixed(2)}%
                  </div>
                </div>
              )}
            </div>
          )}

          {/* KPI Cards */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <KPICard
              label="Capital Actual"
              value={`$${Number(dashboard.session.current_capital).toLocaleString()}`}
              subtext={`Inicial: $${Number(dashboard.session.initial_capital).toLocaleString()}`}
            />
            <KPICard
              label="PnL Neto"
              value={`${Number(dashboard.session.net_pnl) >= 0 ? '+' : ''}$${Number(dashboard.session.net_pnl).toFixed(2)}`}
              color={Number(dashboard.session.net_pnl) >= 0 ? 'green' : 'red'}
            />
            <KPICard
              label="Win Rate"
              value={dashboard.session.total_trades > 0
                ? `${((dashboard.session.winning_trades / dashboard.session.total_trades) * 100).toFixed(1)}%`
                : '—'}
              subtext={`${dashboard.session.winning_trades}/${dashboard.session.total_trades} trades`}
              tooltip={METRIC_TOOLTIPS.winRate}
            />
            <KPICard
              label="Salud"
              value={(() => {
                const wr = dashboard.session.total_trades > 0 ? dashboard.session.winning_trades / dashboard.session.total_trades : 0
                const pnl = Number(dashboard.session.net_pnl)
                const tt = dashboard.session.total_trades
                if (tt < 5) return '—'
                if (wr > 0.55 && pnl > 0 && tt >= 30) return 'A'
                if (wr > 0.50 && pnl > 0 && tt >= 20) return 'B'
                if (wr > 0.45 && pnl > 0 && tt >= 10) return 'C'
                if (pnl > 0) return 'D'
                return 'F'
              })()}
              color={Number(dashboard.session.net_pnl) > 0 ? 'green' : Number(dashboard.session.net_pnl) < 0 ? 'red' : undefined}
              tooltip={METRIC_TOOLTIPS.grade}
            />
          </div>

          {/* Open Trades */}
          {dashboard.openTrades.length > 0 && (
            <div className="bg-white rounded-2xl shadow-card p-4">
              <h3 className="font-semibold text-neutral-800 mb-3">Posiciones Abiertas</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-neutral-500 border-b">
                      <th className="text-left py-2">Tipo</th>
                      <th className="text-right py-2">Entrada</th>
                      <th className="text-right py-2">Cantidad</th>
                      <th className="text-right py-2">SL</th>
                      <th className="text-right py-2">TP</th>
                      <th className="text-right py-2">PnL No Realizado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.openTrades.map(trade => {
                      const currentP = dashboard.currentPrice?.price ?? Number(trade.entry_price)
                      const unrealizedPnl = trade.type === 'buy'
                        ? (currentP - Number(trade.entry_price)) * Number(trade.quantity)
                        : (Number(trade.entry_price) - currentP) * Number(trade.quantity)
                      return (
                        <tr key={trade.id} className="border-b border-neutral-100">
                          <td className="py-2">
                            <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                              trade.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                            }`}>
                              {trade.type.toUpperCase()}
                            </span>
                          </td>
                          <td className="text-right py-2">${Number(trade.entry_price).toLocaleString()}</td>
                          <td className="text-right py-2">{Number(trade.quantity)}</td>
                          <td className="text-right py-2 text-red-600">${Number(trade.stop_loss).toLocaleString()}</td>
                          <td className="text-right py-2 text-green-600">${Number(trade.take_profit).toLocaleString()}</td>
                          <td className={`text-right py-2 font-medium ${unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Equity Curve */}
          {dashboard.pnlHistory.length > 1 && (
            <div className="bg-white rounded-2xl shadow-card p-4">
              <h3 className="font-semibold text-neutral-800 mb-3">Curva de Equity</h3>
              <EquityCurve data={dashboard.pnlHistory} initialCapital={Number(dashboard.session.initial_capital)} />
            </div>
          )}

          {/* Closed Trades */}
          {dashboard.closedTrades.length > 0 && (
            <div className="bg-white rounded-2xl shadow-card p-4">
              <h3 className="font-semibold text-neutral-800 mb-3">Historial de Trades ({dashboard.closedTrades.length})</h3>
              <div className="overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="text-xs text-neutral-500 border-b">
                      <th className="text-left py-2">Tipo</th>
                      <th className="text-right py-2">Entrada</th>
                      <th className="text-right py-2">Salida</th>
                      <th className="text-right py-2">PnL</th>
                      <th className="text-right py-2">%</th>
                      <th className="text-left py-2">Razón</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...dashboard.closedTrades].reverse().map(trade => (
                      <tr key={trade.id} className="border-b border-neutral-100">
                        <td className="py-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            trade.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {trade.type.toUpperCase()}
                          </span>
                        </td>
                        <td className="text-right py-2">${Number(trade.entry_price).toLocaleString()}</td>
                        <td className="text-right py-2">${Number(trade.exit_price).toLocaleString()}</td>
                        <td className={`text-right py-2 font-medium ${Number(trade.pnl) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {Number(trade.pnl) >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(2)}
                        </td>
                        <td className={`text-right py-2 ${Number(trade.pnl_pct) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {(Number(trade.pnl_pct) * 100).toFixed(1)}%
                        </td>
                        <td className="py-2 text-xs text-neutral-500">{trade.exit_reason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* AI Monitor Report */}
          {monitor && (
            <div className="bg-white rounded-2xl shadow-card p-4 space-y-4">
              <h3 className="font-semibold text-neutral-800">AI Monitor Report</h3>

              {/* Alerts */}
              {monitor.alerts.length > 0 ? (
                <div className="space-y-2">
                  {monitor.alerts.map((alert, i) => (
                    <AlertCard key={i} alert={alert} />
                  ))}
                </div>
              ) : (
                <div className="text-sm text-green-600 bg-green-50 px-4 py-3 rounded-xl">
                  Sin alertas. La sesión opera dentro de parámetros normales.
                </div>
              )}

              {/* Metrics Comparison */}
              {monitor.backtestMetrics && (
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <p className="text-xs text-neutral-500 mb-1">Paper Trading</p>
                    <div>Win Rate: {(monitor.paperMetrics.winRate * 100).toFixed(1)}%</div>
                    <div>Avg PnL: ${monitor.paperMetrics.avgPnl.toFixed(2)}</div>
                    <div>Max DD: {(monitor.paperMetrics.maxDrawdown * 100).toFixed(1)}%</div>
                  </div>
                  <div>
                    <p className="text-xs text-neutral-500 mb-1">Backtest (referencia)</p>
                    <div>Win Rate: {(monitor.backtestMetrics.winRate * 100).toFixed(1)}%</div>
                    <div>Avg PnL: ${monitor.backtestMetrics.avgPnl.toFixed(2)}</div>
                    <div>Max DD: {(monitor.backtestMetrics.maxDrawdown * 100).toFixed(1)}%</div>
                  </div>
                </div>
              )}

              {/* AI Analysis */}
              {monitor.aiAnalysis && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <p className="text-xs text-blue-600 font-medium mb-1">Análisis AI</p>
                  <p className="text-sm text-blue-800">{monitor.aiAnalysis}</p>
                </div>
              )}

              {/* Human Gate Warning */}
              {monitor.alerts.some(a => a.shouldPause) && (
                <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4">
                  <p className="font-semibold text-red-700 mb-1">ACCIÓN REQUERIDA</p>
                  <p className="text-sm text-red-600 mb-3">
                    El AI Monitor recomienda pausar esta sesión. La decisión final es tuya.
                  </p>
                  <button
                    onClick={() => handleStopSession(activeSession!)}
                    className="px-4 py-2 bg-red-600 text-white rounded-xl hover:bg-red-700 transition text-sm font-medium"
                  >
                    Detener Sesión
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const colors = {
    active: 'bg-green-100 text-green-700',
    paused: 'bg-amber-100 text-amber-700',
    stopped: 'bg-neutral-100 text-neutral-500',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status as keyof typeof colors] ?? colors.stopped}`}>
      {status}
    </span>
  )
}

function KPICard({ label, value, subtext, color, tooltip }: { label: string; value: string; subtext?: string; color?: 'green' | 'red'; tooltip?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-card p-4" title={tooltip}>
      <p className="text-xs text-neutral-500 flex items-center gap-1">
        {label}
        {tooltip && <span className="text-neutral-300 cursor-help" title={tooltip}>?</span>}
      </p>
      <p className={`text-xl font-bold ${color === 'green' ? 'text-green-600' : color === 'red' ? 'text-red-600' : 'text-neutral-800'}`}>
        {value}
      </p>
      {subtext && <p className="text-xs text-neutral-400">{subtext}</p>}
    </div>
  )
}

function AlertCard({ alert }: { alert: DivergenceAlert }) {
  const colors = {
    info: 'bg-blue-50 border-blue-200 text-blue-700',
    warning: 'bg-amber-50 border-amber-200 text-amber-700',
    critical: 'bg-red-50 border-red-200 text-red-700',
  }
  return (
    <div className={`border rounded-xl px-4 py-3 ${colors[alert.severity]}`}>
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-semibold uppercase">{alert.severity}</span>
        <span className="text-xs opacity-70">({alert.type})</span>
      </div>
      <p className="text-sm font-medium">{alert.message}</p>
      <p className="text-xs mt-1 opacity-80">{alert.recommendation}</p>
    </div>
  )
}

function EquityCurve({ data, initialCapital }: { data: { timestamp: string; pnl: number }[]; initialCapital: number }) {
  const width = 600
  const height = 200
  const padding = 30

  const values = data.map(d => initialCapital + d.pnl)
  const min = Math.min(initialCapital, ...values)
  const max = Math.max(initialCapital, ...values)
  const range = max - min || 1

  const points = data.map((d, i) => {
    const x = padding + (i / (data.length - 1)) * (width - padding * 2)
    const y = height - padding - ((initialCapital + d.pnl - min) / range) * (height - padding * 2)
    return `${x},${y}`
  }).join(' ')

  const baseY = height - padding - ((initialCapital - min) / range) * (height - padding * 2)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48">
      {/* Baseline */}
      <line x1={padding} y1={baseY} x2={width - padding} y2={baseY} stroke="#94a3b8" strokeWidth="1" strokeDasharray="4,4" />
      {/* Equity line */}
      <polyline fill="none" stroke="#6366f1" strokeWidth="2" points={points} />
      {/* Labels */}
      <text x={padding} y={height - 5} fontSize="10" fill="#94a3b8">{data[0].timestamp.split('T')[0]}</text>
      <text x={width - padding} y={height - 5} fontSize="10" fill="#94a3b8" textAnchor="end">{data[data.length - 1].timestamp.split('T')[0]}</text>
      <text x={5} y={baseY + 3} fontSize="10" fill="#94a3b8">${initialCapital.toLocaleString()}</text>
    </svg>
  )
}
