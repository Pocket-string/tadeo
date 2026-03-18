import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getMarketDataSummary } from '@/actions/market-data'
import { AIAnalysisPanel } from '@/features/ai-analyst/components/AIAnalysisPanel'

export default async function AIAnalystPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const marketData = await getMarketDataSummary()
  const availableSymbols = [...new Set(marketData.map((m) => m.symbol))]

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">AI Analyst</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Analisis de mercado con IA y generacion automatica de estrategias
        </p>
      </div>

      {availableSymbols.length === 0 && (
        <div className="bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-4 text-sm text-yellow-600">
          No hay datos de mercado. Ve a <a href="/market-data" className="underline font-medium">Market Data</a> para
          ingestar datos de Binance antes de usar el AI Analyst.
        </div>
      )}

      <AIAnalysisPanel availableSymbols={availableSymbols} />
    </div>
  )
}
