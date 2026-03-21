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
  action: 'retired' | 'warning' | 'ok' | 'scale_proposed'
  reason: string
}

/**
 * Cron endpoint: evaluate all active paper trading sessions and auto-retire failing ones.
 * Grades: A/B/C = keep, D = warning, F = auto-retire.
 * Also: triggers targeted discovery on retire, proposes scale-up for A/B sessions.
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

      // Days since session started
      const daysSinceStart = session.created_at
        ? (Date.now() - new Date(session.created_at).getTime()) / (1000 * 60 * 60 * 24)
        : 0

      // Grade
      let grade: string
      if (sharpe > 1.5 && winRate > 0.55 && profitFactor > 2.0 && maxDD < 0.10 && totalTrades >= 30) grade = 'A'
      else if (sharpe > 1.0 && winRate > 0.50 && profitFactor > 1.5 && maxDD < 0.15 && totalTrades >= 20) grade = 'B'
      else if (sharpe > 0.5 && winRate > 0.45 && profitFactor > 1.2 && maxDD < 0.20) grade = 'C'
      else if (netPnl > 0) grade = 'D'
      else grade = 'F'

      const metricsSnapshot = { totalTrades, winRate, sharpe, maxDD, profitFactor, netPnl, maxConsecLoss }

      // Auto-retire: F, DD>25%, 5 consec losses, WR<35% with 15+ trades, OR Sharpe<0 with 20+ trades
      const shouldRetire =
        grade === 'F' ||
        maxDD > 0.25 ||
        maxConsecLoss >= 5 ||
        (totalTrades >= 15 && winRate < 0.35) ||
        (totalTrades >= 20 && sharpe < 0)

      if (shouldRetire) {
        // Close open trades
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
          : (totalTrades >= 15 && winRate < 0.35) ? `WR ${(winRate * 100).toFixed(0)}% < 35%`
          : (totalTrades >= 20 && sharpe < 0) ? `Sharpe ${sharpe.toFixed(2)} < 0 (${totalTrades} trades)`
          : `Grade F (PnL: ${netPnl.toFixed(2)})`

        // Log retirement event
        await supabase.from('paper_session_events').insert({
          session_id: session.id,
          event_type: 'auto_retired',
          reason,
          metrics_snapshot: metricsSnapshot,
        })

        // Trigger targeted discovery for this symbol+timeframe (non-blocking)
        triggerTargetedDiscovery(
          session.symbol,
          session.timeframe,
          session.user_id,
          reason
        ).catch(() => { /* non-blocking */ })

        results.push({ sessionId: session.id, symbol: session.symbol, grade, action: 'retired', reason })

      } else if (grade === 'A' && daysSinceStart >= 7) {
        // Propose capital scale-up for Grade A sessions sustained 7+ days
        const proposedCapital = Math.round(Number(session.current_capital) * 2)
        const { data: existingProposal } = await supabase
          .from('paper_session_proposals')
          .select('id')
          .eq('session_id', session.id)
          .eq('proposal_type', 'scale_up')
          .eq('status', 'pending')
          .maybeSingle()

        if (!existingProposal) {
          await supabase.from('paper_session_proposals').insert({
            session_id: session.id,
            user_id: session.user_id,
            proposal_type: 'scale_up',
            proposed_value: {
              current_capital: Number(session.current_capital),
              proposed_capital: proposedCapital,
              symbol: session.symbol,
              timeframe: session.timeframe,
              grade,
              sharpe: sharpe.toFixed(2),
              win_rate: (winRate * 100).toFixed(0),
            },
            reason: `Grade A sostenido ${daysSinceStart.toFixed(0)} días. WR:${(winRate * 100).toFixed(0)}% Sharpe:${sharpe.toFixed(2)}`,
          })

          await supabase.from('paper_session_events').insert({
            session_id: session.id,
            event_type: 'scale_proposed',
            reason: `Capital propuesto: $${Number(session.current_capital)} → $${proposedCapital}`,
            metrics_snapshot: metricsSnapshot,
          })
        }

        results.push({ sessionId: session.id, symbol: session.symbol, grade, action: 'scale_proposed', reason: `Grade A — propuesta de escalado a $${proposedCapital}` })

      } else if (grade === 'B' && daysSinceStart >= 7 && totalTrades >= 20) {
        // Propose 50% scale-up for Grade B sessions with 20+ trades sustained 7+ days
        const proposedCapital = Math.round(Number(session.current_capital) * 1.5)
        const { data: existingProposal } = await supabase
          .from('paper_session_proposals')
          .select('id')
          .eq('session_id', session.id)
          .eq('proposal_type', 'scale_up')
          .eq('status', 'pending')
          .maybeSingle()

        if (!existingProposal) {
          await supabase.from('paper_session_proposals').insert({
            session_id: session.id,
            user_id: session.user_id,
            proposal_type: 'scale_up',
            proposed_value: {
              current_capital: Number(session.current_capital),
              proposed_capital: proposedCapital,
              symbol: session.symbol,
              timeframe: session.timeframe,
              grade,
              sharpe: sharpe.toFixed(2),
              win_rate: (winRate * 100).toFixed(0),
            },
            reason: `Grade B, ${totalTrades} trades, ${daysSinceStart.toFixed(0)} días. WR:${(winRate * 100).toFixed(0)}% Sharpe:${sharpe.toFixed(2)}`,
          })
        }

        results.push({ sessionId: session.id, symbol: session.symbol, grade, action: 'ok', reason: `Grade B — propuesta +50% capital` })

      } else if (grade === 'D') {
        await supabase.from('paper_session_events').insert({
          session_id: session.id,
          event_type: 'grade_warning',
          reason: `Grade D: WR ${(winRate * 100).toFixed(0)}%, PF ${profitFactor.toFixed(2)}, Sharpe ${sharpe.toFixed(2)}`,
          metrics_snapshot: metricsSnapshot,
        })
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
    scale_proposed: results.filter(r => r.action === 'scale_proposed').length,
    healthy: results.filter(r => r.action === 'ok').length,
    results,
    timestamp: new Date().toISOString(),
  })
}

/**
 * Trigger targeted discovery for a specific symbol+timeframe after a session retires.
 * Non-blocking — runs in background.
 */
async function triggerTargetedDiscovery(
  symbol: string,
  timeframe: string,
  userId: string,
  failureReason: string
): Promise<void> {
  const baseUrl = process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3000'
  await fetch(`${baseUrl}/api/cron/discover`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'authorization': `Bearer ${process.env.CRON_SECRET}`,
    },
    body: JSON.stringify({ symbol, timeframe, userId, failureReason }),
  })
}
