import type { StrategyParameters } from '@/types/database'
import type { SignalSystemConfig } from '@/features/paper-trading/services/signalRegistry'
import { PARAM_RANGES } from '@/features/paper-trading/services/paramRanges'
import type { MutationResult, MutationCategory } from '../types'

// ─── Karpathy Single Mutator ────────────────────────────────────────────────
// ONE change per iteration. Isolation of variables = you know what helped.

const SIGNAL_IDS = [
  'ema-cross', 'bb-mean-rev', 'adx-trend', 'double-pattern',
  'rsi-divergence', 'volume-confirm', 'engulfing-sr',
] as const

/** Category selection probabilities (must sum to 1.0) */
const CATEGORY_WEIGHTS: { category: MutationCategory; weight: number }[] = [
  { category: 'weight', weight: 0.40 },
  { category: 'sl_tp', weight: 0.20 },
  { category: 'indicator', weight: 0.20 },
  { category: 'toggle', weight: 0.10 },
  { category: 'threshold', weight: 0.05 },
  { category: 'trailing', weight: 0.05 },
]

const CONFIDENCE_THRESHOLDS = [0.30, 0.35, 0.40, 0.45, 0.50, 0.55, 0.60]
const TRAILING_PERIODS = [10, 15, 20, 25, 30]

/**
 * Mutate EXACTLY one parameter. Returns mutated params + human-readable hypothesis.
 */
export function mutateSingle(
  baseParams: StrategyParameters,
): MutationResult {
  const category = pickCategory()
  const params = { ...baseParams }

  // Deep clone signal_systems
  if (params.signal_systems) {
    params.signal_systems = params.signal_systems.map(s => ({ ...s }))
  }

  switch (category) {
    case 'weight':
      return mutateWeight(params)
    case 'sl_tp':
      return mutateSlTp(params)
    case 'indicator':
      return mutateIndicator(params)
    case 'toggle':
      return mutateToggle(params)
    case 'threshold':
      return mutateThreshold(params)
    case 'trailing':
      return mutateTrailing(params)
  }
}

// ─── Category Pickers ───────────────────────────────────────────────────────

function pickCategory(): MutationCategory {
  const rand = Math.random()
  let cumulative = 0
  for (const { category, weight } of CATEGORY_WEIGHTS) {
    cumulative += weight
    if (rand < cumulative) return category
  }
  return 'weight' // fallback
}

function pickRandom<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

function clamp(val: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, val))
}

function roundTo(val: number, decimals: number): number {
  const f = 10 ** decimals
  return Math.round(val * f) / f
}

// ─── Mutators ───────────────────────────────────────────────────────────────

function mutateWeight(params: StrategyParameters): MutationResult {
  const systems = params.signal_systems
  if (!systems || systems.length === 0) {
    // Fallback: mutate SL/TP instead
    return mutateSlTp(params)
  }

  const idx = Math.floor(Math.random() * systems.length)
  const signal = systems[idx]
  const oldWeight = signal.weight
  const delta = pickRandom([-0.3, -0.2, -0.1, 0.1, 0.2, 0.3])
  signal.weight = roundTo(clamp(oldWeight + delta, 0.0, 2.0), 1)

  return {
    params,
    hypothesis: `Adjust ${signal.id} weight ${oldWeight}→${signal.weight}`,
    category: 'weight',
    paramKey: `signal.${signal.id}.weight`,
    oldValue: oldWeight,
    newValue: signal.weight,
  }
}

function mutateSlTp(params: StrategyParameters): MutationResult {
  const isStop = Math.random() < 0.5
  const key = isStop ? 'stop_loss_pct' : 'take_profit_pct'
  const range = PARAM_RANGES[key]
  const oldVal = params[key]

  // Find closest index and move ±1 step
  const closestIdx = findClosestIndex(range, oldVal)
  const direction = Math.random() < 0.5 ? -1 : 1
  const newIdx = clamp(closestIdx + direction, 0, range.length - 1)
  params[key] = range[newIdx]

  const label = isStop ? 'stop_loss' : 'take_profit'
  return {
    params,
    hypothesis: `Adjust ${label} ATR mult ${oldVal}→${params[key]}`,
    category: 'sl_tp',
    paramKey: key,
    oldValue: oldVal,
    newValue: params[key],
  }
}

