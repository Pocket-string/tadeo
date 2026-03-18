'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import {
  startLiveSession,
  stopLiveSession,
  tickLiveSession,
  pauseLiveSession,
  resumeLiveSession,
} from '@/features/live-trading/services/liveEngine'
import { killSwitch } from '@/features/live-trading/services/riskManager'
import { generateDailyReport } from '@/features/live-trading/services/aiAdvisor'
import type { LiveSession, LiveTrade, DailyReport } from '@/features/live-trading/types'

export async function startLive(input: {
  strategyId: string
  symbol: string
  timeframe: string
  initialCapital: number
}): Promise<LiveSession> {
  return startLiveSession(input)
}

export async function stopLive(sessionId: string): Promise<void> {
  return stopLiveSession(sessionId)
}

export async function tickLive(sessionId: string) {
  return tickLiveSession(sessionId)
}

export async function pauseLive(sessionId: string, reason: string): Promise<void> {
  return pauseLiveSession(sessionId, reason)
}

export async function resumeLive(sessionId: string): Promise<void> {
  return resumeLiveSession(sessionId)
}

export async function triggerKillSwitch(sessionId: string, reason: string) {
  return killSwitch(sessionId, reason)
}

export async function getDailyReport(sessionId: string): Promise<DailyReport> {
  return generateDailyReport(sessionId)
}

export async function getLiveSessions(): Promise<LiveSession[]> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data, error } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Error: ${error.message}`)
  return (data ?? []) as LiveSession[]
}

export async function getLiveDashboard(sessionId: string): Promise<{
  session: LiveSession
  openTrades: LiveTrade[]
  closedTrades: LiveTrade[]
  currentPrice: number | null
}> {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: session } = await supabase
    .from('live_sessions')
    .select('*')
    .eq('id', sessionId)
    .eq('user_id', user.id)
    .single()

  if (!session) throw new Error('Sesión no encontrada')

  const { data: trades } = await supabase
    .from('live_trades')
    .select('*')
    .eq('session_id', sessionId)
    .order('created_at', { ascending: true })

  const allTrades = (trades ?? []) as LiveTrade[]

  let currentPrice = null
  try {
    const response = await fetch(`https://api.binance.com/api/v3/ticker/price?symbol=${session.symbol}`, {
      cache: 'no-store',
    })
    if (response.ok) {
      const data = await response.json()
      currentPrice = parseFloat(data.price)
    }
  } catch {
    // Non-blocking
  }

  return {
    session: session as LiveSession,
    openTrades: allTrades.filter(t => t.status === 'open'),
    closedTrades: allTrades.filter(t => t.status === 'closed'),
    currentPrice,
  }
}

export async function getStrategiesForLive(): Promise<{ id: string; name: string }[]> {
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
