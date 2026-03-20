import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getMarketDataSummary } from '@/actions/market-data'
import { getStrategies } from '@/actions/strategies'
import { getBacktestResults } from '@/actions/backtests'
import Link from 'next/link'

export default async function DashboardPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data: profile } = await supabase
    .from('profiles')
    .select('role, full_name')
    .eq('id', user.id)
    .single()

  const userName = profile?.full_name || user.email?.split('@')[0] || 'Usuario'

  const [marketData, strategies, backtests] = await Promise.all([
    getMarketDataSummary(),
    getStrategies(),
    getBacktestResults(),
  ])

  const totalCandles = marketData.reduce((sum, m) => sum + m.count, 0)
  const uniqueSymbols = new Set(marketData.map((m) => m.symbol)).size
  const greeting = getGreeting()

  return (
    <div className="p-4 md:p-6 lg:p-8 space-y-6">
      <div>
        <h1 className="text-xl md:text-2xl font-bold text-foreground">
          {greeting}, {userName}
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Vista general del sistema de trading
        </p>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
        <KPICard
          title="Simbolos"
          value={uniqueSymbols}
          subtitle={`${totalCandles.toLocaleString()} candles totales`}
          href="/market-data"
        />
        <KPICard
          title="Estrategias"
          value={strategies.length}
          subtitle={strategies.length > 0 ? strategies[0].name : 'Crear primera'}
          href="/strategies"
        />
        <KPICard
          title="Backtests"
          value={backtests.length}
          subtitle={backtests.length > 0 ? `Ultimo: ${new Date(backtests[0].created_at).toLocaleDateString()}` : 'Ejecutar primero'}
          href="/backtests"
        />
        <KPICard
          title="Estado"
          value="Fase 2"
          subtitle="Data Pipeline + UI"
          href="#"
        />
      </div>

      {/* Market Data Preview */}
      <div className="bg-surface border border-border rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold text-foreground">Datos de Mercado</h2>
          <Link href="/market-data" className="text-sm text-primary hover:underline">
            Ver todo →
          </Link>
        </div>
        {marketData.length === 0 ? (
          <div className="text-center py-8 text-muted-foreground">
            <p className="text-lg mb-2">Sin datos de mercado</p>
            <p className="text-sm mb-4">Ingesta datos desde Binance para comenzar</p>
            <Link
              href="/market-data"
              className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md hover:bg-primary/90"
            >
              Ir a Market Data
            </Link>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">Simbolo</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">Timeframe</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Candles</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Ultimo dato</th>
                </tr>
              </thead>
              <tbody>
                {marketData.slice(0, 5).map((m) => (
                  <tr key={`${m.symbol}-${m.timeframe}`} className="border-b border-border/50">
                    <td className="py-2 font-mono font-medium text-foreground">{m.symbol}</td>
                    <td className="py-2 text-muted-foreground">{m.timeframe}</td>
                    <td className="py-2 text-right text-foreground">{m.count.toLocaleString()}</td>
                    <td className="py-2 text-right text-muted-foreground text-xs">
                      {new Date(m.last).toLocaleDateString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Recent Backtests */}
      {backtests.length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-foreground">Backtests Recientes</h2>
            <Link href="/backtests" className="text-sm text-primary hover:underline">
              Ver todo →
            </Link>
          </div>
          <div className="space-y-2">
            {backtests.slice(0, 3).map((bt) => (
              <div key={bt.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 p-3 bg-background rounded-md">
                <div>
                  <span className="font-medium text-foreground">{bt.symbol}</span>
                  <span className="text-muted-foreground ml-2 text-sm">{bt.timeframe}</span>
                </div>
                <div className="flex items-center flex-wrap gap-2 sm:gap-4 text-sm">
                  <span className={bt.net_profit > 0 ? 'text-green-500' : 'text-red-500'}>
                    ${Number(bt.net_profit).toFixed(2)}
                  </span>
                  <span className="text-muted-foreground">
                    WR: {(Number(bt.win_rate) * 100).toFixed(0)}%
                  </span>
                  <MetricBadge label="Sharpe" value={Number(bt.sharpe_ratio)} green={1.5} yellow={1.0} />
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function getGreeting(): string {
  const hour = new Date().getHours()
  if (hour < 12) return 'Buenos dias'
  if (hour < 18) return 'Buenas tardes'
  return 'Buenas noches'
}

function KPICard({ title, value, subtitle, href }: {
  title: string
  value: string | number
  subtitle: string
  href: string
}) {
  return (
    <Link href={href} className="bg-surface border border-border rounded-lg p-4 hover:border-primary/50 transition-colors">
      <p className="text-sm text-muted-foreground">{title}</p>
      <p className="text-2xl font-bold text-foreground mt-1">{value}</p>
      <p className="text-xs text-muted-foreground mt-1 truncate">{subtitle}</p>
    </Link>
  )
}

function MetricBadge({ label, value, green, yellow }: {
  label: string
  value: number
  green: number
  yellow: number
}) {
  const color = value >= green
    ? 'bg-green-500/10 text-green-500'
    : value >= yellow
      ? 'bg-yellow-500/10 text-yellow-500'
      : 'bg-red-500/10 text-red-500'

  return (
    <span className={`px-2 py-0.5 rounded text-xs font-medium ${color}`}>
      {label}: {value.toFixed(2)}
    </span>
  )
}
