'use client'

import type { StrategyGrade } from '../services/strategyAnalyzer'

interface Props {
  grade: StrategyGrade | null
  winRate: number
  totalTrades: number
  netPnl: number
  showLabel?: boolean
}

const GRADE_CONFIG: Record<StrategyGrade, { color: string; bg: string; label: string; emoji: string }> = {
  A: { color: 'text-green-700', bg: 'bg-green-500', label: 'Excelente', emoji: '●' },
  B: { color: 'text-green-600', bg: 'bg-green-400', label: 'Buena', emoji: '●' },
  C: { color: 'text-amber-600', bg: 'bg-amber-400', label: 'Aceptable', emoji: '●' },
  D: { color: 'text-orange-600', bg: 'bg-orange-400', label: 'Debil', emoji: '●' },
  F: { color: 'text-red-600', bg: 'bg-red-500', label: 'Retirar', emoji: '●' },
}

/**
 * Quick grade calculation without server round-trip.
 * Mirrors the grading logic in strategyAnalyzer.ts.
 */
function quickGrade(winRate: number, totalTrades: number, netPnl: number): StrategyGrade {
  if (totalTrades < 5) return 'F'
  if (winRate > 0.55 && netPnl > 0 && totalTrades >= 30) return 'A'
  if (winRate > 0.50 && netPnl > 0 && totalTrades >= 20) return 'B'
  if (winRate > 0.45 && netPnl > 0 && totalTrades >= 10) return 'C'
  if (netPnl > 0) return 'D'
  return 'F'
}

export function StrategyHealthIndicator({ grade: externalGrade, winRate, totalTrades, netPnl, showLabel = true }: Props) {
  const grade = externalGrade ?? quickGrade(winRate, totalTrades, netPnl)
  const config = GRADE_CONFIG[grade]

  return (
    <div className="flex items-center gap-1.5" title={`Grado ${grade}: ${config.label}`}>
      <span className={`w-2.5 h-2.5 rounded-full ${config.bg} inline-block`} />
      <span className={`text-xs font-bold ${config.color}`}>{grade}</span>
      {showLabel && (
        <span className={`text-[10px] ${config.color} opacity-70`}>{config.label}</span>
      )}
    </div>
  )
}

/** Map signal system IDs to human-readable Spanish descriptions */
export function getStrategyDescription(signalSystems?: { id: string; weight: number; enabled: boolean }[]): string {
  if (!signalSystems) return 'Estrategia clasica (EMA + BB + ADX)'

  const enabled = signalSystems.filter(s => s.enabled).sort((a, b) => b.weight - a.weight)
  if (enabled.length === 0) return 'Sin sistemas activos'

  const top = enabled.slice(0, 2).map(s => s.id)

  const descriptions: Record<string, string> = {
    'ema-cross': 'cambios de tendencia',
    'bb-mean-rev': 'reversion a la media',
    'adx-trend': 'tendencias fuertes',
    'double-pattern': 'doble techo/piso',
    'rsi-divergence': 'divergencias RSI',
    'volume-confirm': 'confirmacion por volumen',
    'engulfing-sr': 'patrones en soportes/resistencias',
  }

  const parts = top.map(id => descriptions[id] ?? id)
  return `Detecta ${parts.join(' y ')}`
}

/** Tooltips for KPI metrics */
export const METRIC_TOOLTIPS: Record<string, string> = {
  winRate: 'De cada 10 operaciones, cuantas ganan dinero. > 50% es bueno.',
  profitFactor: 'Por cada $1 perdido, cuanto se gana. > 1.5 es bueno, > 2 es excelente.',
  maxDrawdown: 'La peor racha de perdidas desde el pico. < 15% es saludable.',
  sharpe: 'Retorno ajustado por riesgo. > 1 es bueno, > 2 es excelente.',
  consecutiveLosses: 'Mayor racha de perdidas seguidas. < 3 es normal.',
  grade: 'Calificacion general: A (excelente) a F (retirar).',
}
