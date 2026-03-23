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
  getRecentTrades,
  getPaperProposals,
  respondToProposal,
  getSignalAttribution,
  getAgentLog,
} from '@/actions/paper-trading'
import type { PaperSession, PaperDashboardData } from '../types'
import type { MonitorReport, DivergenceAlert } from '../services/aiMonitor'
import { StrategyHealthIndicator, METRIC_TOOLTIPS } from './StrategyHealthIndicator'
import {
  formatExitReason,
  formatAgentEventType,
  formatDuration,
  gradeColor,
  drawdownColor,
} from '../utils/formatters'

export function PaperTradingDashboard() {
  const [sessions, setSessions] = useState<PaperSession[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<PaperDashboardData | null>(null)
  const [monitor, setMonitor] = useState<MonitorReport | null>(null)
  const [strategies, setStrategies] = useState<{ id: string; name: string }[]>([])
  const [recentTrades, setRecentTrades] = useState<import('../types').PaperTrade[]>([])
  const [agentLog, setAgentLog] = useState<Awaited<ReturnType<typeof getAgentLog>>>([])
  const [loading, setLoading] = useState(true)
  const [tickLoading, setTickLoading] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [sessionFilter, setSessionFilter] = useState<'active' | 'stopped' | 'all'>('active')
  const [error, setError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<Awaited<ReturnType<typeof getPaperProposals>>>([])
  const [attribution, setAttribution] = useState<Awaited<ReturnType<typeof getSignalAttribution>>>([])
  const [respondingProposal, setRespondingProposal] = useState<string | null>(null)
  const [attributionWindow, setAttributionWindow] = useState<15 | 30 | 50>(15)
  const [logSort, setLogSort] = useState<'recent' | 'best'>('recent')

  // New session form
  const [newStrategyId, setNewStrategyId] = useState('')
  const [newSymbol, setNewSymbol] = useState('BTCUSDT')
  const [newTimeframe, setNewTimeframe] = useState('1h')
  const [newCapital, setNewCapital] = useState(10000)

  const loadSessions = useCallback(async () => {
    try {
      const [sess, strats, recent, props, log] = await Promise.all([
        getPaperSessions(), getStrategiesForPaper(), getRecentTrades(8),
        getPaperProposals(), getAgentLog(20)
      ])
      setSessions(sess)
      setStrategies(strats)
      setRecentTrades(recent)
      setProposals(props)
      setAgentLog(log)
      if (strats.length > 0 && !newStrategyId) setNewStrategyId(strats[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading sessions')
    } finally {
      setLoading(false)
    }
  }, [newStrategyId])

  const loadDashboard = useCallback(async (sessionId: string, window = attributionWindow) => {
    try {
      const [data, attr] = await Promise.all([
        getPaperDashboard(sessionId),
        getSignalAttribution(sessionId, window),
      ])
      setDashboard(data)
      setAttribution(attr)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error loading dashboard')
    }
  }, [attributionWindow])

  useEffect(() => {
    loadSessions()
  }, [loadSessions])

  useEffect(() => {
    if (activeSession) loadDashboard(activeSession)
  }, [activeSession, loadDashboard])

  // Auto-refresh every 15 seconds when active session is running
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
      if (activeSession === id) await loadDashboard(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error stopping session')
    }
  }

  const handleTick = async () => {
    if (!activeSession) return
    setTickLoading(true)
    setError(null)
    try {
      await tickSession(activeSession)
      await Promise.all([loadDashboard(activeSession), loadSessions()])
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
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="ml-2 font-bold text-red-500 hover:text-red-700">×</button>
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

      {/* Agent Decision Feed (Auto-Tick panel) */}
      <div className="bg-white rounded-2xl shadow-card p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h3 className="font-semibold text-neutral-800">🤖 Agente — Decisiones</h3>
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="text-xs text-green-600 font-medium">Cron activo — cada 1 min</span>
            </span>
          </div>
          <span className="text-xs text-neutral-400">Gestionado por servidor</span>
        </div>

        {/* Agent log — last decisions */}
        {agentLog.length > 0 ? (
          <div className="border-t pt-3 space-y-1.5">
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs text-neutral-500">Últimas {agentLog.length} decisiones del agente</p>
              <div className="flex gap-1">
                <button
                  onClick={() => setLogSort('recent')}
                  className={`px-2 py-0.5 text-xs rounded ${logSort === 'recent' ? 'bg-primary-100 text-primary-700 font-medium' : 'text-neutral-400 hover:text-neutral-600'}`}
                >
                  Recientes
                </button>
                <button
                  onClick={() => setLogSort('best')}
                  className={`px-2 py-0.5 text-xs rounded ${logSort === 'best' ? 'bg-primary-100 text-primary-700 font-medium' : 'text-neutral-400 hover:text-neutral-600'}`}
                >
                  Mejores
                </button>
              </div>
            </div>
            <div className="max-h-72 overflow-y-auto space-y-1.5">
            {[...agentLog].sort((a, b) => {
              if (logSort === 'best') {
                const aPnl = a.pnl ?? -Infinity
                const bPnl = b.pnl ?? -Infinity
                return bPnl - aPnl
              }
              return 0 // already sorted by created_at DESC from server
            }).map(entry => {
              const { label, color } = formatAgentEventType(entry.event_type)
              const isAction = ['buy', 'sell', 'close'].includes(entry.event_type)
              return (
                <div key={entry.id} className={`flex items-start justify-between text-xs gap-2 py-1 ${isAction ? 'border-l-2 border-primary-300 pl-2 -ml-2' : ''}`}>
                  <div className="flex items-start gap-2 min-w-0">
                    <span className="text-neutral-300 shrink-0 font-mono tabular-nums">
                      {new Date(entry.created_at).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    <div className="min-w-0">
                      <span className="text-neutral-600 font-medium">{entry.symbol} {entry.timeframe}</span>
                      <span className={`ml-2 font-semibold ${color}`}>{label}</span>
                      {entry.reason && (
                        <span className="ml-1 text-neutral-400 truncate block max-w-xs">{entry.reason}</span>
                      )}
                    </div>
                  </div>
                  {entry.pnl !== null && (
                    <span className={`shrink-0 font-medium tabular-nums ${entry.pnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                      {entry.pnl >= 0 ? '+' : ''}${Number(entry.pnl).toFixed(2)}
                    </span>
                  )}
                </div>
              )
            })}
            </div>
          </div>
        ) : recentTrades.length > 0 ? (
          <div className="border-t pt-3">
            <p className="text-xs text-neutral-500 mb-2">Últimas operaciones cerradas</p>
            <div className="space-y-1.5">
              {recentTrades.map(trade => (
                <div key={trade.id} className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className={`px-1.5 py-0.5 rounded font-medium ${trade.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>
                      {trade.type.toUpperCase()}
                    </span>
                    <span className="text-neutral-600 font-medium">{trade.symbol}</span>
                    <span className="text-neutral-400">{formatExitReason(trade.exit_reason)}</span>
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
        ) : (
          <p className="text-xs text-neutral-400 border-t pt-3">No hay actividad reciente. El agente comenzará a operar en el próximo tick.</p>
        )}
      </div>

      {/* Agentic Proposals — scale-up suggestions from the evaluator */}
      {proposals.length > 0 && (
        <div className="space-y-3">
          {proposals.map(p => {
            const v = p.proposed_value as {
              symbol?: string; timeframe?: string
              proposed_capital?: number; current_capital?: number
              grade?: string; win_rate?: string; sharpe?: string
              max_dd?: string; days_sustained?: string; total_trades?: number
              expected_gain_per_trade?: string; risk_per_trade?: string
            }
            return (
              <div key={p.id} className="bg-amber-50 border border-amber-200 rounded-2xl p-5">
                {/* Header */}
                <div className="flex items-start justify-between gap-4 mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-amber-700 font-semibold text-sm">🤖 Recomendación del Sistema</span>
                      <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${gradeColor(v.grade ?? null)}`}>
                        Grado {v.grade}
                      </span>
                    </div>
                    {v.symbol && (
                      <p className="text-xs text-neutral-500">{v.symbol} {v.timeframe}</p>
                    )}
                  </div>
                  <div className="flex gap-2 shrink-0">
                    <button
                      disabled={respondingProposal === p.id}
                      onClick={async () => {
                        setRespondingProposal(p.id)
                        await respondToProposal(p.id, 'approved')
                        setProposals(prev => prev.filter(x => x.id !== p.id))
                        await loadSessions()
                        setRespondingProposal(null)
                      }}
                      className="px-4 py-2 bg-green-600 text-white rounded-xl text-xs font-semibold hover:bg-green-700 transition disabled:opacity-50"
                    >
                      {respondingProposal === p.id ? '…' : 'Aprobar'}
                    </button>
                    <button
                      disabled={respondingProposal === p.id}
                      onClick={async () => {
                        setRespondingProposal(p.id)
                        await respondToProposal(p.id, 'rejected')
                        setProposals(prev => prev.filter(x => x.id !== p.id))
                        setRespondingProposal(null)
                      }}
                      className="px-4 py-2 bg-neutral-200 text-neutral-600 rounded-xl text-xs font-semibold hover:bg-neutral-300 transition disabled:opacity-50"
                    >
                      Rechazar
                    </button>
                  </div>
                </div>

                {/* Capital change */}
                {v.proposed_capital && v.current_capital && (
                  <div className="flex items-center gap-3 mb-4 p-3 bg-white rounded-xl border border-amber-100">
                    <div className="text-center">
                      <p className="text-xs text-neutral-400">Capital actual</p>
                      <p className="text-lg font-bold text-neutral-700">${v.current_capital.toLocaleString()}</p>
                    </div>
                    <div className="text-2xl text-amber-400 flex-1 text-center">→</div>
                    <div className="text-center">
                      <p className="text-xs text-neutral-400">Capital propuesto</p>
                      <p className="text-lg font-bold text-green-700">${v.proposed_capital.toLocaleString()}</p>
                    </div>
                  </div>
                )}

                {/* Agent reasoning */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                  <div>
                    <p className="text-neutral-500 font-semibold mb-1.5">Por qué lo recomiendo</p>
                    <ul className="space-y-1 text-neutral-700">
                      {v.days_sustained && (
                        <li>• Grado {v.grade} sostenido {v.days_sustained} días consecutivos</li>
                      )}
                      {v.win_rate && (
                        <li>• Win Rate: <span className="font-semibold text-green-700">{v.win_rate}%</span>
                          {v.total_trades && ` (${v.total_trades} trades)`}
                        </li>
                      )}
                      {v.sharpe && (
                        <li>• Sharpe: <span className="font-semibold">{v.sharpe}</span> — retorno ajustado por riesgo</li>
                      )}
                      {v.max_dd && (
                        <li>• Max Drawdown: <span className={`font-semibold ${drawdownColor(Number(v.max_dd) / 100)}`}>{v.max_dd}%</span> — dentro del rango</li>
                      )}
                    </ul>
                  </div>
                  {(v.expected_gain_per_trade || v.risk_per_trade) && (
                    <div>
                      <p className="text-neutral-500 font-semibold mb-1.5">Qué espero si escalas</p>
                      <ul className="space-y-1 text-neutral-700">
                        {v.expected_gain_per_trade && (
                          <li>• Ganancia esperada por trade: <span className="font-semibold text-green-700">+${v.expected_gain_per_trade}</span></li>
                        )}
                        {v.risk_per_trade && (
                          <li>• Riesgo por trade: <span className="font-semibold text-amber-700">${v.risk_per_trade}</span></li>
                        )}
                      </ul>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      )}

      {/* Sessions Filter + List */}
      <div className="flex items-center gap-1 bg-neutral-100 rounded-xl p-1 w-fit">
        {(['active', 'stopped', 'all'] as const).map(f => {
          const counts = { active: sessions.filter(s => s.status === 'active').length, stopped: sessions.filter(s => s.status === 'stopped').length, all: sessions.length }
          const labels = { active: 'Activas', stopped: 'Detenidas', all: 'Todas' }
          return (
            <button
              key={f}
              onClick={() => setSessionFilter(f)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition ${sessionFilter === f ? 'bg-white shadow text-neutral-800' : 'text-neutral-500 hover:text-neutral-700'}`}
            >
              {labels[f]} <span className="ml-1 opacity-60">{counts[f]}</span>
            </button>
          )
        })}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {sessions.filter(s => sessionFilter === 'all' || s.status === sessionFilter).map(session => {
          const winRate = session.total_trades > 0 ? session.winning_trades / session.total_trades : 0
          const grade = (() => {
            const tt = session.total_trades
            const pnl = Number(session.net_pnl)
            if (tt < 5) return null
            if (winRate > 0.55 && pnl > 0 && tt >= 30) return 'A'
            if (winRate > 0.50 && pnl > 0 && tt >= 20) return 'B'
            if (winRate > 0.45 && pnl > 0 && tt >= 10) return 'C'
            if (pnl > 0) return 'D'
            return 'F'
          })()
          const maxDD = Number((session as PaperSession & { max_drawdown?: number }).max_drawdown ?? 0)

          return (
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
                  {/* Grade badge with color */}
                  {grade && (
                    <span className={`px-2 py-0.5 rounded-full text-xs font-bold ${gradeColor(grade)}`}>
                      {grade}
                    </span>
                  )}
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
              <div className="mb-2">
                <StrategyHealthIndicator
                  grade={grade}
                  winRate={winRate}
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
                {/* Max Drawdown badge — visible directly on card */}
                {maxDD > 0 && (
                  <div className={`font-medium ${drawdownColor(maxDD)}`}>
                    Max DD: {(maxDD * 100).toFixed(1)}%
                  </div>
                )}
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
          )
        })}
        {sessions.filter(s => sessionFilter === 'all' || s.status === sessionFilter).length === 0 && (
          <div className="col-span-full text-center py-12 text-neutral-400">
            {sessions.length === 0
              ? 'No hay sesiones de paper trading. Crea una para empezar.'
              : `No hay sesiones ${sessionFilter === 'active' ? 'activas' : 'detenidas'}.`}
          </div>
        )}
      </div>

      {/* Active Session Dashboard */}
      {activeSession && dashboard && (
        <div className="space-y-4">
          {/* Controls */}
          {dashboard.session.status === 'active' && (
            <div className="bg-white rounded-2xl shadow-card p-4 flex flex-wrap items-center gap-3">
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
                    {dashboard.currentPrice.change24h >= 0 ? '+' : ''}{dashboard.currentPrice.change24h.toFixed(2)}% (24h)
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
              label="Salud (Grade)"
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
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto">
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
                      const pnlPct = unrealizedPnl / (Number(trade.entry_price) * Number(trade.quantity))
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
                          <td className="text-right py-2">{Number(trade.quantity).toFixed(4)}</td>
                          <td className="text-right py-2 text-red-600">${Number(trade.stop_loss).toLocaleString()}</td>
                          <td className="text-right py-2 text-green-600">${Number(trade.take_profit).toLocaleString()}</td>
                          <td className={`text-right py-2 font-medium ${unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}
                            <span className="text-xs ml-1 opacity-70">({(pnlPct * 100).toFixed(1)}%)</span>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
              {/* Mobile cards */}
              <div className="sm:hidden space-y-3">
                {dashboard.openTrades.map(trade => {
                  const currentP = dashboard.currentPrice?.price ?? Number(trade.entry_price)
                  const unrealizedPnl = trade.type === 'buy'
                    ? (currentP - Number(trade.entry_price)) * Number(trade.quantity)
                    : (Number(trade.entry_price) - currentP) * Number(trade.quantity)
                  return (
                    <div key={trade.id} className="border border-neutral-100 rounded-xl p-3 text-xs space-y-1">
                      <div className="flex justify-between">
                        <span className={`px-2 py-0.5 rounded-full font-medium ${trade.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{trade.type.toUpperCase()}</span>
                        <span className={`font-bold ${unrealizedPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>{unrealizedPnl >= 0 ? '+' : ''}${unrealizedPnl.toFixed(2)}</span>
                      </div>
                      <div className="flex justify-between text-neutral-500">
                        <span>Entrada: ${Number(trade.entry_price).toLocaleString()}</span>
                        <span>Qty: {Number(trade.quantity).toFixed(4)}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-red-600">SL: ${Number(trade.stop_loss).toLocaleString()}</span>
                        <span className="text-green-600">TP: ${Number(trade.take_profit).toLocaleString()}</span>
                      </div>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Signal Attribution Panel — Improved */}
          {attribution.length > 0 && (
            <div className="bg-white rounded-2xl shadow-card p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-semibold text-neutral-800">Atribución de Señales</h3>
                <div className="flex items-center gap-1">
                  {([15, 30, 50] as const).map(w => (
                    <button
                      key={w}
                      onClick={async () => {
                        setAttributionWindow(w)
                        if (activeSession) await loadDashboard(activeSession, w)
                      }}
                      className={`px-2 py-1 text-xs rounded-lg transition ${attributionWindow === w ? 'bg-primary-100 text-primary-700 font-medium' : 'text-neutral-400 hover:text-neutral-600'}`}
                    >
                      {w}
                    </button>
                  ))}
                  <span className="text-xs text-neutral-400 ml-1">trades</span>
                </div>
              </div>
              <div className="space-y-2">
                {attribution.map((item, i) => {
                  const total = item.wins + item.losses
                  const isTop = i === 0
                  return (
                    <div key={item.system} className={`flex items-center gap-3 ${isTop ? 'bg-green-50 rounded-lg px-2 py-1 -mx-2' : ''}`}>
                      <span className="text-xs text-neutral-600 w-36 shrink-0 font-mono">{item.system}</span>
                      <div className="flex-1 bg-neutral-100 rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full ${item.winRate >= 0.65 ? 'bg-green-500' : item.winRate >= 0.5 ? 'bg-amber-400' : 'bg-red-400'}`}
                          style={{ width: `${Math.round(item.winRate * 100)}%` }}
                        />
                      </div>
                      <span className="text-xs text-neutral-500 w-24 text-right tabular-nums">
                        {Math.round(item.winRate * 100)}% <span className="text-neutral-300">({total})</span>
                      </span>
                      <span className={`text-xs font-bold w-8 text-right ${item.contribution === '+++' ? 'text-green-600' : item.contribution === '++' ? 'text-green-500' : item.contribution === '=' ? 'text-neutral-400' : 'text-red-500'}`}>
                        {item.contribution}
                      </span>
                    </div>
                  )
                })}
              </div>
              {/* Legend */}
              <div className="mt-3 pt-3 border-t flex flex-wrap gap-3 text-xs text-neutral-400">
                <span><span className="text-green-600 font-bold">+++</span> WR ≥65%</span>
                <span><span className="text-green-500 font-bold">++</span> WR ≥50%</span>
                <span><span className="text-neutral-400 font-bold">=</span> WR ≥40%</span>
                <span><span className="text-red-500 font-bold">−</span> WR &lt;40%</span>
                <span className="ml-auto">El número entre () es el total de trades con esa señal.</span>
              </div>
              {attribution.length === 0 && (
                <p className="text-xs text-neutral-400 mt-2">Solo trades con metadata de señal (generados desde hoy).</p>
              )}
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
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto max-h-72 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white z-10">
                    <tr className="text-xs text-neutral-500 border-b">
                      <th className="text-left py-2">Tipo</th>
                      <th className="text-right py-2">Entrada</th>
                      <th className="text-right py-2">Salida</th>
                      <th className="text-right py-2">Duración</th>
                      <th className="text-right py-2">PnL</th>
                      <th className="text-right py-2">%</th>
                      <th className="text-left py-2 pl-3">Razón</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...dashboard.closedTrades].reverse().map(trade => (
                      <tr key={trade.id} className={`border-b border-neutral-100 ${Number(trade.pnl) > 0 ? 'hover:bg-green-50' : 'hover:bg-red-50'} transition`}>
                        <td className="py-2">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            trade.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'
                          }`}>
                            {trade.type.toUpperCase()}
                          </span>
                        </td>
                        <td className="text-right py-2">${Number(trade.entry_price).toLocaleString()}</td>
                        <td className="text-right py-2">${Number(trade.exit_price).toLocaleString()}</td>
                        <td className="text-right py-2 text-neutral-400 text-xs">
                          {formatDuration(trade.entry_time, trade.exit_time)}
                        </td>
                        <td className={`text-right py-2 font-medium ${Number(trade.pnl) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {Number(trade.pnl) >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(2)}
                        </td>
                        <td className={`text-right py-2 ${Number(trade.pnl_pct) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                          {(Number(trade.pnl_pct) * 100).toFixed(1)}%
                        </td>
                        <td className="py-2 pl-3 text-xs text-neutral-500">{formatExitReason(trade.exit_reason)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Mobile cards */}
              <div className="sm:hidden space-y-2 max-h-96 overflow-y-auto">
                {[...dashboard.closedTrades].reverse().map(trade => (
                  <div key={trade.id} className={`border rounded-xl p-3 text-xs space-y-1 ${Number(trade.pnl) > 0 ? 'border-green-100' : 'border-red-100'}`}>
                    <div className="flex justify-between items-center">
                      <span className={`px-2 py-0.5 rounded-full font-medium ${trade.type === 'buy' ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-700'}`}>{trade.type.toUpperCase()}</span>
                      <span className={`font-bold ${Number(trade.pnl) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                        {Number(trade.pnl) >= 0 ? '+' : ''}${Number(trade.pnl).toFixed(2)} ({(Number(trade.pnl_pct) * 100).toFixed(1)}%)
                      </span>
                    </div>
                    <div className="flex justify-between text-neutral-500">
                      <span>${Number(trade.entry_price).toLocaleString()} → ${Number(trade.exit_price).toLocaleString()}</span>
                      <span>{formatDuration(trade.entry_time, trade.exit_time)}</span>
                    </div>
                    <div className="text-neutral-400">{formatExitReason(trade.exit_reason)}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* AI Monitor Report */}
          {monitor && (
            <div className="bg-white rounded-2xl shadow-card p-4 space-y-4">
              <h3 className="font-semibold text-neutral-800">AI Monitor Report</h3>

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

              {monitor.aiAnalysis && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                  <p className="text-xs text-blue-600 font-medium mb-1">Análisis AI</p>
                  <p className="text-sm text-blue-800">{monitor.aiAnalysis}</p>
                </div>
              )}

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
  const padding = { top: 20, right: 20, bottom: 25, left: 60 }

  const values = data.map(d => initialCapital + d.pnl)
  const min = Math.min(initialCapital, ...values)
  const max = Math.max(initialCapital, ...values)
  const range = max - min || 1

  const toX = (i: number) => padding.left + (i / (data.length - 1)) * (width - padding.left - padding.right)
  const toY = (v: number) => height - padding.bottom - ((v - min) / range) * (height - padding.top - padding.bottom)

  const points = data.map((d, i) => `${toX(i)},${toY(initialCapital + d.pnl)}`).join(' ')
  const baseY = toY(initialCapital)

  // Drawdown area fill
  const fillPoints = data.map((d, i) => `${toX(i)},${toY(initialCapital + d.pnl)}`).join(' ')
  const lastX = toX(data.length - 1)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48">
      {/* Drawdown fill (below baseline) */}
      <polyline
        fill="rgba(239,68,68,0.08)"
        stroke="none"
        points={`${toX(0)},${baseY} ${fillPoints} ${lastX},${baseY}`}
      />
      {/* Baseline */}
      <line x1={padding.left} y1={baseY} x2={width - padding.right} y2={baseY} stroke="#94a3b8" strokeWidth="1" strokeDasharray="4,4" />
      {/* Equity line */}
      <polyline fill="none" stroke="#6366f1" strokeWidth="2" points={points} />
      {/* Y axis labels */}
      <text x={padding.left - 5} y={toY(max) + 4} fontSize="9" fill="#94a3b8" textAnchor="end">${max.toLocaleString()}</text>
      <text x={padding.left - 5} y={toY(initialCapital) + 4} fontSize="9" fill="#94a3b8" textAnchor="end">${initialCapital.toLocaleString()}</text>
      <text x={padding.left - 5} y={toY(min) + 4} fontSize="9" fill="#94a3b8" textAnchor="end">${min.toLocaleString()}</text>
      {/* X axis labels */}
      <text x={padding.left} y={height - 5} fontSize="9" fill="#94a3b8">{data[0].timestamp.split('T')[0]}</text>
      <text x={width - padding.right} y={height - 5} fontSize="9" fill="#94a3b8" textAnchor="end">{data[data.length - 1].timestamp.split('T')[0]}</text>
    </svg>
  )
}
