// Human-readable labels for trade exit reasons and other formatting utilities

export const EXIT_REASON_LABELS: Record<string, { label: string; emoji: string }> = {
  take_profit: { label: 'Take Profit', emoji: '✅' },
  stop_loss: { label: 'Stop Loss', emoji: '🛑' },
  trailing_stop: { label: 'Trailing Stop', emoji: '📈' },
  htf_trend_filter_blocked: { label: 'Filtro HTF', emoji: '⛔' },
  atr_filter: { label: 'Filtro ATR', emoji: '📊' },
  auto_retired: { label: 'Auto-retirado', emoji: '🤖' },
  session_stopped: { label: 'Sesión detenida', emoji: '⏹' },
  manual: { label: 'Manual', emoji: '👤' },
  regime_filter: { label: 'Filtro de régimen', emoji: '🔇' },
}

export function formatExitReason(reason: string | null): string {
  if (!reason) return '—'
  const entry = EXIT_REASON_LABELS[reason]
  if (entry) return `${entry.emoji} ${entry.label}`
  // Fallback: capitalize and replace underscores
  return reason.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

export function formatAgentEventType(eventType: string): { label: string; color: string } {
  const map: Record<string, { label: string; color: string }> = {
    buy: { label: 'BUY abierto', color: 'text-green-600' },
    sell: { label: 'SELL abierto', color: 'text-red-500' },
    close: { label: 'Trade cerrado', color: 'text-blue-600' },
    trail: { label: 'Trailing SL', color: 'text-amber-600' },
    hold: { label: 'En espera', color: 'text-neutral-400' },
    no_signal: { label: 'Sin señal', color: 'text-neutral-400' },
    error: { label: 'Error', color: 'text-red-400' },
  }
  return map[eventType] ?? { label: eventType, color: 'text-neutral-500' }
}

export function formatDuration(startIso: string, endIso: string | null): string {
  if (!endIso) return '—'
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime()
  if (ms < 0) return '—'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}

export function gradeColor(grade: string | null): string {
  if (!grade || grade === '—') return 'text-neutral-400 bg-neutral-100'
  const colors: Record<string, string> = {
    A: 'text-green-700 bg-green-100',
    B: 'text-lime-700 bg-lime-100',
    C: 'text-yellow-700 bg-yellow-100',
    D: 'text-orange-700 bg-orange-100',
    F: 'text-red-700 bg-red-100',
  }
  return colors[grade] ?? 'text-neutral-400 bg-neutral-100'
}

export function drawdownColor(ddFraction: number): string {
  if (ddFraction < 0.1) return 'text-green-600'
  if (ddFraction < 0.2) return 'text-yellow-600'
  return 'text-red-600'
}
