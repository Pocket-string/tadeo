import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { LiveTradingDashboard } from '@/features/live-trading/components/LiveTradingDashboard'

export default async function LiveTradingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold text-neutral-800">Live Trading</h1>
        <p className="text-neutral-500">Ejecución automatizada con gestión de riesgo y kill switch.</p>
      </div>
      <LiveTradingDashboard />
    </div>
  )
}
