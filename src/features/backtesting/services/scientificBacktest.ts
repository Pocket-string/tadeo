import type { OHLCVCandle } from '@/features/market-data/types'
import type { StrategyParameters } from '@/types/database'
import type {
  ScientificBacktestOutput,
  MetricDegradation,
  MetricSemaphore,
  BacktestMetrics,
  BacktestTradeResult,
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
  const splitDate = candles[splitIndex].timestamp

  // OOS warmup: include indicator warmup candles before the OOS period
  // so indicators are fully initialized when OOS begins
  const oosWarmup = Math.max(60, (params.ema_slow ?? 26) + 10)
  const oosWarmupStart = Math.max(0, splitIndex - oosWarmup)
  const oosWithWarmup = candles.slice(oosWarmupStart)
  const pureOosCandles = candles.slice(splitIndex)

  const inSample = runBacktest(isCandles, params, initialCapital)
  const oosFullResult = runBacktest(oosWithWarmup, params, initialCapital)

  // Filter OOS trades to only count those within the actual OOS period
  const oosTrades = oosFullResult.trades.filter(t => t.entryTime >= splitDate)
  const oosMetrics = computeMetricsFromTrades(oosTrades, initialCapital)
  const oosEquity = oosFullResult.equityCurve.filter(p => p.timestamp >= splitDate)
  const outOfSample = { metrics: oosMetrics, trades: oosTrades, equityCurve: oosEquity }
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

  // Warmup: indicators need ~60 candles to fully initialize (EMA slow up to 50 + ADX 2×14+1)
  // Include warmup candles before each test window so indicators produce valid signals
  const warmupSize = Math.max(
    60,
    (params.ema_slow ?? 26) + 10,
    ((params.rsi_period ?? 14) * 2) + 10
  )

  for (let i = 0; i < windowCount; i++) {
    const start = i * windowSize
    const trainEnd = start + trainSize
    const testEnd = Math.min(trainEnd + testSize, candles.length)

    const trainCandles = candles.slice(start, trainEnd)

    // Include warmup candles from training set before test window
    // so indicators are fully initialized when test period begins
    const warmupStart = Math.max(0, trainEnd - warmupSize)
    const testWithWarmup = candles.slice(warmupStart, testEnd)
    const pureTestCandles = candles.slice(trainEnd, testEnd)

    if (pureTestCandles.length < 10) continue

    const trainResult = runBacktest(trainCandles, params, initialCapital)
    const testFullResult = runBacktest(testWithWarmup, params, initialCapital)

    // Filter test metrics to only count trades within the actual test period
    const testStartTimestamp = pureTestCandles[0].timestamp
    const testTrades = testFullResult.trades.filter(t => t.entryTime >= testStartTimestamp)
    const testMetrics = computeMetricsFromTrades(testTrades, initialCapital)

    windows.push({
      windowIndex: i,
      trainStart: trainCandles[0].timestamp,
      trainEnd: trainCandles[trainCandles.length - 1].timestamp,
      testStart: pureTestCandles[0].timestamp,
      testEnd: pureTestCandles[pureTestCandles.length - 1].timestamp,
      trainMetrics: trainResult.metrics,
      testMetrics,
    })
  }

  // Aggregate test metrics
  const aggregateTestMetrics = aggregateMetrics(windows.map((w) => w.testMetrics))
  const consistency = windows.filter((w) => w.testMetrics.netProfit > 0).length / windows.length

  return { windows, aggregateTestMetrics, consistency }
}

