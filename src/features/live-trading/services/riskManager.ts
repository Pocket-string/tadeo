'use server'

import { createClient } from '@/lib/supabase/server'
import type { RiskConfig, RiskCheckResult, LiveSession, LiveTrade } from '../types'
import { DEFAULT_RISK_CONFIG } from '../types'

/**
 * Risk Manager: Pre-trade validation and session-level risk controls.
 *
 * PRINCIPLES:
 * - AI can PROTECT (pause, close, alert) but NEVER RISK
 * - Kill switch is automatic — reactivation is ALWAYS human
 * - Every order must pass risk checks before execution
 */

export async function checkRisk(
  session: LiveSession,
  proposedTrade: { type: 'buy' | 'sell'; quantity: number; price: number },
  config: RiskConfig = DEFAULT_RISK_CONFIG
): Promise<RiskCheckResult> {
  const supabase = await createClient()

  // Get all trades for this session
  const { data: trades } = await supabase
    .from('live_trades')
    .select('*')
    .eq('session_id', session.id)
    .order('created_at', { ascending: true })

  const allTrades = (trades ?? []) as LiveTrade[]
  const openTrades = allTrades.filter(t => t.status === 'open')
  const closedTrades = allTrades.filter(t => t.status === 'closed')

  // Today's trades
  const today = new Date().toISOString().split('T')[0]
  const todayTrades = closedTrades.filter(t => t.entry_time.startsWith(today))
  const todayPnl = todayTrades.reduce((s, t) => s + Number(t.pnl), 0)

  // Check consecutive losses
  const recentClosed = [...closedTrades].reverse()
  let consecutiveLosses = 0
  for (const t of recentClosed) {
    if (Number(t.pnl) < 0) consecutiveLosses++
    else break
  }

  const tradeValue = proposedTrade.quantity * proposedTrade.price
  const positionSizePct = tradeValue / Number(session.current_capital)

  // Calculate total drawdown
  const totalPnl = Number(session.net_pnl)
  const totalDrawdownPct = totalPnl < 0
    ? Math.abs(totalPnl) / Number(session.initial_capital)
    : 0

  // Calculate daily drawdown
  const dailyDrawdownPct = todayPnl < 0
    ? Math.abs(todayPnl) / Number(session.current_capital)
    : 0

  const checks = {
    positionSize: positionSizePct <= config.maxPositionSizePct,
    dailyDrawdown: dailyDrawdownPct < config.maxDailyDrawdownPct,
    totalDrawdown: totalDrawdownPct < config.maxTotalDrawdownPct,
    openPositions: openTrades.length < config.maxOpenPositions,
    dailyTrades: todayTrades.length < config.maxDailyTrades,
    lossStreak: consecutiveLosses < config.cooldownAfterLossStreak,
  }

  const allPassed = Object.values(checks).every(Boolean)

  // Determine risk level
  let riskLevel: RiskCheckResult['riskLevel'] = 'low'
  if (!checks.totalDrawdown) riskLevel = 'critical'
  else if (!checks.dailyDrawdown || !checks.lossStreak) riskLevel = 'high'
  else if (!checks.positionSize || !checks.openPositions) riskLevel = 'medium'

  // Build reason
  const reasons: string[] = []
  if (!checks.positionSize) reasons.push(`Tamaño de posición (${(positionSizePct * 100).toFixed(1)}%) excede límite (${(config.maxPositionSizePct * 100)}%)`)
  if (!checks.dailyDrawdown) reasons.push(`Drawdown diario (${(dailyDrawdownPct * 100).toFixed(1)}%) excede límite (${(config.maxDailyDrawdownPct * 100)}%)`)
  if (!checks.totalDrawdown) reasons.push(`Drawdown total (${(totalDrawdownPct * 100).toFixed(1)}%) excede límite — KILL SWITCH`)
  if (!checks.openPositions) reasons.push(`Máximo de posiciones abiertas alcanzado (${openTrades.length}/${config.maxOpenPositions})`)
  if (!checks.dailyTrades) reasons.push(`Máximo de trades diarios alcanzado (${todayTrades.length}/${config.maxDailyTrades})`)
  if (!checks.lossStreak) reasons.push(`${consecutiveLosses} pérdidas consecutivas — cooldown activado`)

  return {
    allowed: allPassed,
    reason: allPassed ? 'Todas las validaciones pasaron' : reasons.join('. '),
    riskLevel,
    checks,
  }
}

/**
 * KILL SWITCH: Emergency stop that closes all positions and pauses the session.
 * Can be triggered by: human button, risk manager (auto), or AI monitor.
 * REACTIVATION always requires human approval.
 */
export async function killSwitch(
  sessionId: string,
  reason: string
): Promise<{ success: boolean; closedPositions: number }> {
  const supabase = await createClient()

  // Get session
  const { data: session } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('id', sessionId)
    .single()

  if (!session) throw new Error('Session not found')

  // Close all open positions (mark as closed — actual exchange close handled by caller)
  const { data: openTrades } = await supabase
    .from('live_trades')
    .select('id')
    .eq('session_id', sessionId)
    .eq('status', 'open')

  const closedCount = openTrades?.length ?? 0

  if (openTrades && openTrades.length > 0) {
    await supabase
      .from('live_trades')
      .update({
        status: 'closed',
        exit_time: new Date().toISOString(),
        exit_reason: `kill_switch: ${reason}`,
      })
      .eq('session_id', sessionId)
      .eq('status', 'open')
  }

  // Set session to emergency status
  await supabase
    .from('live_sessions')
    .update({
      status: 'emergency',
      paused_at: new Date().toISOString(),
      pause_reason: `KILL SWITCH: ${reason}`,
    })
    .eq('id', sessionId)

  return { success: true, closedPositions: closedCount }
}