function mutateIndicator(params: StrategyParameters): MutationResult {
  const indicatorKeys = [
    'ema_fast', 'ema_slow', 'rsi_period', 'rsi_oversold', 'rsi_overbought',
    'macd_fast', 'macd_slow', 'macd_signal', 'bb_period', 'bb_std_dev',
  ] as const
  const key = pickRandom(indicatorKeys)
  const range = PARAM_RANGES[key]
  const oldVal = params[key]

  const closestIdx = findClosestIndex(range, oldVal)
  const direction = Math.random() < 0.5 ? -1 : 1
  const newIdx = clamp(closestIdx + direction, 0, range.length - 1)
  params[key] = range[newIdx]

  // Enforce constraints
  if (params.ema_fast >= params.ema_slow) {
    params.ema_slow = params.ema_fast + 10
  }
  if (params.macd_fast >= params.macd_slow) {
    params.macd_slow = params.macd_fast + 10
  }

  return {
    params,
    hypothesis: `Adjust ${key} ${oldVal}→${params[key]}`,
    category: 'indicator',
    paramKey: key,
    oldValue: oldVal,
    newValue: params[key],
  }
}

function mutateToggle(params: StrategyParameters): MutationResult {
  const systems = params.signal_systems
  if (!systems || systems.length === 0) {
    return mutateSlTp(params)
  }

  const idx = Math.floor(Math.random() * systems.length)
  const signal = systems[idx]
  const oldEnabled = signal.enabled
  signal.enabled = !oldEnabled

  return {
    params,
    hypothesis: `Toggle ${signal.id} ${oldEnabled ? 'ON→OFF' : 'OFF→ON'}`,
    category: 'toggle',
    paramKey: `signal.${signal.id}.enabled`,
    oldValue: oldEnabled,
    newValue: signal.enabled,
  }
}

function mutateThreshold(params: StrategyParameters): MutationResult {
  // The composite confidence threshold is embedded in the signal evaluation
  // We simulate it by adjusting all weights proportionally (tighter/looser filter)
  const systems = params.signal_systems
  if (!systems || systems.length === 0) {
    return mutateSlTp(params)
  }

  // Scale all enabled weights up or down by 10%
  const direction = Math.random() < 0.5 ? 0.9 : 1.1
  const label = direction < 1 ? 'loosen' : 'tighten'
  for (const s of systems) {
    if (s.enabled) {
      s.weight = roundTo(clamp(s.weight * direction, 0.1, 2.0), 1)
    }
  }

  return {
    params,
    hypothesis: `${label} all signal weights by 10% (effective threshold shift)`,
    category: 'threshold',
    paramKey: 'all_weights_scale',
    oldValue: '1.0',
    newValue: String(roundTo(direction, 2)),
  }
}

function mutateTrailing(params: StrategyParameters): MutationResult {
  const coin = Math.random()

  if (coin < 0.5) {
    // Toggle trailing mode
    const oldMode = params.trailing_stop_mode ?? 'atr'
    const newMode = oldMode === 'atr' ? 'ema' : 'atr'
    params.trailing_stop_mode = newMode
    return {
      params,
      hypothesis: `Switch trailing stop mode ${oldMode}→${newMode}`,
      category: 'trailing',
      paramKey: 'trailing_stop_mode',
      oldValue: oldMode,
      newValue: newMode,
    }
  } else {
    // Adjust trailing EMA period
    const oldPeriod = params.trailing_ema_period ?? 20
    const closestIdx = findClosestIndex(TRAILING_PERIODS, oldPeriod)
    const direction = Math.random() < 0.5 ? -1 : 1
    const newIdx = clamp(closestIdx + direction, 0, TRAILING_PERIODS.length - 1)
    params.trailing_ema_period = TRAILING_PERIODS[newIdx]
    return {
      params,
      hypothesis: `Adjust trailing EMA period ${oldPeriod}→${params.trailing_ema_period}`,
      category: 'trailing',
      paramKey: 'trailing_ema_period',
      oldValue: oldPeriod,
      newValue: params.trailing_ema_period,
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function findClosestIndex(arr: readonly number[], target: number): number {
  let bestIdx = 0
  let bestDist = Math.abs(arr[0] - target)
  for (let i = 1; i < arr.length; i++) {
    const dist = Math.abs(arr[i] - target)
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = i
    }
  }
  return bestIdx
}
