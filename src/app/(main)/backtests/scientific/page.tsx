import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getStrategies } from '@/actions/strategies'
import { ScientificBacktestRunner } from '@/features/backtesting/components/ScientificBacktestRunner'
import Link from 'next/link'

export default async function ScientificBacktestPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const strategies = await getStrategies()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <Link href="/backtests" className="text-sm text-muted-foreground hover:text-foreground">
              Backtesting
            </Link>
            <span className="text-muted-foreground">/</span>
            <span className="text-sm text-foreground font-medium">Cientifico</span>
          </div>
          <h1 className="text-2xl font-bold text-foreground">Backtest Cientifico</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Validacion con In-Sample/Out-of-Sample, Walk-Forward y AI Review
          </p>
        </div>
      </div>

      <ScientificBacktestRunner
        strategies={strategies.map((s) => ({ id: s.id, name: s.name }))}
      />
    </div>
  )
}
