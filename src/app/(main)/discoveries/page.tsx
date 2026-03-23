import { getProposals, getDiscoveryRuns } from '@/actions/discoveries'
import { DiscoveriesClient } from '@/features/strategy-discovery/components/DiscoveriesClient'

export default async function DiscoveriesPage() {
  const [proposals, runs] = await Promise.all([
    getProposals(),
    getDiscoveryRuns(10),
  ])

  return <DiscoveriesClient proposals={proposals} runs={runs} />
}
