import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getStrategies } from '@/actions/strategies'
import Link from 'next/link'
import type { StrategyParameters } from '@/types/database'

export default async function StrategiesPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const strategies = await getStrategies()

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Estrategias</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Configura parametros de trading para backtesting
          </p>
        </div>
        <Link
          href="/strategies/new"
          className="px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm font-medium hover:bg-primary/90 transition-colors"
        >
          + Nueva Estrategia
        </Link>
      </div>

      {strategies.length === 0 ? (
        <div className="bg-surface border border-border rounded-lg p-12 text-center">
          <p className="text-lg text-muted-foreground mb-2">Sin estrategias</p>
          <p className="text-sm text-muted-foreground mb-4">
            Crea tu primera estrategia para comenzar a hacer backtesting
          </p>
          <Link
            href="/strategies/new"
            className="inline-flex items-center px-4 py-2 bg-primary text-primary-foreground rounded-md text-sm hover:bg-primary/90"
          >
            Crear Estrategia
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {strategies.map((s) => {
            const params = s.parameters as StrategyParameters
            return (
              <div key={s.id} className="bg-surface border border-border rounded-lg p-5 hover:border-primary/50 transition-colors">
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-semibold text-foreground">{s.name}</h3>
                    {s.description && (
                      <p className="text-xs text-muted-foreground mt-1">{s.description}</p>
                    )}
                  </div>
                  <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                    s.status === 'active'
                      ? 'bg-green-500/10 text-green-500'
                      : 'bg-yellow-500/10 text-yellow-500'
                  }`}>
                    {s.status}
                  </span>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs">
                  <ParamRow label="EMA Fast" value={params.ema_fast} />
                  <ParamRow label="EMA Slow" value={params.ema_slow} />
                  <ParamRow label="RSI Period" value={params.rsi_period} />
                  <ParamRow label="MACD" value={`${params.macd_fast}/${params.macd_slow}/${params.macd_signal}`} />
                  <ParamRow label="Stop Loss" value={`${(params.stop_loss_pct * 100).toFixed(1)}%`} />
                  <ParamRow label="Take Profit" value={`${(params.take_profit_pct * 100).toFixed(1)}%`} />
                </div>

                <div className="mt-4 flex gap-2">
                  <Link
                    href={`/backtests?strategyId=${s.id}`}
                    className="flex-1 text-center py-1.5 border border-border rounded-md text-xs text-muted-foreground hover:border-primary/50 hover:text-foreground transition-colors"
                  >
                    Backtests
                  </Link>
                </div>

                <p className="text-xs text-muted-foreground mt-3">
                  Creada {new Date(s.created_at).toLocaleDateString()}
                </p>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function ParamRow({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="flex justify-between items-center py-1 border-b border-border/30">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-mono text-foreground">{value}</span>
    </div>
  )
}
