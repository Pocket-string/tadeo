import { createClient } from '@supabase/supabase-js'

function getServiceClient() {
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { autoRefreshToken: false, persistSession: false } }
  )
}

export interface SignalComboPerformance {
  signals: string
  avgPnlPct: number
  winRate: number
  tradeCount: number
}

export interface SignalPerformance {
  name: string
  winRate: number
  pnl: number
  trades: number
}

export interface PaperFeedback {
  bestSignalCombos: SignalComboPerformance[]
  worstSignalCombos: SignalComboPerformance[]
  toxicSignals: SignalPerformance[]
  starSignals: SignalPerformance[]
  retiredStrategies: { symbol: string; timeframe: string; reason: string }[]
  activeStrategies: { symbol: string; timeframe: string; strategyName: string }[]
  overallStats: {
    totalSessions: number
    profitableSessions: number
    avgWinRate: number
    avgDrawdown: number
  }
}

/**
 * Collect paper trading feedback to inform the discovery agent.
 * Returns what's working and what's not, so AI can avoid repeating failures.
 */
export async function collectPaperFeedback(userId: string): Promise<PaperFeedback> {
  const supabase = getServiceClient()

  // Get all paper sessions with enough data
  const { data: sessions } = await supabase
    .from('paper_sessions')
    .select('*, strategies(name, parameters, status)')
    .eq('user_id', userId)

  const allSessions = sessions ?? []
  const activeSessions = allSessions.filter(s => s.status === 'active')
  const profitableSessions = allSessions.filter(s => Number(s.net_pnl) > 0 && Number(s.total_trades) >= 5)

  // Get all closed trades grouped by strategy (include metadata for per-signal analysis)
  const { data: allTrades } = await supabase
    .from('paper_trades')
    .select('strategy_id, pnl, pnl_pct, status, metadata')
    .eq('user_id', userId)
    .eq('status', 'closed')

  const trades = allTrades ?? []

  // Group performance by strategy and extract signal combos
  const strategyPerf = new Map<string, { pnls: number[]; pnlPcts: number[] }>()
  for (const t of trades) {
    if (!strategyPerf.has(t.strategy_id)) {
      strategyPerf.set(t.strategy_id, { pnls: [], pnlPcts: [] })
    }
    const perf = strategyPerf.get(t.strategy_id)!
    perf.pnls.push(Number(t.pnl))
    perf.pnlPcts.push(Number(t.pnl_pct))
  }

  // Build signal combo performance from sessions that have signal_systems configured
  const comboPerf: SignalComboPerformance[] = []
  for (const session of allSessions) {
    const strat = session.strategies as { name: string; parameters: { signal_systems?: { id: string; enabled: boolean }[] }; status: string } | null
    if (!strat?.parameters?.signal_systems) continue
    const perf = strategyPerf.get(session.strategy_id)
    if (!perf || perf.pnls.length < 3) continue

    const enabledSignals = strat.parameters.signal_systems
      .filter(s => s.enabled)
      .map(s => s.id)
      .sort()
      .join('+')

    const wins = perf.pnls.filter(p => p > 0).length
    comboPerf.push({
      signals: enabledSignals,
      avgPnlPct: perf.pnlPcts.reduce((s, p) => s + p, 0) / perf.pnlPcts.length,
      winRate: wins / perf.pnls.length,
      tradeCount: perf.pnls.length,
    })
  }

  // Per-signal performance from trade metadata (active_systems)
  const signalPerf = new Map<string, { wins: number; losses: number; totalPnl: number }>()
  for (const t of trades) {
    const meta = t.metadata as { active_systems?: string[] } | null
    if (!meta?.active_systems) continue
    for (const sys of meta.active_systems) {
      // Extract signal name like "double-pattern:short(49%)" → "double-pattern:short"
      const signalName = sys.replace(/\(\d+%\)/, '').trim()
      if (!signalPerf.has(signalName)) signalPerf.set(signalName, { wins: 0, losses: 0, totalPnl: 0 })
      const perf = signalPerf.get(signalName)!
      const pnl = Number(t.pnl)
      perf.totalPnl += pnl
      if (pnl > 0) perf.wins++
      else perf.losses++
    }
  }

  // Identify toxic and star signals
  const toxicSignals: { name: string; winRate: number; pnl: number; trades: number }[] = []
  const starSignals: { name: string; winRate: number; pnl: number; trades: number }[] = []
  for (const [name, perf] of signalPerf) {
    const total = perf.wins + perf.losses
    if (total < 5) continue
    const wr = perf.wins / total
    if (wr < 0.35 && perf.totalPnl < 0) toxicSignals.push({ name, winRate: wr, pnl: perf.totalPnl, trades: total })
    else if (wr > 0.65 && perf.totalPnl > 0) starSignals.push({ name, winRate: wr, pnl: perf.totalPnl, trades: total })
  }
  toxicSignals.sort((a, b) => a.pnl - b.pnl) // worst first
  starSignals.sort((a, b) => b.pnl - a.pnl)  // best first

  // Sort by avg PnL
  comboPerf.sort((a, b) => b.avgPnlPct - a.avgPnlPct)

  // Failed strategies: stopped/paused sessions OR retired strategies (all provide negative feedback)
  const retired = allSessions
    .filter(s => {
      const strat = s.strategies as { status: string } | null
      return (s.status === 'stopped' || s.status === 'paused') ||
        strat?.status === 'retired'
    })
    .filter(s => Number(s.net_pnl) < 0 && Number(s.total_trades) >= 5)
    .map(s => ({
      symbol: s.symbol,
      timeframe: s.timeframe,
      reason: `Net PnL: ${Number(s.net_pnl).toFixed(2)}, WR: ${s.total_trades > 0 ? ((s.winning_trades / s.total_trades) * 100).toFixed(0) : 0}%, DD: ${(Number(s.max_drawdown) * 100).toFixed(1)}%`,
    }))

  // Active strategies
  const active = activeSessions.map(s => ({
    symbol: s.symbol,
    timeframe: s.timeframe,
    strategyName: (s.strategies as { name: string } | null)?.name ?? 'Unknown',
  }))

  // Overall stats
  const sessionsWithTrades = allSessions.filter(s => Number(s.total_trades) >= 5)
  const avgWinRate = sessionsWithTrades.length > 0
    ? sessionsWithTrades.reduce((s, sess) =>
        s + (Number(sess.total_trades) > 0 ? Number(sess.winning_trades) / Number(sess.total_trades) : 0), 0
      ) / sessionsWithTrades.length
    : 0

  return {
    bestSignalCombos: comboPerf.filter(c => c.avgPnlPct > 0).slice(0, 5),
    worstSignalCombos: comboPerf.filter(c => c.avgPnlPct <= 0).slice(-5).reverse(),
    toxicSignals: toxicSignals.slice(0, 10),
    starSignals: starSignals.slice(0, 10),
    retiredStrategies: retired,
    activeStrategies: active,
    overallStats: {
      totalSessions: allSessions.length,
      profitableSessions: profitableSessions.length,
      avgWinRate,
      avgDrawdown: 0, // TODO: compute from session equity curves
    },
  }
}

