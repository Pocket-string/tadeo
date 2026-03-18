'use server'

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createClient } from '@/lib/supabase/server'
import type { PaperSession, PaperTrade } from '../types'
import { z } from 'zod'

export interface DivergenceAlert {
  severity: 'info' | 'warning' | 'critical'
  type: 'drawdown' | 'win_rate' | 'frequency' | 'pnl_drift' | 'general'
  message: string
  recommendation: string
  shouldPause: boolean
}

export interface MonitorReport {
  sessionId: string
  timestamp: string
  alerts: DivergenceAlert[]
  paperMetrics: {
    winRate: number
    avgPnl: number
    totalTrades: number
    maxDrawdown: number
    currentDrawdown: number
  }
  backtestMetrics: {
    winRate: number
    avgPnl: number
    totalTrades: number
    maxDrawdown: number
  } | null
  aiAnalysis: string | null
}

const AlertSchema = z.object({
  alerts: z.array(z.object({
    severity: z.enum(['info', 'warning', 'critical']),
    type: z.enum(['drawdown', 'win_rate', 'frequency', 'pnl_drift', 'general']),
    message: z.string(),
    recommendation: z.string(),
    shouldPause: z.boolean(),
  })),
  summary: z.string(),
})

function getModelInstance(): LanguageModel {
  const modelId = process.env.AI_MODEL || 'gemini-2.5-flash'

  if (process.env.GOOGLE_GENERATIVE_AI_API_KEY) {
    const google = createGoogleGenerativeAI({ apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY })
    return google(modelId)
  }
  if (process.env.OPENROUTER_API_KEY) {
    const openrouter = createOpenAI({ apiKey: process.env.OPENROUTER_API_KEY, baseURL: 'https://openrouter.ai/api/v1' })
    return openrouter(process.env.AI_MODEL || 'google/gemini-2.5-flash')
  }
  if (process.env.OPENAI_API_KEY) {
    const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY })
    return openai(process.env.AI_MODEL || 'gpt-4o-mini')
  }
  throw new Error('No AI API key configured.')
}

/**
 * Monitor a paper trading session for divergence from backtest expectations.
 * HUMAN GATE: AI can recommend pausing but cannot stop the session itself.
 */
