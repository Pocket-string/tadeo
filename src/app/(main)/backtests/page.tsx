import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getStrategies } from '@/actions/strategies'
import { getBacktestResults } from '@/actions/backtests'
import { BacktestRunner } from '@/features/backtesting/components/BacktestRunner'
import Link from 'next/link'

export default async function BacktestsPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const [strategies, backtests] = await Promise.all([
    getStrategies(),
    getBacktestResults(),
  ])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Backtesting</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Valida tus estrategias con datos historicos
          </p>
        </div>
        <Link
          href="/backtests/scientific"
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          Backtest Cientifico →
        </Link>
      </div>

      <BacktestRunner
        strategies={strategies.map((s) => ({ id: s.id, name: s.name }))}
      />

      {/* Historical Results */}
      {backtests.length > 0 && (
        <div className="bg-surface border border-border rounded-lg p-6">
          <h2 className="text-lg font-semibold text-foreground mb-4">Resultados Anteriores</h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border">
                  <th className="text-left py-2 text-muted-foreground font-medium">Estrategia</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">Simbolo</th>
                  <th className="text-left py-2 text-muted-foreground font-medium">TF</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Trades</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Win Rate</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">P&L</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Sharpe</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">t-stat</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Drawdown</th>
                  <th className="text-right py-2 text-muted-foreground font-medium">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {backtests.map((bt) => {
                  const stratName = (bt as Record<string, unknown>).strategies
                    ? ((bt as Record<string, unknown>).strategies as Record<string, string>).name
                    : '—'
                  return (
                    <tr key={bt.id} className="border-b border-border/50 hover:bg-background/50">
                      <td className="py-2 font-medium text-foreground">{stratName}</td>
                      <td className="py-2 font-mono text-foreground">{bt.symbol}</td>
                      <td className="py-2">
                        <span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-xs">
                          {bt.timeframe}
                        </span>
                      </td>
                      <td className="py-2 text-right">{bt.total_trades}</td>
                      <td className="py-2 text-right">
                        <SemaforoValue value={Number(bt.win_rate)} format="pct" green={0.55} yellow={0.45} />
                      </td>
                      <td className={`py-2 text-right font-medium ${Number(bt.net_profit) > 0 ? 'text-green-500' : 'text-red-500'}`}>
                        ${Number(bt.net_profit).toFixed(0)}
                      </td>
                      <td className="py-2 text-right">
                        <SemaforoValue value={Number(bt.sharpe_ratio)} format="dec" green={1.5} yellow={1.0} />
                      </td>
                      <td className="py-2 text-right">
                        <SemaforoValue value={Number(bt.t_statistic)} format="dec" green={3.0} yellow={2.0} />
                      </td>
                      <td className="py-2 text-right">
                        <SemaforoValue value={Number(bt.max_drawdown)} format="pct" green={0.15} yellow={0.25} invert />
                      </td>
                      <td className="py-2 text-right text-xs text-muted-foreground">
                        {new Date(bt.created_at).toLocaleDateString()}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}

function SemaforoValue({ value, format, green, yellow, invert }: {
  value: number
  format: 'pct' | 'dec'
  green: number
  yellow: number
  invert?: boolean
}) {
  const display = format === 'pct' ? `${(value * 100).toFixed(1)}%` : value.toFixed(2)

  let color: string
  if (invert) {
    color = value <= green ? 'text-green-500' : value <= yellow ? 'text-yellow-500' : 'text-red-500'
  } else {
    color = value >= green ? 'text-green-500' : value >= yellow ? 'text-yellow-500' : 'text-red-500'
  }

  return <span className={`font-medium ${color}`}>{display}</span>
}
