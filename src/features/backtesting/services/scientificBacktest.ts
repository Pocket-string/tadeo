import type { OHLCVCandle } from '@/features/market-data/types'
import type { StrategyParameters } from '@/types/database'
import type {
  ScientificBacktestOutput,
  MetricDegradation,
  MetricSemaphore,
  BacktestMetrics,
  WalkForwardResult,
  WalkForwardWindow,
} from '../types'
import { runBacktest } from './backtestEngine'

/**
 * Scientific Backtest: Split data into In-Sample (70%) and Out-of-Sample (30%).
 * Runs both independently and computes degradation metrics.
 */
export function runScientificBacktest(
  candles: OHLCVCandle[],
  params: StrategyParameters,
  initialCapital: number = 10000,
  splitRatio: number = 0.7
): ScientificBacktestOutput {
  if (candles.length < 100) {
    throw new Error(`Need at least 100 candles for scientific backtest (got ${candles.length})`)
  }

  const splitIndex = Math.floor(candles.length * splitRatio)
  const isCandles = candles.slice(0, splitIndex)
  const oosCandles = candles.slice(splitIndex)
  const splitDate = oosCandles[0].timestamp

  const inSample = runBacktest(isCandles, params, initialCapital)
  const outOfSample = runBacktest(oosCandles, params, initialCapital)
  const combined = runBacktest(candles, params, initialCapital)

  const degradation = calculateDegradation(inSample.metrics, outOfSample.metrics)
  const semaphore = calculateSemaphore(outOfSample.metrics, degradation)

  return {
    inSample,
    outOfSample,
    combined,
    splitIndex,
    splitDate,
    degradation,
    semaphore,
  }
}

/**
 * Walk-Forward Analysis: sliding windows to test strategy robustness.
 * Each window trains on N candles and tests on the next M candles.
 */
export function runWalkForward(
  candles: OHLCVCandle[],
  params: StrategyParameters,
  initialCapital: number = 10000,
  windowCount: number = 5,
  trainRatio: number = 0.7
): WalkForwardResult {
  const windowSize = Math.floor(candles.length / windowCount)
  const trainSize = Math.floor(windowSize * trainRatio)
  const testSize = windowSize - trainSize

  if (trainSize < 50 || testSize < 20) {
    throw new Error(
      `Insufficient data for ${windowCount} walk-forward windows. Need at least ${windowCount * 70} candles.`
    )
  }

  const windows: WalkForwardWindow[] = []

  for (let i = 0; i < windowCount; i++) {
    const start = i * windowSize
    const trainEnd = start + trainSize
    const testEnd = Math.min(trainEnd + testSize, candles.length)

    const trainCandles = candles.slice(start, trainEnd)
    const testCandles = candles.slice(trainEnd, testEnd)

    if (testCandles.length < 10) continue

    const trainResult = runBacktest(trainCandles, params, initialCapital)
    const testResult = runBacktest(testCandles, params, initialCapital)

    windows.push({
      windowIndex: i,
      trainStart: trainCandles[0].timestamp,
      trainEnd: trainCandles[trainCandles.length - 1].timestamp,
      testStart: testCandles[0].timestamp,
      testEnd: testCandles[testCandles.length - 1].timestamp,
      trainMetrics: trainResult.metrics,
      testMetrics: testResult.metrics,
    })
  }

  // Aggregate test metrics
  const aggregateTestMetrics = aggregateMetrics(windows.map((w) => w.testMetrics))
  const consistency = windows.filter((w) => w.testMetrics.netProfit > 0).length / windows.length

  return { windows, aggregateTestMetrics, consistency }
}

function calculateDegradation(is: BacktestMetrics, oos: BacktestMetrics): MetricDegradation {
  const degradePct = (isVal: number, oosVal: number): number => {
    if (isVal === 0) return oosVal === 0 ? 0 : -100
    return ((isVal - oosVal) / Math.abs(isVal)) * 100
  }

  const winRate = degradePct(is.winRate, oos.winRate)
  const sharpeRatio = degradePct(is.sharpeRatio, oos.sharpeRatio)
  const profitFactor = degradePct(
    is.profitFactor === Infinity ? 10 : is.profitFactor,
    oos.profitFactor === Infinity ? 10 : oos.profitFactor
  )
  const overall = (Math.abs(winRate) + Math.abs(sharpeRatio) + Math.abs(profitFactor)) / 3

  return { winRate, sharpeRatio, profitFactor, overall }
}

function calculateSemaphore(oos: BacktestMetrics, degradation: MetricDegradation): MetricSemaphore {
  const tStatistic = oos.tStatistic > 3.0 ? 'green' : oos.tStatistic > 2.0 ? 'yellow' : 'red'
  const winRate = oos.winRate > 0.55 ? 'green' : oos.winRate > 0.45 ? 'yellow' : 'red'
  const sharpeRatio = oos.sharpeRatio > 1.5 ? 'green' : oos.sharpeRatio > 1.0 ? 'yellow' : 'red'
  const maxDrawdown = oos.maxDrawdown < 0.15 ? 'green' : oos.maxDrawdown < 0.25 ? 'yellow' : 'red'
  const profitFactor = oos.profitFactor > 1.5 ? 'green' : oos.profitFactor > 1.0 ? 'yellow' : 'red'
  const deg = degradation.overall < 20 ? 'green' : degradation.overall < 40 ? 'yellow' : 'red'

  const scores = { green: 2, yellow: 1, red: 0 } as const
  const values = [tStatistic, winRate, sharpeRatio, maxDrawdown, profitFactor, deg] as const
  const totalScore = values.reduce((sum, v) => sum + scores[v], 0)
  const overall = totalScore >= 9 ? 'green' : totalScore >= 5 ? 'yellow' : 'red'

  return { tStatistic, winRate, sharpeRatio, maxDrawdown, profitFactor, degradation: deg, overall }
}

function aggregateMetrics(metricsList: BacktestMetrics[]): BacktestMetrics {
  if (metricsList.length === 0) {
    return {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
      netProfit: 0, maxDrawdown: 0, sharpeRatio: 0, tStatistic: 0, profitFactor: 0,
    }
  }

  const avg = (arr: number[]) => arr.reduce((a, b) => a + b, 0) / arr.length

  return {
    totalTrades: metricsList.reduce((s, m) => s + m.totalTrades, 0),
    winningTrades: metricsList.reduce((s, m) => s + m.winningTrades, 0),
    losingTrades: metricsList.reduce((s, m) => s + m.losingTrades, 0),
    winRate: avg(metricsList.map((m) => m.winRate)),
    netProfit: metricsList.reduce((s, m) => s + m.netProfit, 0),
    maxDrawdown: Math.max(...metricsList.map((m) => m.maxDrawdown)),
    sharpeRatio: avg(metricsList.map((m) => m.sharpeRatio)),
    tStatistic: avg(metricsList.map((m) => m.tStatistic)),
    profitFactor: avg(metricsList.map((m) => m.profitFactor === Infinity ? 10 : m.profitFactor)),
  }
}
