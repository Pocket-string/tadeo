import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { PaperTradingDashboard } from '@/features/paper-trading/components/PaperTradingDashboard'

export default async function PaperTradingPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-heading font-bold text-neutral-800">Paper Trading</h1>
        <p className="text-neutral-500">Simulación en tiempo real con precios de mercado.</p>
      </div>
      <PaperTradingDashboard />
    </div>
  )
}
