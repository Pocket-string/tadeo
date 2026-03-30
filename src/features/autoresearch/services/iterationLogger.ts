import * as fs from 'fs'
import * as path from 'path'
import type { IterationResult } from '../types'

// ─── Iteration Logger ───────────────────────────────────────────────────────
// Dual output: TSV file (local) + console (real-time)

const TSV_HEADER = [
  'iteration', 'score', 'max_score', 'status', 'hypothesis',
  'category', 'param_key', 'old_value', 'new_value',
  'avg_win_rate', 'avg_pnl_pct', 'avg_sharpe', 'worst_dd',
  'total_trades', 'duration_ms',
].join('\t')

export class IterationLogger {
  private tsvPath: string
  private initialized = false

  constructor(outputDir: string, runId: string) {
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }
    this.tsvPath = path.join(outputDir, `autoresearch-${runId}.tsv`)
  }

  /** Initialize TSV file with header */
  init(): void {
    fs.writeFileSync(this.tsvPath, TSV_HEADER + '\n', 'utf-8')
    this.initialized = true
  }

  /** Log one iteration to TSV + console */
  log(result: IterationResult): void {
    if (!this.initialized) this.init()

    // TSV row
    const row = [
      result.iteration,
      result.score,
      result.maxScore,
      result.status,
      result.hypothesis,
      result.category,
      result.paramKey,
      result.oldValue,
      result.newValue,
      (result.aggregate.avgWinRate * 100).toFixed(1),
      (result.aggregate.avgNetPnlPct * 100).toFixed(2),
      result.aggregate.avgSharpe.toFixed(2),
      (result.aggregate.worstDrawdown * 100).toFixed(1),
      result.aggregate.totalTrades,
      result.durationMs,
    ].join('\t')
    fs.appendFileSync(this.tsvPath, row + '\n', 'utf-8')

    // Console output
    this.printIteration(result)
  }

  /** Print formatted iteration to console */
  private printIteration(r: IterationResult): void {
    const pad = (s: string, n: number) => s.padEnd(n)
    const iterStr = `[iter ${String(r.iteration).padStart(3)}/${String(r.maxScore)}]`

    const statusColors: Record<string, string> = {
      baseline: '\x1b[36m', // cyan
      keep: '\x1b[32m',     // green
      discard: '\x1b[33m',  // yellow
      crash: '\x1b[31m',    // red
    }
    const reset = '\x1b[0m'
    const color = statusColors[r.status] ?? reset

    const scoreStr = `${r.score}/${r.maxScore}`
    const metricsStr = [
      `WR ${(r.aggregate.avgWinRate * 100).toFixed(0)}%`,
      `PnL ${r.aggregate.avgNetPnlPct >= 0 ? '+' : ''}${(r.aggregate.avgNetPnlPct * 100).toFixed(1)}%`,
      `Sharpe ${r.aggregate.avgSharpe.toFixed(1)}`,
      `DD ${(r.aggregate.worstDrawdown * 100).toFixed(0)}%`,
    ].join(' ')

    const hypothesis = r.hypothesis.length > 50
      ? r.hypothesis.slice(0, 47) + '...'
      : r.hypothesis

    console.log(
      `${iterStr} ${color}${pad(r.status.toUpperCase(), 8)}${reset} ${scoreStr} | ${hypothesis} | ${metricsStr} | ${r.durationMs}ms`,
    )
  }

  /** Print final report */
  printReport(history: IterationResult[]): void {
    const baseline = history[0]
    const best = history.reduce((a, b) => (a.score >= b.score ? a : b), history[0])
    const kept = history.filter(h => h.status === 'keep')
    const discarded = history.filter(h => h.status === 'discard')
    const crashed = history.filter(h => h.status === 'crash')
    const totalTime = history.reduce((s, h) => s + h.durationMs, 0)

    console.log('\n' + '='.repeat(60))
    console.log('  AUTORESEARCH REPORT')
    console.log('='.repeat(60))
    console.log(`  Baseline: ${baseline.score}/${baseline.maxScore} (${(baseline.pct * 100).toFixed(0)}%)`)
    console.log(`  Final:    ${best.score}/${best.maxScore} (${(best.pct * 100).toFixed(0)}%)`)
    console.log(`  Change:   ${best.score > baseline.score ? '+' : ''}${best.score - baseline.score} in ${history.length - 1} iterations`)
    console.log(`  Kept: ${kept.length} | Discarded: ${discarded.length} | Crashed: ${crashed.length}`)
    console.log(`  Total time: ${(totalTime / 1000).toFixed(1)}s`)
    console.log()

    if (kept.length > 0) {
      console.log('  Changes that improved:')
      for (const k of kept) {
        console.log(`    iter ${String(k.iteration).padStart(3)}: ${k.hypothesis}`)
      }
    }

    console.log()
    console.log(`  Best params saved to: ${this.tsvPath}`)
    console.log('='.repeat(60))
  }
}