export async function monitorSession(sessionId: string): Promise<MonitorReport> {
  const supabase = await createClient()

  // Get session + strategy backtest results
  const { data: session } = await supabase
    .from('paper_sessions')
    .select('*, strategies(name, parameters)')
    .eq('id', sessionId)
    .single()

  if (!session) throw new Error('Session not found')

  // Get paper trades for this session's strategy
  const { data: paperTrades } = await supabase
    .from('paper_trades')
    .select('*')
    .eq('strategy_id', session.strategy_id)
    .eq('user_id', session.user_id)
    .order('created_at', { ascending: true })

  const trades = (paperTrades ?? []) as PaperTrade[]
  const closedTrades = trades.filter(t => t.status === 'closed')

  // Get latest backtest for comparison
  const { data: backtest } = await supabase
    .from('backtest_results')
    .select('*')
    .eq('strategy_id', session.strategy_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  // Calculate paper metrics
  const paperMetrics = calculatePaperMetrics(closedTrades, session as PaperSession)

  const backtestMetrics = backtest ? {
    winRate: Number(backtest.win_rate),
    avgPnl: backtest.total_trades > 0 ? Number(backtest.net_profit) / Number(backtest.total_trades) : 0,
    totalTrades: Number(backtest.total_trades),
    maxDrawdown: Number(backtest.max_drawdown),
  } : null

  // Rule-based alerts (always run)
  const alerts: DivergenceAlert[] = []

  // Check drawdown
  if (paperMetrics.currentDrawdown > 0.20) {
    alerts.push({
      severity: 'critical',
      type: 'drawdown',
      message: `Drawdown actual: ${(paperMetrics.currentDrawdown * 100).toFixed(1)}% — supera el 20%`,
      recommendation: 'Pausar la sesión y revisar condiciones de mercado.',
      shouldPause: true,
    })
  } else if (paperMetrics.currentDrawdown > 0.10) {
    alerts.push({
      severity: 'warning',
      type: 'drawdown',
      message: `Drawdown actual: ${(paperMetrics.currentDrawdown * 100).toFixed(1)}% — acercándose al límite`,
      recommendation: 'Monitorear de cerca. Considerar reducir tamaño de posición.',
      shouldPause: false,
    })
  }

  // Compare with backtest if available
  if (backtestMetrics && closedTrades.length >= 5) {
    const winRateDiff = Math.abs(paperMetrics.winRate - backtestMetrics.winRate)
    if (winRateDiff > 0.15) {
      alerts.push({
        severity: winRateDiff > 0.25 ? 'critical' : 'warning',
        type: 'win_rate',
        message: `Win rate diverge del backtest: Paper ${(paperMetrics.winRate * 100).toFixed(1)}% vs Backtest ${(backtestMetrics.winRate * 100).toFixed(1)}%`,
        recommendation: 'Las condiciones de mercado pueden haber cambiado. Revisar parámetros.',
        shouldPause: winRateDiff > 0.25,
      })
    }

    if (backtestMetrics.maxDrawdown > 0 && paperMetrics.maxDrawdown > backtestMetrics.maxDrawdown * 1.5) {
      alerts.push({
        severity: 'critical',
        type: 'drawdown',
        message: `Max drawdown paper (${(paperMetrics.maxDrawdown * 100).toFixed(1)}%) supera 1.5x backtest (${(backtestMetrics.maxDrawdown * 100).toFixed(1)}%)`,
        recommendation: 'Divergencia significativa. Recomendar pausar y re-evaluar.',
        shouldPause: true,
      })
    }
  }

  // AI analysis for deeper insight (non-blocking)
  let aiAnalysis: string | null = null
  if (closedTrades.length >= 3) {
    try {
      aiAnalysis = await getAIMonitorAnalysis(paperMetrics, backtestMetrics, session as PaperSession, closedTrades.length)
    } catch {
      // AI analysis is non-blocking
    }
  }

  return {
    sessionId,
    timestamp: new Date().toISOString(),
    alerts,
    paperMetrics,
    backtestMetrics,
    aiAnalysis,
  }
}

function calculatePaperMetrics(
  closedTrades: PaperTrade[],
  session: PaperSession
): MonitorReport['paperMetrics'] {
  if (closedTrades.length === 0) {
    return { winRate: 0, avgPnl: 0, totalTrades: 0, maxDrawdown: 0, currentDrawdown: 0 }
  }

  const winning = closedTrades.filter(t => Number(t.pnl) > 0).length
  const totalPnl = closedTrades.reduce((s, t) => s + Number(t.pnl), 0)

  // Calculate drawdown from equity curve
  let peak = Number(session.initial_capital)
  let maxDrawdown = 0
  let equity = peak

  for (const trade of closedTrades) {
    equity += Number(trade.pnl)
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  const currentDrawdown = peak > 0 ? (peak - equity) / peak : 0

  return {
    winRate: winning / closedTrades.length,
    avgPnl: totalPnl / closedTrades.length,
    totalTrades: closedTrades.length,
    maxDrawdown,
    currentDrawdown,
  }
}

async function getAIMonitorAnalysis(
  paperMetrics: MonitorReport['paperMetrics'],
  backtestMetrics: MonitorReport['backtestMetrics'],
  session: PaperSession,
  tradeCount: number
): Promise<string> {
  const model = getModelInstance()

  const prompt = `You are a trading risk monitor. Analyze this paper trading session and provide a brief assessment.

SESSION: ${session.symbol} (${session.timeframe})
Capital: $${Number(session.initial_capital).toFixed(0)} → $${Number(session.current_capital).toFixed(0)}

PAPER TRADING METRICS (${tradeCount} closed trades):
- Win Rate: ${(paperMetrics.winRate * 100).toFixed(1)}%
- Avg PnL/trade: $${paperMetrics.avgPnl.toFixed(2)}
- Max Drawdown: ${(paperMetrics.maxDrawdown * 100).toFixed(1)}%
- Current Drawdown: ${(paperMetrics.currentDrawdown * 100).toFixed(1)}%

${backtestMetrics ? `BACKTEST REFERENCE (${backtestMetrics.totalTrades} trades):
- Win Rate: ${(backtestMetrics.winRate * 100).toFixed(1)}%
- Avg PnL/trade: $${backtestMetrics.avgPnl.toFixed(2)}
- Max Drawdown: ${(backtestMetrics.maxDrawdown * 100).toFixed(1)}%` : 'No backtest reference available.'}

Provide a 2-3 sentence assessment. Focus on: Is the strategy performing as expected? Any red flags? Should the trader continue, adjust, or pause?
Respond in Spanish.`

  const { text } = await generateText({
    model,
    prompt,
    temperature: 0.3,
  })

  return text.trim()
}
