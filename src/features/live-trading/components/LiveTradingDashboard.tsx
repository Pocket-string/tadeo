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
} from '@/actions/live-trading'
import type { LiveSession, LiveTrade, DailyReport } from '../types'
import { TRADING_PAIRS } from '@/shared/lib/trading-pairs'

export function LiveTradingDashboard() {
  const [sessions, setSessions] = useState<LiveSession[]>([])
  const [activeSession, setActiveSession] = useState<string | null>(null)
  const [dashboard, setDashboard] = useState<{
    session: LiveSession
    openTrades: LiveTrade[]
    closedTrades: LiveTrade[]
    currentPrice: number | null
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

  const loadDashboard = useCallback(async (sessionId: string) => {
    try {
      const data = await getLiveDashboard(sessionId)
      setDashboard(data)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Error cargando dashboard')
    }
  }, [])

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
    if (!confirm('⚠️ KILL SWITCH: Esto cerrará TODAS las posiciones inmediatamente. ¿Confirmar?')) return
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

  const hasApiKeys = true // We can't check env vars client-side, but the server will error if missing

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

      {/* Warning Banner */}
      <div className="bg-amber-50 border-2 border-amber-300 rounded-2xl p-4">
        <div className="flex items-start gap-3">
          <span className="text-2xl">⚠️</span>
          <div>
            <p className="font-semibold text-amber-800">Trading Live — Dinero Real</p>
            <p className="text-sm text-amber-700">
              Las operaciones se ejecutan en el exchange con fondos reales.
              Asegúrate de tener configuradas las API keys de Binance con permisos de trading.
              {!process.env.NEXT_PUBLIC_HAS_EXCHANGE_KEYS && ' Sin API keys configuradas se usará el simulador.'}
            </p>
          </div>
        </div>
      </div>

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
            <KPICard label="Posiciones" value={String(dashboard.openTrades.length)} />
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

          {/* Closed Trades */}
          {dashboard.closedTrades.length > 0 && (
            <div className="bg-white rounded-2xl shadow-card p-4">
              <h3 className="font-semibold text-neutral-800 mb-3">
                Historial de Trades ({dashboard.closedTrades.length})
              </h3>
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
                      <th className="text-left py-2">Order ID</th>
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
                        <td className="py-2 text-xs text-neutral-400 font-mono">{trade.exchange_order_id ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
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

function KPICard({ label, value, color }: { label: string; value: string; color?: 'green' | 'red' }) {
  return (
    <div className="bg-white rounded-2xl shadow-card p-4">
      <p className="text-xs text-neutral-500">{label}</p>
      <p className={`text-lg font-bold ${color === 'green' ? 'text-green-600' : color === 'red' ? 'text-red-600' : 'text-neutral-800'}`}>
        {value}
      </p>
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
