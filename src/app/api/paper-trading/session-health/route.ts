import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

export const dynamic = 'force-dynamic'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface TradeRow {
  pnl: number
  pnl_pct: number
  status: string
  exit_reason: string | null
  created_at: string
}

type MaturityLevel = 'immature' | 'developing' | 'mature' | 'proven'

function computeMaturityScore(trades: number, days: number, pf: number, sharpe: number, wr: number) {
  // Trades dimension (0-40 pts)
  const tradePts = trades >= 100 ? 40 : trades >= 50 ? 25 : trades >= 30 ? 15 : Math.floor(trades / 30 * 15)

  // Time dimension (0-30 pts)
  const timePts = days >= 30 ? 30 : days >= 14 ? 20 : days >= 7 ? 10 : Math.floor(days / 7 * 10)

  // Performance dimension (0-30 pts)
  let perfPts = 0
  if (pf > 1.3) perfPts += 15
  if (sharpe > 0.5) perfPts += 10
  if (wr > 0.5) perfPts += 5

  const score = tradePts + timePts + perfPts
  const level: MaturityLevel =
    score >= 76 ? 'proven' :
    score >= 51 ? 'mature' :
    score >= 26 ? 'developing' : 'immature'

  const readyForLive = score >= 75 && pf > 1.3 && trades >= 50 && days >= 21

  return {
    score,
    level,
    trades_target: 100,
    trades_remaining: Math.max(0, 100 - trades),
    days_target: 30,
    days_remaining: Math.max(0, 30 - days),
    pf_ok: pf > 1.3,
    ready_for_live: readyForLive,
  }
}

function computeProfitFactor(trades: TradeRow[]) {
  const closed = trades.filter(t => t.status === 'closed')
  const grossProfit = closed.filter(t => t.pnl > 0).reduce((s, t) => s + t.pnl, 0)
  const grossLoss = Math.abs(closed.filter(t => t.pnl <= 0).reduce((s, t) => s + t.pnl, 0))
  return grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0
}

function computeSharpe(trades: TradeRow[]) {
  const closed = trades.filter(t => t.status === 'closed')
  if (closed.length < 2) return 0
  const returns = closed.map(t => t.pnl_pct)
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / (returns.length - 1)
  const std = Math.sqrt(variance)
  return std > 0 ? (mean / std) * Math.sqrt(252) : 0
}

function computeSortino(trades: TradeRow[]) {
  const closed = trades.filter(t => t.status === 'closed')
  if (closed.length < 2) return 0
  const returns = closed.map(t => t.pnl_pct)
  const mean = returns.reduce((s, r) => s + r, 0) / returns.length
  const downsideDev = Math.sqrt(
    returns.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / returns.length
  )
  return downsideDev > 0 ? (mean / downsideDev) * Math.sqrt(252) : 0
}

function computeMaxDrawdown(trades: TradeRow[], initialCapital: number) {
  const closed = trades.filter(t => t.status === 'closed')
  let peak = initialCapital
  let maxDd = 0
  let capital = initialCapital
  for (const t of closed) {
    capital += t.pnl
    if (capital > peak) peak = capital
    const dd = (peak - capital) / peak
    if (dd > maxDd) maxDd = dd
  }
  return maxDd
}

function computeRecentTrend(trades: TradeRow[]) {
  const closed = trades.filter(t => t.status === 'closed')
  const last10 = closed.slice(-10)
  if (last10.length === 0) return { last10_wr: 0, last10_pnl: 0, improving: false }
  const wins = last10.filter(t => t.pnl > 0).length
  const pnl = last10.reduce((s, t) => s + t.pnl, 0)

  // Compare last 10 vs previous 10
  const prev10 = closed.slice(-20, -10)
  const prevWr = prev10.length > 0 ? prev10.filter(t => t.pnl > 0).length / prev10.length : 0
  const currWr = wins / last10.length

  return {
    last10_wr: Math.round(currWr * 1000) / 1000,
    last10_pnl: Math.round(pnl * 100) / 100,
    improving: currWr > prevWr,
  }
}

/**
 * GET /api/paper-trading/session-health?secret=<CRON_SECRET>
 * Returns per-session health metrics with maturity scoring for live-readiness monitoring.
 */
export async function GET(req: NextRequest) {
  const secret = req.headers.get('x-cron-secret') || req.nextUrl.searchParams.get('secret')
  if (secret !== process.env.CRON_SECRET) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getServiceClient()

  // Fetch active sessions with strategy name
  const { data: sessions, error: sessErr } = await supabase
    .from('paper_sessions')
    .select('id, symbol, timeframe, initial_capital, current_capital, created_at, strategy_id, strategies(name)')
    .eq('status', 'active')
    .order('created_at', { ascending: true })

  if (sessErr || !sessions) {
    return NextResponse.json({ error: sessErr?.message ?? 'No sessions' }, { status: 500 })
  }

  // Fetch all trades for active sessions in one query
  const sessionIds = sessions.map(s => s.id)
  const { data: allTrades } = await supabase
    .from('paper_trades')
    .select('session_id, pnl, pnl_pct, status, exit_reason, created_at')
    .in('session_id', sessionIds)
    .order('created_at', { ascending: true })

  const tradesBySession = new Map<string, TradeRow[]>()
  for (const t of (allTrades ?? [])) {
    const list = tradesBySession.get(t.session_id) ?? []
    list.push(t as TradeRow)
    tradesBySession.set(t.session_id, list)
  }

  let totalPnl = 0
  const levelCounts = { immature: 0, developing: 0, mature: 0, proven: 0 }
  let readyCount = 0

  const sessionResults = sessions.map(s => {
    const trades = tradesBySession.get(s.id) ?? []
    const closed = trades.filter(t => t.status === 'closed')
    const wins = closed.filter(t => t.pnl > 0).length
    const wr = closed.length > 0 ? wins / closed.length : 0
    const netPnl = s.current_capital - s.initial_capital
    const pnlPct = (netPnl / s.initial_capital) * 100
    const pf = computeProfitFactor(trades)
    const sharpe = computeSharpe(trades)
    const sortino = computeSortino(trades)
    const maxDd = computeMaxDrawdown(trades, s.initial_capital)
    const daysActive = (Date.now() - new Date(s.created_at).getTime()) / (1000 * 60 * 60 * 24)
    const maturity = computeMaturityScore(closed.length, daysActive, pf, sharpe, wr)
    const recentTrend = computeRecentTrend(trades)

    totalPnl += netPnl
    levelCounts[maturity.level]++
    if (maturity.ready_for_live) readyCount++

    const strategyData = s.strategies as unknown as { name: string } | null

    return {
      id: s.id,
      symbol: s.symbol,
      timeframe: s.timeframe,
      strategy_name: strategyData?.name ?? 'Unknown',
      days_active: Math.round(daysActive * 10) / 10,
      total_trades: closed.length,
      open_trades: trades.filter(t => t.status === 'open').length,
      win_rate: Math.round(wr * 1000) / 1000,
      pnl_pct: Math.round(pnlPct * 100) / 100,
      profit_factor: Math.round(pf * 100) / 100,
      sharpe: Math.round(sharpe * 100) / 100,
      sortino: Math.round(sortino * 100) / 100,
      max_drawdown: Math.round(maxDd * 10000) / 100,
      maturity,
      recent_trend: recentTrend,
    }
  })

  return NextResponse.json({
    sessions: sessionResults,
    summary: {
      total_active: sessions.length,
      ...levelCounts,
      ready_for_live: readyCount,
      total_pnl: Math.round(totalPnl * 100) / 100,
    },
    timestamp: new Date().toISOString(),
  })
}
