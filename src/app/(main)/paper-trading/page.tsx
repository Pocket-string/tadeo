import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { PaperTradingDashboard } from '@/features/paper-trading/components/PaperTradingDashboard'
import { TurboSimulator } from '@/features/paper-trading/components/TurboSimulator'

export default async function PaperTradingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="p-4 md:p-6 space-y-8">
      <div>
        <h1 className="text-2xl font-heading font-bold text-neutral-800">Paper Trading</h1>
        <p className="text-neutral-500">Simulacion acelerada + trading en tiempo real.</p>
      </div>

      {/* Turbo Simulator — months of results in seconds */}
      <TurboSimulator />

      {/* Real-time Paper Trading */}
      <div className="border-t border-neutral-200 pt-6">
        <h2 className="text-lg font-heading font-semibold text-neutral-800 mb-4">Sesiones en Tiempo Real</h2>
        <PaperTradingDashboard />
      </div>
    </div>
  )
}
