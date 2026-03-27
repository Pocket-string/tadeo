'use client'

import { useState, useEffect, useCallback } from 'react'
import {
  startLive,
  stopLive,
  tickLive,
  pauseLive,
  resumeLive,
  triggerKillSwitch,
  getDailyReport,
  getLiveSessions,
  getLiveDashboard,
  getStrategiesForLive,
  getBinanceBalance,
  getLiveAgentLog,
  getLiveSignalAttribution,
} from '@/actions/live-trading'
import type { LiveSession, LiveTrade, DailyReport } from '../types'
import { TRADING_PAIRS } from '@/shared/lib/trading-pairs'
import { formatAgentEventType, formatExitReason, formatDuration, gradeColor } from '@/features/paper-trading/utils/formatters'

function computeGrade(session: LiveSession): string {
  if (session.total_trades < 5) return '—'
  const wr = session.total_trades > 0 ? session.winning_trades / session.total_trades : 0
  const pnl = Number(session.net_pnl)
  if (wr >= 0.6 && pnl > 0) return 'A'
  if (wr >= 0.5 && pnl >= 0) return 'B'
  if (wr >= 0.45) return 'C'
  if (wr >= 0.35) return 'D'
  return 'F'
}

type AgentLogEntry = { event_type: string; reason: string; price: number | null; pnl: number | null; created_at: string; symbol: string; timeframe: string }
type AttributionEntry = { system: string; wins: number; losses: number; winRate: number; contribution: string }

