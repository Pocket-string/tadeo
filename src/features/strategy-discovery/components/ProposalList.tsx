'use client'

import { useState, useTransition } from 'react'
import { approveProposal, rejectProposal } from '@/actions/discoveries'
import type { ProposalRecord } from '../types'

interface ProposalListProps {
  proposals: ProposalRecord[]
  showActions?: boolean
}

export function ProposalList({ proposals, showActions }: ProposalListProps) {
  return (
    <div className="space-y-4">
      {proposals.map(p => (
        <ProposalCard key={p.id} proposal={p} showActions={showActions} />
      ))}
    </div>
  )
}

function ProposalCard({ proposal, showActions }: { proposal: ProposalRecord; showActions?: boolean }) {
  const [isPending, startTransition] = useTransition()
  const [result, setResult] = useState<string | null>(null)

  const metrics = proposal.backtest_results
  const verdictColor =
    proposal.ai_review_verdict === 'approve' ? 'text-success-500' :
    proposal.ai_review_verdict === 'caution' ? 'text-warning-500' : 'text-error-500'

  const enabledSystems = (proposal.signal_config ?? [])
    .filter(s => s.enabled)
    .map(s => s.id)

  function handleApprove() {
    startTransition(async () => {
      try {
        const { sessionId } = await approveProposal(proposal.id)
        setResult(`Deployed! Session: ${sessionId.slice(0, 8)}...`)
      } catch (err) {
        setResult(`Error: ${err instanceof Error ? err.message : 'Unknown'}`)
      }
    })
  }

  function handleReject() {
    startTransition(async () => {
      try {
        await rejectProposal(proposal.id)
        setResult('Rejected')
      } catch (err) {
        setResult(`Error: ${err instanceof Error ? err.message : 'Unknown'}`)
      }
    })
  }

  return (
    <div className="bg-surface rounded-xl border border-border p-4 md:p-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2 mb-4">
        <div>
          <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
            <h3 className="text-lg font-semibold text-foreground">
              {proposal.symbol} / {proposal.timeframe}
            </h3>
            <span className={`text-sm font-medium ${verdictColor}`}>
              {proposal.ai_review_verdict.toUpperCase()}
            </span>
            <span className="text-xs px-2 py-0.5 rounded-full bg-primary-500/10 text-primary-500">
              Score: {Number(proposal.score).toFixed(1)}
            </span>
          </div>
          <p className="text-sm text-foreground/60 mt-1 max-w-2xl">
            {proposal.ai_rationale}
          </p>
        </div>
        <StatusBadge status={proposal.status} />
      </div>

      {/* Metrics Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-7 gap-3 mb-4">
        <Metric label="Win Rate" value={`${(metrics.winRate * 100).toFixed(0)}%`}
          color={metrics.winRate > 0.55 ? 'text-success-500' : metrics.winRate > 0.45 ? 'text-warning-500' : 'text-error-500'} />
        <Metric label="PnL" value={`${(metrics.netPnlPct * 100).toFixed(1)}%`}
          color={metrics.netPnlPct > 0 ? 'text-success-500' : 'text-error-500'} />
        <Metric label="Sharpe" value={metrics.sharpeRatio.toFixed(2)}
          color={metrics.sharpeRatio > 1 ? 'text-success-500' : metrics.sharpeRatio > 0 ? 'text-warning-500' : 'text-error-500'} />
        <Metric label="Profit Factor" value={metrics.profitFactor === Infinity ? 'INF' : metrics.profitFactor.toFixed(2)}
          color={metrics.profitFactor > 1.5 ? 'text-success-500' : 'text-warning-500'} />
        <Metric label="Max DD" value={`${(metrics.maxDrawdown * 100).toFixed(1)}%`}
          color={metrics.maxDrawdown < 0.15 ? 'text-success-500' : metrics.maxDrawdown < 0.25 ? 'text-warning-500' : 'text-error-500'} />
        <Metric label="Trades" value={String(metrics.totalTrades)} />
        <Metric label="Trades/mo" value={metrics.tradesPerMonth.toFixed(1)} />
      </div>

      {/* Signal Systems */}
      <div className="flex flex-wrap gap-1.5 mb-4">
        {enabledSystems.map(id => (
          <span key={id} className="text-xs px-2 py-1 rounded-md bg-primary-500/10 text-primary-500 font-mono">
            {id}
          </span>
        ))}
      </div>

      {/* Actions */}
      {showActions && !result && (
        <div className="flex flex-col sm:flex-row gap-3 mt-4 pt-4 border-t border-border">
          <button
            onClick={handleApprove}
            disabled={isPending}
            className="px-6 py-2.5 bg-success-500 text-white rounded-xl font-medium hover:bg-success-500/90 transition-colors disabled:opacity-50"
          >
            {isPending ? 'Deploying...' : 'Approve & Deploy'}
          </button>
          <button
            onClick={handleReject}
            disabled={isPending}
            className="px-6 py-2.5 bg-surface border border-border text-foreground/60 rounded-xl font-medium hover:bg-error-500/10 hover:text-error-500 hover:border-error-500/30 transition-colors disabled:opacity-50"
          >
            Reject
          </button>
        </div>
      )}

      {result && (
        <div className="mt-4 pt-4 border-t border-border">
          <p className={`text-sm font-medium ${result.startsWith('Error') ? 'text-error-500' : 'text-success-500'}`}>
            {result}
          </p>
        </div>
      )}
    </div>
  )
}

function Metric({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div>
      <p className="text-[10px] uppercase text-foreground/40">{label}</p>
      <p className={`text-sm font-semibold ${color ?? 'text-foreground'}`}>{value}</p>
    </div>
  )
}

function StatusBadge({ status }: { status: string }) {
  const styles: Record<string, string> = {
    pending: 'bg-warning-500/10 text-warning-500',
    deployed: 'bg-success-500/10 text-success-500',
    rejected: 'bg-foreground/10 text-foreground/40',
    approved: 'bg-success-500/10 text-success-500',
  }

  return (
    <span className={`text-xs px-2.5 py-1 rounded-full font-medium ${styles[status] ?? styles.pending}`}>
      {status}
    </span>
  )
}
