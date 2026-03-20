'use server'

import { createClient } from '@/lib/supabase/server'
import type { PaperTrade } from '../types'

// ─── Types ──────────────────────────────────────────────────────────────────

export type StrategyGrade = 'A' | 'B' | 'C' | 'D' | 'F'

export interface StrategyMetrics {
  totalTrades: number
  winRate: number
  profitFactor: number
  sharpeRatio: number
  maxDrawdown: number
  calmarRatio: number
  consecutiveLosses: number
  avgWinLossRatio: number
  expectancy: number
  recoveryFactor: number
  netPnl: number
  netPnlPct: number
  daysActive: number
}

export interface StrategyAnalysis {
  metrics: StrategyMetrics
  grade: StrategyGrade
  shouldRetire: boolean
  retireReason: string | null
  strengths: string[]
  weaknesses: string[]
}

// ─── Analyzer ───────────────────────────────────────────────────────────────

export async function analyzeStrategy(
  strategyId: string,
  sessionId?: string
): Promise<StrategyAnalysis> {
  const supabase = await createClient()

  // Fetch closed trades
  let query = supabase
    .from('paper_trades')
    .select('*')
    .eq('strategy_id', strategyId)
    .eq('status', 'closed')
    .order('exit_time', { ascending: true })

  if (sessionId) {
    query = query.eq('session_id', sessionId)
  }

  const { data: trades } = await query
  const closedTrades = (trades ?? []) as PaperTrade[]

  // Fetch session for capital info
  let initialCapital = 10000
  if (sessionId) {
    const { data: session } = await supabase
      .from('paper_sessions')
      .select('initial_capital, started_at')
      .eq('id', sessionId)
      .single()
    if (session) initialCapital = Number(session.initial_capital)
  }

  const metrics = computeMetrics(closedTrades, initialCapital)
  const grade = gradeStrategy(metrics)
  const { shouldRetire, reason } = checkRetirement(metrics)
  const { strengths, weaknesses } = assessStrengthsWeaknesses(metrics)

  return { metrics, grade, shouldRetire, retireReason: reason, strengths, weaknesses }
}

// ─── Core Metrics ───────────────────────────────────────────────────────────

function computeMetrics(trades: PaperTrade[], initialCapital: number): StrategyMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0, winRate: 0, profitFactor: 0, sharpeRatio: 0,
      maxDrawdown: 0, calmarRatio: 0, consecutiveLosses: 0,
      avgWinLossRatio: 0, expectancy: 0, recoveryFactor: 0,
      netPnl: 0, netPnlPct: 0, daysActive: 0,
    }
  }

  const winners = trades.filter(t => Number(t.pnl) > 0)
  const losers = trades.filter(t => Number(t.pnl) <= 0)
  const winRate = winners.length / trades.length

  const grossProfit = winners.reduce((s, t) => s + Number(t.pnl), 0)
  const grossLoss = Math.abs(losers.reduce((s, t) => s + Number(t.pnl), 0))
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0

  const netPnl = trades.reduce((s, t) => s + Number(t.pnl), 0)
  const netPnlPct = netPnl / initialCapital

  // Sharpe ratio (annualized)
  const returns = trades.map(t => Number(t.pnl_pct))
  const avgReturn = returns.reduce((s, r) => s + r, 0) / returns.length
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 0
  const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0

  // Max drawdown
  let peak = initialCapital
  let maxDrawdown = 0
  let equity = initialCapital
  for (const trade of trades) {
    equity += Number(trade.pnl)
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  // Calmar ratio (annualized return / max drawdown)
  const calmarRatio = maxDrawdown > 0 ? netPnlPct / maxDrawdown : 0

  // Consecutive losses
  let maxConsecLosses = 0
  let currentStreak = 0
  for (const trade of trades) {
    if (Number(trade.pnl) <= 0) {
      currentStreak++
      if (currentStreak > maxConsecLosses) maxConsecLosses = currentStreak
    } else {
      currentStreak = 0
    }
  }

  // Avg win/loss ratio
  const avgWin = winners.length > 0 ? grossProfit / winners.length : 0
  const avgLoss = losers.length > 0 ? grossLoss / losers.length : 0
  const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0

  // Expectancy
  const lossRate = 1 - winRate
  const expectancy = (winRate * avgWin) - (lossRate * avgLoss)

  // Recovery factor
  const recoveryFactor = maxDrawdown > 0 ? netPnl / (maxDrawdown * initialCapital) : 0

  // Days active
  const firstTrade = trades[0]
  const lastTrade = trades[trades.length - 1]
  const firstDate = new Date(firstTrade.entry_time || firstTrade.created_at)
  const lastDate = new Date(lastTrade.exit_time || lastTrade.created_at)
  const daysActive = Math.max(1, Math.round((lastDate.getTime() - firstDate.getTime()) / 86_400_000))

  return {
    totalTrades: trades.length,
    winRate,
    profitFactor,
    sharpeRatio,
    maxDrawdown,
    calmarRatio,
    consecutiveLosses: maxConsecLosses,
    avgWinLossRatio,
    expectancy,
    recoveryFactor,
    netPnl,
    netPnlPct,
    daysActive,
  }
}