function computeMetricsFromTrades(trades: BacktestTradeResult[], initialCapital: number): BacktestMetrics {
  if (trades.length === 0) {
    return {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
      netProfit: 0, maxDrawdown: 0, sharpeRatio: 0, sortinoRatio: 0, tStatistic: 0, profitFactor: 0,
    }
  }

  const winningTrades = trades.filter(t => t.pnl > 0)
  const losingTrades = trades.filter(t => t.pnl <= 0)
  const totalPnl = trades.reduce((sum, t) => sum + t.pnl, 0)
  const grossProfit = winningTrades.reduce((sum, t) => sum + t.pnl, 0)
  const grossLoss = Math.abs(losingTrades.reduce((sum, t) => sum + t.pnl, 0))

  // Max drawdown from trade PnL series
  let equity = initialCapital
  let peak = initialCapital
  let maxDrawdown = 0
  for (const t of trades) {
    equity += t.pnl
    if (equity > peak) peak = equity
    const dd = (peak - equity) / peak
    if (dd > maxDrawdown) maxDrawdown = dd
  }

  const returns = trades.map(t => t.pnlPct)
  const avgReturn = returns.reduce((a, b) => a + b, 0) / returns.length
  const stdReturn = Math.sqrt(
    returns.reduce((sum, r) => sum + Math.pow(r - avgReturn, 2), 0) / returns.length
  )
  const sharpeRatio = stdReturn === 0 ? 0 : (avgReturn / stdReturn) * Math.sqrt(252)
  const downsideDev = Math.sqrt(
    returns.reduce((s, r) => s + Math.min(0, r) ** 2, 0) / returns.length
  )
  const sortinoRatio = downsideDev > 0 ? (avgReturn / downsideDev) * Math.sqrt(252) : 0
  const tStatistic = stdReturn === 0 ? 0 : (avgReturn / (stdReturn / Math.sqrt(trades.length)))

  return {
    totalTrades: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    winRate: winningTrades.length / trades.length,
    netProfit: totalPnl,
    maxDrawdown,
    sharpeRatio,
    sortinoRatio,
    tStatistic,
    profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Infinity : 0) : grossProfit / grossLoss,
  }
}

function calculateDegradation(is: BacktestMetrics, oos: BacktestMetrics): MetricDegradation {
  const degradePct = (isVal: number, oosVal: number): number => {
    if (isVal === 0) return oosVal === 0 ? 0 : -100
    return ((isVal - oosVal) / Math.abs(isVal)) * 100
  }

  const winRate = degradePct(is.winRate, oos.winRate)
  const sharpeRatio = degradePct(is.sharpeRatio, oos.sharpeRatio)
  const sortinoRatio = degradePct(is.sortinoRatio, oos.sortinoRatio)
  const profitFactor = degradePct(
    is.profitFactor === Infinity ? 10 : is.profitFactor,
    oos.profitFactor === Infinity ? 10 : oos.profitFactor
  )
  const overall = (Math.abs(winRate) + Math.abs(sharpeRatio) + Math.abs(sortinoRatio) + Math.abs(profitFactor)) / 4

  return { winRate, sharpeRatio, sortinoRatio, profitFactor, overall }
}

function calculateSemaphore(oos: BacktestMetrics, degradation: MetricDegradation): MetricSemaphore {
  const tStatistic = oos.tStatistic > 3.0 ? 'green' : oos.tStatistic > 2.0 ? 'yellow' : 'red'
  const winRate = oos.winRate > 0.55 ? 'green' : oos.winRate > 0.45 ? 'yellow' : 'red'
  const sharpeRatio = oos.sharpeRatio > 1.5 ? 'green' : oos.sharpeRatio > 1.0 ? 'yellow' : 'red'
  const sortinoRatio = oos.sortinoRatio > 2.0 ? 'green' : oos.sortinoRatio > 1.0 ? 'yellow' : 'red'
  const maxDrawdown = oos.maxDrawdown < 0.15 ? 'green' : oos.maxDrawdown < 0.25 ? 'yellow' : 'red'
  const profitFactor = oos.profitFactor > 1.5 ? 'green' : oos.profitFactor > 1.0 ? 'yellow' : 'red'
  const deg = degradation.overall < 20 ? 'green' : degradation.overall < 40 ? 'yellow' : 'red'

  const scores = { green: 2, yellow: 1, red: 0 } as const
  const values = [tStatistic, winRate, sharpeRatio, sortinoRatio, maxDrawdown, profitFactor, deg] as const
  const totalScore = values.reduce((sum, v) => sum + scores[v], 0)
  const overall = totalScore >= 10 ? 'green' : totalScore >= 6 ? 'yellow' : 'red'

  return { tStatistic, winRate, sharpeRatio, sortinoRatio, maxDrawdown, profitFactor, degradation: deg, overall }
}

function aggregateMetrics(metricsList: BacktestMetrics[]): BacktestMetrics {
  if (metricsList.length === 0) {
    return {
      totalTrades: 0, winningTrades: 0, losingTrades: 0, winRate: 0,
      netProfit: 0, maxDrawdown: 0, sharpeRatio: 0, sortinoRatio: 0, tStatistic: 0, profitFactor: 0,
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
    sortinoRatio: avg(metricsList.map((m) => m.sortinoRatio)),
    tStatistic: avg(metricsList.map((m) => m.tStatistic)),
    profitFactor: avg(metricsList.map((m) => m.profitFactor === Infinity ? 10 : m.profitFactor)),
  }
}
