'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { startPaperSession, stopPaperSession, tickPaperSession } from '@/features/paper-trading/services/paperEngine'
import { monitorSession } from '@/features/paper-trading/services/aiMonitor'
import { getLivePrice } from '@/features/paper-trading/services/priceService'
import type { PaperSession, PaperTrade, PaperDashboardData } from '@/features/paper-trading/types'
import type { MonitorReport } from '@/features/paper-trading/services/aiMonitor'

export async function startSession(input: {
  strategyId: string
  symbol: string
  timeframe: string
  initialCapital?: number
}): Promise<PaperSession> {
  return startPaperSession(input)
}

export async function stopSession(sessionId: string): Promise<void> {
  return stopPaperSession(sessionId)
}

export async function tickSession(sessionId: string) {
  return tickPaperSession(sessionId)
}

export async function monitorPaperSession(sessionId: string): Promise<MonitorReport> {
  return monitorSession(sessionId)
}

export async function getPaperSessions(): Promise<PaperSession[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data, error } = await supabase
    .from('paper_sessions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to fetch sessions: ${error.message}`)
  return (data ?? []) as PaperSession[]
}

export async function getPaperDashboard(sessionId: string): Promise<PaperDashboardData> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: session } = await supabase
    .from('paper_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .single()

  if (!session) throw new Error('Session not found')

  const { data: trades } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('strategy_id', session.strategy_id)
    .eq('user_id', user.id)
    .order('created_at', { ascending: true })

  const allTrades = (trades ?? []) as PaperTrade[]
  const openTrades = allTrades.filter(t => t.status === 'open')
  const closedTrades = allTrades.filter(t => t.status === 'closed')

  let currentPrice = null
  try {
    currentPrice = await getLivePrice(session.symbol)
  } catch {
    // Price fetch is non-blocking
  }

  // Build P&L history from closed trades
  let equity = Number(session.initial_capital)
  const pnlHistory = closedTrades.map(t => {
    equity += Number(t.pnl)
    return { timestamp: t.exit_time ?? t.created_at, pnl: equity - Number(session.initial_capital) }
  })

  return {
    session: session as PaperSession,
    openTrades,
    closedTrades,
    currentPrice,
    pnlHistory,
  }
}

export async function getStrategiesForPaper(): Promise<{ id: string; name: string; symbol?: string }[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data } = await supabase
    .from('strategies')
    .select('id, name')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  return (data ?? []) as { id: string; name: string }[]
}
