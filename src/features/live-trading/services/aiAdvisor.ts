'use server'

import { generateText } from 'ai'
import type { LanguageModel } from 'ai'
import { createOpenAI } from '@ai-sdk/openai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import { createClient } from '@/lib/supabase/server'
import type { LiveSession, LiveTrade, DailyReport } from '../types'

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
 * Generate daily performance report with AI analysis.
 * HUMAN GATE: AI advises but human decides on any changes.
 */
export async function generateDailyReport(sessionId: string): Promise<DailyReport> {
  const supabase = await createClient()

  const { data: session } = await supabase
    .from('live_sessions')
    .select('*, strategies(name, parameters)')
    .eq('id', sessionId)
    .single()

  if (!session) throw new Error('Sesión no encontrada')

  // Get today's trades
  const today = new Date().toISOString().split('T')[0]
  const { data: todayTrades } = await supabase
    .from('live_trades')
    .select('*')
    .eq('session_id', sessionId)
    .eq('status', 'closed')
    .gte('entry_time', `${today}T00:00:00`)
    .order('entry_time', { ascending: true })

  const trades = (todayTrades ?? []) as LiveTrade[]

  // Get all closed trades for overall stats
  const { data: allTrades } = await supabase
    .from('live_trades')
    .select('pnl')
    .eq('session_id', sessionId)
    .eq('status', 'closed')

  const allClosed = (allTrades ?? []) as { pnl: number }[]

  // Calculate metrics
  const todayPnl = trades.reduce((s, t) => s + Number(t.pnl), 0)
  const todayWinning = trades.filter(t => Number(t.pnl) > 0).length
  const todayWinRate = trades.length > 0 ? todayWinning / trades.length : 0

  // Simple Sharpe estimate from all trades
  const pnls = allClosed.map(t => Number(t.pnl))
  const avgPnl = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0
  const stdPnl = pnls.length > 1
    ? Math.sqrt(pnls.reduce((s, p) => s + (p - avgPnl) ** 2, 0) / (pnls.length - 1))
    : 0
  const sharpeEstimate = stdPnl > 0 ? (avgPnl / stdPnl) * Math.sqrt(252) : 0

  // Paper comparison (if paper session exists for same strategy)
  let paperComparison = null
  const { data: paperSession } = await supabase
    .from('paper_sessions')
    .select('net_pnl')
    .eq('strategy_id', session.strategy_id)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (paperSession) {
    const paperPnl = Number(paperSession.net_pnl)
    const livePnl = Number(session.net_pnl)
    paperComparison = {
      paperPnl,
      livePnl,
      divergencePct: paperPnl !== 0 ? ((livePnl - paperPnl) / Math.abs(paperPnl)) * 100 : 0,
    }
  }

  const metrics = {
    tradesExecuted: trades.length,
    winRate: todayWinRate,
    netPnl: todayPnl,
    maxDrawdown: Number(session.max_drawdown_pct ?? 0),
    sharpeEstimate,
  }

  // AI Analysis
  const model = getModelInstance()
  const prompt = `Eres un asesor de trading cuantitativo. Analiza este reporte diario de una sesión de trading live y genera recomendaciones.

SESIÓN: ${session.symbol} (${session.timeframe})
Estrategia: ${(session.strategies as { name: string }).name}
Capital: $${Number(session.initial_capital).toFixed(0)} → $${Number(session.current_capital).toFixed(0)}

HOY (${today}):
- Trades ejecutados: ${trades.length}
- Win Rate: ${(todayWinRate * 100).toFixed(1)}%
- PnL del día: $${todayPnl.toFixed(2)}

ACUMULADO:
- Total trades: ${session.total_trades}
- PnL neto: $${Number(session.net_pnl).toFixed(2)}
- Max Drawdown: ${(Number(session.max_drawdown_pct ?? 0) * 100).toFixed(1)}%
- Sharpe estimado: ${sharpeEstimate.toFixed(2)}

${paperComparison ? `COMPARACIÓN CON PAPER:
- Paper PnL: $${paperComparison.paperPnl.toFixed(2)}
- Live PnL: $${paperComparison.livePnl.toFixed(2)}
- Divergencia: ${paperComparison.divergencePct.toFixed(1)}%` : 'Sin datos de paper trading para comparar.'}

Responde en español con:
1. Evaluación breve del rendimiento (2-3 oraciones)
2. Si hay alguna señal de alarma
3. Recomendación: "continue", "adjust", "pause", o "stop"
4. Acción específica si recomiendas ajustar

Sé directo y conciso. Las pérdidas de trading son reales.`

  let aiAnalysis = ''
  let recommendation: DailyReport['recommendation'] = 'continue'

  try {
    const { text } = await generateText({ model, prompt, temperature: 0.3 })
    aiAnalysis = text.trim()

    // Extract recommendation from text
    const lower = aiAnalysis.toLowerCase()
    if (lower.includes('"stop"') || lower.includes('recomendación: stop')) recommendation = 'stop'
    else if (lower.includes('"pause"') || lower.includes('recomendación: pause')) recommendation = 'pause'
    else if (lower.includes('"adjust"') || lower.includes('recomendación: adjust')) recommendation = 'adjust'
  } catch {
    aiAnalysis = 'No se pudo generar análisis AI.'
  }

  return {
    date: today,
    sessionId,
    metrics,
    paperComparison,
    aiAnalysis,
    recommendation,
  }
}