export function LiveTradingDashboard() {
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<{
    session: LiveSession
    openTrades: LiveTrade[]
    closedTrades: LiveTrade[]
    currentPrice: number | null
    pnlHistory: { timestamp: string; pnl: number }[]
  } | null>(null)
  const [report, setReport] = useState<DailyReport | null>(null)
  const [strategies, setStrategies] = useState<{ id: string; name: string }[]>([])
  const [loading, setLoading] = useState(true)
  const [tickLoading, setTickLoading] = useState(false)
  const [showNewSession, setShowNewSession] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [lastTickResult, setLastTickResult] = useState<string | null>(null)
  const [binanceBalance, setBinanceBalance] = useState<{ asset: string; free: number; locked: number }[] | null>(null)
  const [confirmStart, setConfirmStart] = useState(false)

  // New state for parity with paper
  const [agentLog, setAgentLog] = useState<AgentLogEntry[]>([])
  const [logSort, setLogSort] = useState<'recent' | 'best'>('recent')
  const [attribution, setAttribution] = useState<AttributionEntry[]>([])
  const [attributionWindow, setAttributionWindow] = useState(15)

  // Form state
  const [newStrategyId, setNewStrategyId] = useState('')
  const [newSymbol, setNewSymbol] = useState('SOLUSDT')
  const [newTimeframe, setNewTimeframe] = useState('5m')
  const [newCapital, setNewCapital] = useState(100)

  const loadSessions = useCallback(async () => {
    try {
      const [sess, strats] = await Promise.all([getLiveSessions(), getStrategiesForLive()])
      setSessions(sess)
      setStrategies(strats)
      if (strats.length > 0 && !newStrategyId) setNewStrategyId(strats[0].id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando sesiones')
    } finally {
      setLoading(false)
    }
  }, [newStrategyId])

  const loadDashboard = useCallback(async (sessionId: string, attrLimit?: number) => {
    try {
      const [data, log, attr] = await Promise.all([
        getLiveDashboard(sessionId),
        getLiveAgentLog(30),
        getLiveSignalAttribution(sessionId, attrLimit ?? attributionWindow),
      ])
      setDashboard(data)
      setAgentLog(log)
      setAttribution(attr)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando dashboard')
    }
  }, [attributionWindow])

  useEffect(() => { loadSessions() }, [loadSessions])
  useEffect(() => { if (activeSession) loadDashboard(activeSession) }, [activeSession, loadDashboard])

  // Auto-refresh every 10s for active sessions
  useEffect(() => {
    if (!activeSession || !dashboard?.session || dashboard.session.status !== 'active') return
    const interval = setInterval(() => loadDashboard(activeSession), 10000)
    return () => clearInterval(interval)
  }, [activeSession, dashboard?.session?.status, loadDashboard])

  // Load Binance balance when opening new session form
  useEffect(() => {
    if (!showNewSession) return
    getBinanceBalance()
      .then(b => setBinanceBalance(b))
      .catch(() => setBinanceBalance(null))
  }, [showNewSession])

  const handleStart = async () => {
    if (!newStrategyId || !confirmStart) return
    setError(null)
    try {
      const session = await startLive({
        strategyId: newStrategyId,
        symbol: newSymbol,
        timeframe: newTimeframe,
        initialCapital: newCapital,
      })
      setShowNewSession(false)
      setConfirmStart(false)
      await loadSessions()
      setActiveSession(session.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error iniciando sesión')
    }
  }

  const handleStop = async (id: string) => {
    if (!confirm('¿Detener esta sesión? Se cerrarán todas las posiciones abiertas en el exchange.')) return
    try {
      await stopLive(id)
      await loadSessions()
      if (activeSession === id) await loadDashboard(id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error deteniendo sesión')
    }
  }

  const handleKillSwitch = async () => {
    if (!activeSession) return
    if (!confirm('KILL SWITCH: Esto cerrará TODAS las posiciones inmediatamente. ¿Confirmar?')) return
    try {
      const result = await triggerKillSwitch(activeSession, 'Activado manualmente por usuario')
      setError(null)
      setLastTickResult(`Kill switch activado. ${result.closedPositions} posiciones cerradas.`)
      await loadSessions()
      await loadDashboard(activeSession)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error en kill switch')
    }
  }

  const handleTick = async () => {
    if (!activeSession) return
    setTickLoading(true)
    setError(null)
    try {
      const result = await tickLive(activeSession)
      setLastTickResult(`${result.action}: ${result.reason}`)
      await loadDashboard(activeSession)
      await loadSessions()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error ejecutando tick')
    } finally {
      setTickLoading(false)
    }
  }

  const handlePause = async () => {
    if (!activeSession) return
    try {
      await pauseLive(activeSession, 'Pausado manualmente')
      await loadSessions()
      await loadDashboard(activeSession)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error pausando sesión')
    }
  }

  const handleResume = async () => {
    if (!activeSession) return
    if (!confirm('¿Reactivar esta sesión de trading live?')) return
    try {
      await resumeLive(activeSession)
      await loadSessions()
      await loadDashboard(activeSession)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error reactivando sesión')
    }
  }

  const handleReport = async () => {
    if (!activeSession) return
    try {
      const r = await getDailyReport(activeSession)
      setReport(r)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error generando reporte')
    }
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map(i => <div key={i} className="h-32 bg-white rounded-2xl animate-pulse" />)}
      </div>
    )
  }

  const grade = dashboard ? computeGrade(dashboard.session) : '—'

  return (
    <div className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {lastTickResult && (
        <div className="bg-blue-50 border border-blue-200 text-blue-700 px-4 py-3 rounded-xl text-sm">
          {lastTickResult}
          <button onClick={() => setLastTickResult(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-heading font-semibold text-neutral-800">Live Trading</h2>
        <button
          onClick={() => setShowNewSession(!showNewSession)}
          className="px-4 py-2 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition text-sm font-medium"
        >
          {showNewSession ? 'Cancelar' : '+ Nueva Sesión Live'}
        </button>
      </div>

      {/* New Session Form */}
      {showNewSession && (
        <div className="bg-white rounded-2xl shadow-card p-6 space-y-4 border-2 border-red-200">
          <h3 className="font-semibold text-neutral-800">Iniciar Sesión Live</h3>

          {/* Binance Balance */}
          {binanceBalance && (
            <div className="bg-neutral-50 rounded-xl p-3">
              <p className="text-xs text-neutral-500 font-medium mb-1">Balance Binance</p>
              <div className="flex flex-wrap gap-3">
                {binanceBalance.map(b => (
                  <span key={b.asset} className="text-sm font-semibold text-neutral-800">
                    {b.asset}: {b.free.toFixed(2)} {b.locked > 0 && <span className="text-neutral-400">(+{b.locked.toFixed(2)} bloq.)</span>}
                  </span>
                ))}
                {binanceBalance.length === 0 && <span className="text-sm text-red-600">Sin fondos disponibles</span>}
              </div>
            </div>
          )}

          <div className="bg-red-50 border-2 border-red-300 rounded-xl p-4 text-sm text-red-700">
            <p className="font-bold text-red-800 mb-1">DINERO REAL</p>
            <p>Las operaciones se ejecutarán en Binance con tus fondos reales. Asegúrate de que la estrategia ha sido validada en paper trading con resultados positivos.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Estrategia</label>
              <select
                value={newStrategyId}
                onChange={e => setNewStrategyId(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
              >
                {strategies.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Símbolo</label>
              <select
                value={newSymbol}
                onChange={e => setNewSymbol(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
              >
                {TRADING_PAIRS.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Timeframe</label>
              <select
                value={newTimeframe}
                onChange={e => setNewTimeframe(e.target.value)}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
              >
                {['5m', '15m', '1h', '4h'].map(tf => (
                  <option key={tf} value={tf}>{tf}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-neutral-500 mb-1">Capital Inicial (USDT)</label>
              <input
                type="number"
                value={newCapital}
                onChange={e => setNewCapital(Number(e.target.value))}
                className="w-full px-3 py-2 border border-neutral-200 rounded-xl text-sm"
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={confirmStart}
              onChange={e => setConfirmStart(e.target.checked)}
              className="w-4 h-4 rounded border-red-300 text-red-600 focus:ring-red-500"
            />
            <span className="text-red-700 font-medium">Entiendo que puedo perder capital real con esta operación</span>
          </label>
          <button
            onClick={handleStart}
            disabled={!newStrategyId || strategies.length === 0 || !confirmStart}
            className="px-6 py-2 bg-red-600 text-white rounded-xl hover:bg-red-700 transition text-sm font-bold disabled:opacity-50 disabled:cursor-not-allowed"
          >
            Iniciar Trading Real
          </button>
        </div>
      )}

      {/* Agent Decision Feed */}
      {agentLog.length > 0 && (
        <div className="bg-white rounded-2xl shadow-card p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <h3 className="font-semibold text-neutral-800">Agente — Decisiones Live</h3>
              <span className="flex items-center gap-1.5">
                <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                <span className="text-xs text-green-600 font-medium">Cron activo</span>
              </span>
            </div>
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
          <div className="border-t pt-3 max-h-72 overflow-y-auto space-y-1.5">
            {[...agentLog].sort((a, b) => {
              if (logSort === 'best') return (b.pnl ?? -Infinity) - (a.pnl ?? -Infinity)
              return 0
            }).map((entry, idx) => {
              const { label, color } = formatAgentEventType(entry.event_type)
              const isAction = ['buy', 'sell', 'close'].includes(entry.event_type)
              return (
                <div key={idx} className={`flex items-start justify-between text-xs gap-2 py-1 ${isAction ? 'border-l-2 border-primary-300 pl-2 -ml-2' : ''}`}>
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
      )}

      {/* Sessions */}
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
              <SessionStatusBadge status={session.status} />
            </div>
            <div className="text-xs text-neutral-500 space-y-1">
              <div>Capital: ${Number(session.current_capital).toLocaleString()}</div>
              <div className={`font-medium ${Number(session.net_pnl) >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                PnL: {Number(session.net_pnl) >= 0 ? '+' : ''}${Number(session.net_pnl).toFixed(2)}
              </div>
              <div>Max DD: {(Number(session.max_drawdown_pct ?? 0) * 100).toFixed(1)}%</div>
              <div>Trades: {session.total_trades} ({session.winning_trades} ganados)</div>
            </div>
            {session.pause_reason && (
              <div className="mt-2 text-xs text-amber-600 bg-amber-50 rounded-lg p-2">
                {session.pause_reason}
              </div>
            )}
          </div>
        ))}
        {sessions.length === 0 && (
          <div className="col-span-full text-center py-12 text-neutral-400">
            No hay sesiones live. Crea una para empezar.
          </div>
        )}
      </div>

      {/* Active Session Dashboard */}
      {activeSession && dashboard && (
        <div className="space-y-4">
          {/* Control Bar */}
          <div className="bg-white rounded-2xl shadow-card p-4 flex flex-wrap items-center gap-3">
            {dashboard.session.status === 'active' && (
              <>
                <button
                  onClick={handleTick}
                  disabled={tickLoading}
                  className="px-4 py-2 bg-primary-500 text-white rounded-xl hover:bg-primary-600 transition text-sm font-medium disabled:opacity-50"
                >
                  {tickLoading ? 'Procesando...' : 'Ejecutar Tick'}
                </button>
                <button
                  onClick={handlePause}
                  className="px-4 py-2 bg-amber-500 text-white rounded-xl hover:bg-amber-600 transition text-sm font-medium"
                >
                  Pausar
                </button>
              </>
            )}
            {(dashboard.session.status === 'paused' || dashboard.session.status === 'emergency') && (
              <button
                onClick={handleResume}
                className="px-4 py-2 bg-green-600 text-white rounded-xl hover:bg-green-700 transition text-sm font-medium"
              >
                Reactivar (Human Gate)
              </button>
            )}
            {dashboard.session.status !== 'stopped' && (
              <>
                <button
                  onClick={() => handleStop(activeSession)}
                  className="px-4 py-2 bg-neutral-500 text-white rounded-xl hover:bg-neutral-600 transition text-sm font-medium"
                >
                  Detener
                </button>
                <button
                  onClick={handleKillSwitch}
                  className="px-4 py-2 bg-red-700 text-white rounded-xl hover:bg-red-800 transition text-sm font-bold border-2 border-red-900"
                >
                  KILL SWITCH
                </button>
              </>
            )}
            <button
              onClick={handleReport}
              className="px-4 py-2 bg-blue-500 text-white rounded-xl hover:bg-blue-600 transition text-sm font-medium"
            >
              AI Report
            </button>

            {dashboard.currentPrice && (
              <div className="ml-auto text-right">
                <div className="text-xs text-neutral-500">Precio Actual</div>
                <div className="font-semibold text-neutral-800">${dashboard.currentPrice.toLocaleString()}</div>
              </div>
            )}
          </div>

          {/* KPIs */}
          <div className="grid grid-cols-2 lg:grid-cols-5 gap-4">
            <KPICard label="Capital" value={`$${Number(dashboard.session.current_capital).toLocaleString()}`} />
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
            />
            <KPICard
              label="Max Drawdown"
              value={`${(Number(dashboard.session.max_drawdown_pct ?? 0) * 100).toFixed(1)}%`}
              color={Number(dashboard.session.max_drawdown_pct ?? 0) > 0.1 ? 'red' : undefined}
            />
            <KPICard
              label="Salud"
              value={grade}
              tooltip="A: WR≥60%+profit, B: WR≥50%, C: WR≥45%, D: WR≥35%, F: <35%"
              badgeColor={gradeColor(grade)}
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
                      <th className="text-left py-2">Exchange ID</th>
                    </tr>
                  </thead>
                  <tbody>
                    {dashboard.openTrades.map(trade => {
                      const curP = dashboard.currentPrice ?? Number(trade.entry_price)
                      const unrealized = trade.type === 'buy'
                        ? (curP - Number(trade.entry_price)) * Number(trade.quantity)
                        : (Number(trade.entry_price) - curP) * Number(trade.quantity)
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
                          <td className="text-right py-2">{Number(trade.quantity).toFixed(5)}</td>
                          <td className="text-right py-2 text-red-600">${Number(trade.stop_loss).toLocaleString()}</td>
                          <td className="text-right py-2 text-green-600">${Number(trade.take_profit).toLocaleString()}</td>
                          <td className={`text-right py-2 font-medium ${unrealized >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                            {unrealized >= 0 ? '+' : ''}${unrealized.toFixed(2)}
                          </td>
                          <td className="py-2 text-xs text-neutral-400 font-mono">{trade.exchange_order_id ?? '—'}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Signal Attribution */}
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
              <h3 className="font-semibold text-neutral-800 mb-3">
                Historial de Trades ({dashboard.closedTrades.length})
              </h3>
              {/* Desktop table */}
              <div className="hidden sm:block overflow-x-auto max-h-64 overflow-y-auto">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="text-xs text-neutral-500 border-b">
                      <th className="text-left py-2">Tipo</th>
                      <th className="text-right py-2">Entrada</th>
                      <th className="text-right py-2">Salida</th>
                      <th className="text-right py-2">Duración</th>
                      <th className="text-right py-2">PnL</th>
                      <th className="text-right py-2">%</th>
                      <th className="text-left py-2 pl-3">Razón</th>
                      <th className="text-left py-2">Order ID</th>
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
                        <td className="py-2 text-xs text-neutral-400 font-mono">{trade.exchange_order_id ?? '—'}</td>
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

          {/* AI Daily Report */}
          {report && (
            <div className="bg-white rounded-2xl shadow-card p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-semibold text-neutral-800">AI Report — {report.date}</h3>
                <RecommendationBadge rec={report.recommendation} />
              </div>

              <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
                <div className="bg-neutral-50 rounded-xl p-3">
                  <div className="text-xs text-neutral-500">Trades hoy</div>
                  <div className="font-semibold">{report.metrics.tradesExecuted}</div>
                </div>
                <div className="bg-neutral-50 rounded-xl p-3">
                  <div className="text-xs text-neutral-500">Win Rate hoy</div>
                  <div className="font-semibold">{(report.metrics.winRate * 100).toFixed(0)}%</div>
                </div>
                <div className="bg-neutral-50 rounded-xl p-3">
                  <div className="text-xs text-neutral-500">PnL hoy</div>
                  <div className={`font-semibold ${report.metrics.netPnl >= 0 ? 'text-green-600' : 'text-red-600'}`}>
                    ${report.metrics.netPnl.toFixed(2)}
                  </div>
                </div>
                <div className="bg-neutral-50 rounded-xl p-3">
                  <div className="text-xs text-neutral-500">Sharpe est.</div>
                  <div className="font-semibold">{report.metrics.sharpeEstimate.toFixed(2)}</div>
                </div>
              </div>

              {report.paperComparison && (
                <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm">
                  <p className="text-xs text-blue-600 font-medium mb-1">Comparación Paper vs Live</p>
                  <div className="grid grid-cols-3 gap-2">
                    <div>Paper: ${report.paperComparison.paperPnl.toFixed(2)}</div>
                    <div>Live: ${report.paperComparison.livePnl.toFixed(2)}</div>
                    <div>Divergencia: {report.paperComparison.divergencePct.toFixed(1)}%</div>
                  </div>
                </div>
              )}

              <div className="bg-neutral-50 rounded-xl p-4">
                <p className="text-xs text-neutral-500 font-medium mb-2">Análisis AI</p>
                <p className="text-sm text-neutral-700 whitespace-pre-line">{report.aiAnalysis}</p>
              </div>

              {report.recommendation !== 'continue' && (
                <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-4">
                  <p className="font-semibold text-amber-800 mb-1">ACCIÓN REQUERIDA</p>
                  <p className="text-sm text-amber-700">
                    El AI Advisor recomienda <strong>{report.recommendation}</strong>. La decisión final es tuya.
                  </p>
                  {report.recommendation === 'pause' && (
                    <button
                      onClick={handlePause}
                      className="mt-2 px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-medium"
                    >
                      Pausar Sesión
                    </button>
                  )}
                  {report.recommendation === 'stop' && (
                    <button
                      onClick={() => handleStop(activeSession!)}
                      className="mt-2 px-4 py-2 bg-red-600 text-white rounded-xl text-sm font-medium"
                    >
                      Detener Sesión
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

function SessionStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: 'bg-green-100 text-green-700',
    paused: 'bg-amber-100 text-amber-700',
    stopped: 'bg-neutral-100 text-neutral-500',
    emergency: 'bg-red-100 text-red-700',
  }
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${colors[status] ?? colors.stopped}`}>
      {status === 'emergency' ? 'EMERGENCIA' : status}
    </span>
  )
}

function KPICard({ label, value, color, tooltip, badgeColor }: { label: string; value: string; color?: 'green' | 'red'; tooltip?: string; badgeColor?: string }) {
  return (
    <div className="bg-white rounded-2xl shadow-card p-4" title={tooltip}>
      <p className="text-xs text-neutral-500 flex items-center gap-1">
        {label}
        {tooltip && <span className="text-neutral-300 cursor-help" title={tooltip}>?</span>}
      </p>
      {badgeColor ? (
        <span className={`inline-block px-3 py-1 rounded-full text-xl font-bold ${badgeColor}`}>{value}</span>
      ) : (
        <p className={`text-lg font-bold ${color === 'green' ? 'text-green-600' : color === 'red' ? 'text-red-600' : 'text-neutral-800'}`}>
          {value}
        </p>
      )}
    </div>
  )
}

function RecommendationBadge({ rec }: { rec: string }) {
  const colors: Record<string, string> = {
    continue: 'bg-green-100 text-green-700',
    adjust: 'bg-amber-100 text-amber-700',
    pause: 'bg-orange-100 text-orange-700',
    stop: 'bg-red-100 text-red-700',
  }
  return (
    <span className={`px-3 py-1 rounded-full text-xs font-semibold ${colors[rec] ?? colors.continue}`}>
      {rec.toUpperCase()}
    </span>
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
  const fillPoints = data.map((d, i) => `${toX(i)},${toY(initialCapital + d.pnl)}`).join(' ')
  const lastX = toX(data.length - 1)

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="w-full h-48">
      <polyline fill="rgba(239,68,68,0.08)" stroke="none" points={`${toX(0)},${baseY} ${fillPoints} ${lastX},${baseY}`} />
      <line x1={padding.left} y1={baseY} x2={width - padding.right} y2={baseY} stroke="#94a3b8" strokeWidth="1" strokeDasharray="4,4" />
      <polyline fill="none" stroke="#6366f1" strokeWidth="2" points={points} />
      <text x={padding.left - 5} y={toY(max) + 4} fontSize="9" fill="#94a3b8" textAnchor="end">${max.toLocaleString()}</text>
      <text x={padding.left - 5} y={toY(initialCapital) + 4} fontSize="9" fill="#94a3b8" textAnchor="end">${initialCapital.toLocaleString()}</text>
      <text x={padding.left - 5} y={toY(min) + 4} fontSize="9" fill="#94a3b8" textAnchor="end">${min.toLocaleString()}</text>
      <text x={padding.left} y={height - 5} fontSize="9" fill="#94a3b8">{data[0].timestamp.split('T')[0]}</text>
      <text x={width - padding.right} y={height - 5} fontSize="9" fill="#94a3b8" textAnchor="end">{data[data.length - 1].timestamp.split('T')[0]}</text>
    </svg>
  )
}