/**
 * Format feedback as a concise string for the AI hypothesis generator prompt.
 */
export function formatFeedbackForPrompt(feedback: PaperFeedback): string {
  const lines: string[] = ['PAPER TRADING FEEDBACK (what works and what does not):']

  if (feedback.bestSignalCombos.length > 0) {
    lines.push('Best signal combinations:')
    for (const c of feedback.bestSignalCombos) {
      lines.push(`  - ${c.signals}: WR ${(c.winRate * 100).toFixed(0)}%, Avg PnL ${(c.avgPnlPct * 100).toFixed(1)}% (${c.tradeCount} trades)`)
    }
  }

  if (feedback.worstSignalCombos.length > 0) {
    lines.push('Worst signal combinations (AVOID these):')
    for (const c of feedback.worstSignalCombos) {
      lines.push(`  - ${c.signals}: WR ${(c.winRate * 100).toFixed(0)}%, Avg PnL ${(c.avgPnlPct * 100).toFixed(1)}% (${c.tradeCount} trades)`)
    }
  }

  if (feedback.toxicSignals.length > 0) {
    lines.push('TOXIC individual signals (MUST AVOID or disable these):')
    for (const s of feedback.toxicSignals) {
      lines.push(`  - ${s.name}: WR ${(s.winRate * 100).toFixed(0)}%, PnL $${s.pnl.toFixed(2)} (${s.trades} trades)`)
    }
  }

  if (feedback.starSignals.length > 0) {
    lines.push('STAR individual signals (prioritize these):')
    for (const s of feedback.starSignals) {
      lines.push(`  - ${s.name}: WR ${(s.winRate * 100).toFixed(0)}%, PnL $${s.pnl.toFixed(2)} (${s.trades} trades)`)
    }
  }

  if (feedback.activeStrategies.length > 0) {
    lines.push('Currently active strategies (avoid duplication):')
    for (const s of feedback.activeStrategies) {
      lines.push(`  - ${s.symbol}/${s.timeframe}: ${s.strategyName}`)
    }
  }

  if (feedback.retiredStrategies.length > 0) {
    lines.push('Failed/stopped strategies (learn from these failures):')
    for (const s of feedback.retiredStrategies) {
      lines.push(`  - ${s.symbol}/${s.timeframe}: ${s.reason}`)
    }
  }

  if (feedback.overallStats.totalSessions > 0) {
    lines.push(`Overall: ${feedback.overallStats.profitableSessions}/${feedback.overallStats.totalSessions} profitable sessions, avg WR ${(feedback.overallStats.avgWinRate * 100).toFixed(0)}%`)
  }

  return lines.join('\n')
}
