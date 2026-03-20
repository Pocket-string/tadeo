import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

interface EvalResult {
  sessionId: string
  symbol: string
  grade: string
  action: 'retired' | 'warning' | 'ok'
  reason: string
}

/**
 * Cron endpoint: evaluate all active paper trading sessions and auto-retire failing ones.
 * Grades: A/B/C = keep, D = warning, F = auto-retire.
 */
export async function POST(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const cronSecret = process.env.CRON_SECRET
  const serviceKeySuffix = process.env.SUPABASE_SERVICE_ROLE_KEY?.slice(-10)
  const providedToken = authHeader?.replace('Bearer ', '')

  const isAuthorized =
    (cronSecret && providedToken === cronSecret) ||
    (serviceKeySuffix && providedToken === serviceKeySuffix)

  if (!isAuthorized) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabase = getServiceClient()
  const results: EvalResult[] = []

  // Get all active sessions with 10+ trades
  const { data: sessions } = await supabase
    .from('paper_sessions')
    .select('*, strategies(name)')
    .eq('status', 'active')
    .gte('total_trades', 10)

  if (!sessions || sessions.length === 0) {
    return NextResponse.json({ message: 'No sessions to evaluate', results: [] })
  }

  for (const session of sessions) {
    try {
      // Fetch closed trades for this session
      const { data: trades } = await supabase
        .from('paper_trades')
        .select('pnl, pnl_pct')
        .eq('session_id', session.id)
        .eq('status', 'closed')

      if (!trades || trades.length < 10) continue

      const totalTrades = trades.length
      const winners = trades.filter(t => Number(t.pnl) > 0)
      const losers = trades.filter(t => Number(t.pnl) <= 0)
      const winRate = winners.length / totalTrades
      const grossProfit = winners.reduce((s, t) => s + Number(t.pnl), 0)
      const grossLoss = Math.abs(losers.reduce((s, t) => s + Number(t.pnl), 0))
      const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 999 : 0
      const netPnl = Number(session.net_pnl)

      // Sharpe
      const returns = trades.map(t => Number(t.pnl_pct))
      const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length
      const stdReturn = returns.length > 1
        ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
        : 0
      const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0

      // Max drawdown
      let peak = Number(session.initial_capital)
      let maxDD = 0
      let equity = peak
      for (const t of trades) {
        equity += Number(t.pnl)
        if (equity > peak) peak = equity
        const dd = (peak - equity) / peak
        if (dd > maxDD) maxDD = dd
      }

      // Consecutive losses
      let maxConsecLoss = 0
      let streak = 0
      for (const t of trades) {
        if (Number(t.pnl) <= 0) { streak++; if (streak > maxConsecLoss) maxConsecLoss = streak }
        else { streak = 0 }
      }

      // Grade
      let grade: string
      if (sharpe > 1.5 && winRate > 0.55 && profitFactor > 2.0 && maxDD < 0.10 && totalTrades >= 30) grade = 'A'
      else if (sharpe > 1.0 && winRate > 0.50 && profitFactor > 1.5 && maxDD < 0.15 && totalTrades >= 20) grade = 'B'
      else if (sharpe > 0.5 && winRate > 0.45 && profitFactor > 1.2 && maxDD < 0.20) grade = 'C'
      else if (netPnl > 0) grade = 'D'
      else grade = 'F'

      // Auto-retire F strategies
      if (grade === 'F' || maxDD > 0.25 || maxConsecLoss >= 5 || (totalTrades >= 15 && winRate < 0.35)) {
        // Close open trades at current capital
        const { data: openTrades } = await supabase
          .from('paper_trades')
          .select('id')
          .eq('session_id', session.id)
          .eq('status', 'open')

        if (openTrades) {
          for (const t of openTrades) {
            await supabase.from('paper_trades').update({
              status: 'closed',
              exit_reason: 'auto_retired',
              exit_time: new Date().toISOString(),
              pnl: 0,
              pnl_pct: 0,
            }).eq('id', t.id)
          }
        }

        // Stop session
        await supabase.from('paper_sessions').update({
          status: 'stopped',
          stopped_at: new Date().toISOString(),
        }).eq('id', session.id)

        // Retire strategy
        await supabase.from('strategies').update({
          status: 'retired',
        }).eq('id', session.strategy_id)

        const reason = maxDD > 0.25 ? `DD ${(maxDD * 100).toFixed(1)}% > 25%`
          : maxConsecLoss >= 5 ? `${maxConsecLoss} consecutive losses`
          : winRate < 0.35 ? `WR ${(winRate * 100).toFixed(0)}% < 35%`
          : `Grade F (PnL: ${netPnl.toFixed(2)})`

        results.push({ sessionId: session.id, symbol: session.symbol, grade, action: 'retired', reason })
      } else if (grade === 'D') {
        results.push({ sessionId: session.id, symbol: session.symbol, grade, action: 'warning', reason: `Underperforming: WR ${(winRate * 100).toFixed(0)}%, PF ${profitFactor.toFixed(2)}, Sharpe ${sharpe.toFixed(2)}` })
      } else {
        results.push({ sessionId: session.id, symbol: session.symbol, grade, action: 'ok', reason: `Healthy: Grade ${grade}` })
      }
    } catch (err) {
      results.push({ sessionId: session.id, symbol: session.symbol, grade: '?', action: 'ok', reason: `Error: ${err instanceof Error ? err.message : 'Unknown'}` })
    }
  }

  return NextResponse.json({
    message: `Evaluated ${sessions.length} sessions`,
    retired: results.filter(r => r.action === 'retired').length,
    warnings: results.filter(r => r.action === 'warning').length,
    healthy: results.filter(r => r.action === 'ok').length,
    results,
    timestamp: new Date().toISOString(),
  })
}
