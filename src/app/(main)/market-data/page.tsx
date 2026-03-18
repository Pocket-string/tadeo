import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getMarketDataSummary } from '@/actions/market-data'
import { IngestForm } from '@/features/market-data/components/IngestForm'

export default async function MarketDataPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const marketData = await getMarketDataSummary()
  const totalCandles = marketData.reduce((sum, m) => sum + m.count, 0)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Market Data</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Ingesta y gestion de datos historicos OHLCV desde Binance
        </p>
      </div>

      <IngestForm />

      {/* Data Summary */}
      <div className="bg-surface border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">Datos Disponibles</h2>
          <span className="text-sm text-muted-foreground">
            {totalCandles.toLocaleString()} candles totales
          </span>
        </div>

        {marketData.length === 0 ? (
          <p className="text-center py-8 text-muted-foreground">
            No hay datos. Usa el formulario de arriba para ingestar datos de Binance.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">Simbolo</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">Timeframe</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Candles</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Primer dato</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Ultimo dato</th>
                </tr>
              </thead>
              <tbody>
                {marketData.map((m) => (
                  <tr key={`${m.symbol}-${m.timeframe}`} className="border-b border-border/50 hover:bg-background/50">
                    <td className="py-3 font-mono font-medium text-foreground">{m.symbol}</td>
                    <td className="py-3">
                      <span className="px-2 py-0.5 bg-primary/10 text-primary rounded text-xs font-medium">
                        {m.timeframe}
                      </span>
                    </td>
                    <td className="py-3 text-right text-foreground font-medium">{m.count.toLocaleString()}</td>
                    <td className="py-3 text-right text-muted-foreground text-xs">
                      {new Date(m.first).toLocaleDateString()}
                    </td>
                    <td className="py-3 text-right text-muted-foreground text-xs">
                      {new Date(m.last).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}