// ─── Grading ────────────────────────────────────────────────────────────────

export function gradeStrategy(m: StrategyMetrics): StrategyGrade {
  if (m.totalTrades < 5) return 'F'

  // A: Elite
  if (m.sharpeRatio > 1.5 && m.winRate > 0.55 && m.profitFactor > 2.0 && m.maxDrawdown < 0.10 && m.totalTrades >= 30) {
    return 'A'
  }
  // B: Strong
  if (m.sharpeRatio > 1.0 && m.winRate > 0.50 && m.profitFactor > 1.5 && m.maxDrawdown < 0.15 && m.totalTrades >= 20) {
    return 'B'
  }
  // C: Acceptable
  if (m.sharpeRatio > 0.5 && m.winRate > 0.45 && m.profitFactor > 1.2 && m.maxDrawdown < 0.20 && m.totalTrades >= 10) {
    return 'C'
  }
  // D: Underperforming but profitable
  if (m.netPnl > 0) {
    return 'D'
  }
  // F: Losing money or severe drawdown
  return 'F'
}

// ─── Retirement Check ───────────────────────────────────────────────────────

function checkRetirement(m: StrategyMetrics): { shouldRetire: boolean; reason: string | null } {
  if (m.maxDrawdown > 0.25) {
    return { shouldRetire: true, reason: `Max drawdown ${(m.maxDrawdown * 100).toFixed(1)}% exceeds 25% limit` }
  }
  if (m.consecutiveLosses >= 5) {
    return { shouldRetire: true, reason: `${m.consecutiveLosses} consecutive losses` }
  }
  if (m.totalTrades >= 15 && m.winRate < 0.35) {
    return { shouldRetire: true, reason: `Win rate ${(m.winRate * 100).toFixed(1)}% below 35% after ${m.totalTrades} trades` }
  }
  if (m.totalTrades >= 20 && m.sharpeRatio < 0) {
    return { shouldRetire: true, reason: `Negative Sharpe ratio (${m.sharpeRatio.toFixed(2)}) after ${m.totalTrades} trades` }
  }
  return { shouldRetire: false, reason: null }
}

// ─── Strengths & Weaknesses ─────────────────────────────────────────────────

function assessStrengthsWeaknesses(m: StrategyMetrics): { strengths: string[]; weaknesses: string[] } {
  const strengths: string[] = []
  const weaknesses: string[] = []

  if (m.sharpeRatio > 1.5) strengths.push('Excelente retorno ajustado por riesgo')
  else if (m.sharpeRatio < 0.5 && m.totalTrades >= 10) weaknesses.push('Bajo retorno ajustado por riesgo')

  if (m.winRate > 0.55) strengths.push('Alta tasa de acierto')
  else if (m.winRate < 0.40) weaknesses.push('Baja tasa de acierto')

  if (m.profitFactor > 2.0) strengths.push('Ganancias superan perdidas por amplio margen')
  else if (m.profitFactor < 1.0 && m.totalTrades >= 5) weaknesses.push('Las perdidas superan las ganancias')

  if (m.maxDrawdown < 0.10) strengths.push('Drawdown muy controlado')
  else if (m.maxDrawdown > 0.20) weaknesses.push('Drawdown excesivo')

  if (m.avgWinLossRatio > 2.0) strengths.push('Operaciones ganadoras mucho mayores que perdedoras')
  else if (m.avgWinLossRatio < 0.8 && m.totalTrades >= 10) weaknesses.push('Ganancias promedio menores que perdidas promedio')

  if (m.consecutiveLosses >= 4) weaknesses.push(`Racha de ${m.consecutiveLosses} perdidas consecutivas`)

  if (m.recoveryFactor > 3) strengths.push('Excelente capacidad de recuperacion')

  return { strengths, weaknesses }
}
