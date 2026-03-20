import { getProposals } from '@/actions/discoveries'
import { ProposalList } from '@/features/strategy-discovery/components/ProposalList'

export default async function DiscoveriesPage() {
  const proposals = await getProposals()

  const pending = proposals.filter(p => p.status === 'pending')
  const deployed = proposals.filter(p => p.status === 'deployed')
  const rejected = proposals.filter(p => p.status === 'rejected')

  return (
    <div className="p-8">
      <div className="max-w-6xl mx-auto">
        <div className="mb-8">
          <h1 className="text-3xl font-heading font-bold text-foreground">
            Strategy Discoveries
          </h1>
          <p className="text-foreground/60 mt-2">
            AI-discovered strategies awaiting your approval. Review metrics, then approve or reject.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-3 gap-4 mb-8">
          <div className="bg-surface rounded-xl p-4 border border-border">
            <p className="text-sm text-foreground/60">Pending</p>
            <p className="text-2xl font-bold text-warning-500">{pending.length}</p>
          </div>
          <div className="bg-surface rounded-xl p-4 border border-border">
            <p className="text-sm text-foreground/60">Deployed</p>
            <p className="text-2xl font-bold text-success-500">{deployed.length}</p>
          </div>
          <div className="bg-surface rounded-xl p-4 border border-border">
            <p className="text-sm text-foreground/60">Rejected</p>
            <p className="text-2xl font-bold text-foreground/40">{rejected.length}</p>
          </div>
        </div>

        {/* Pending Proposals */}
        {pending.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4 text-foreground">
              Pending Review ({pending.length})
            </h2>
            <ProposalList proposals={pending} showActions />
          </section>
        )}

        {pending.length === 0 && (
          <div className="bg-surface rounded-xl p-12 border border-border text-center mb-10">
            <p className="text-foreground/60 text-lg">No pending proposals</p>
            <p className="text-foreground/40 text-sm mt-2">
              The discovery agent runs periodically. New proposals will appear here.
            </p>
          </div>
        )}

        {/* Deployed */}
        {deployed.length > 0 && (
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4 text-foreground/70">
              Deployed ({deployed.length})
            </h2>
            <ProposalList proposals={deployed} />
          </section>
        )}

        {/* Rejected */}
        {rejected.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 text-foreground/40">
              Rejected ({rejected.length})
            </h2>
            <ProposalList proposals={rejected} />
          </section>
        )}
      </div>
    </div>
  )
}
