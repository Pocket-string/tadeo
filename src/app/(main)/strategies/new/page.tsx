import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { createStrategy } from '@/actions/strategies'
import { DEFAULT_STRATEGY_PARAMS } from '@/types/database'
import Link from 'next/link'

export default async function NewStrategyPage() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  async function handleCreate(formData: FormData) {
    'use server'
    await createStrategy(formData)
    redirect('/strategies')
  }

  const p = DEFAULT_STRATEGY_PARAMS

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <Link href="/strategies" className="text-sm text-muted-foreground hover:text-foreground">
          ← Volver a Estrategias
        </Link>
        <h1 className="text-2xl font-bold text-foreground mt-2">Nueva Estrategia</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Configura los parametros de tu estrategia de trading
        </p>
      </div>

      <form action={handleCreate} className="space-y-6">
        {/* Basic Info */}
        <div className="bg-surface border border-border rounded-lg p-6 space-y-4">
          <h2 className="font-semibold text-foreground">Informacion General</h2>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Nombre</label>
            <input
              name="name"
              type="text"
              required
              maxLength={100}
              placeholder="Ej: EMA Cross BTC 1h"
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-muted-foreground mb-1">Descripcion (opcional)</label>
            <textarea
              name="description"
              maxLength={500}
              rows={2}
              placeholder="Describe la logica de la estrategia..."
              className="w-full bg-background border border-border rounded-md px-3 py-2 text-sm text-foreground resize-none"
            />
          </div>
        </div>

        {/* Parameters Info */}
        <div className="bg-surface border border-border rounded-lg p-6 space-y-3">
          <h2 className="font-semibold text-foreground">Parametros por Defecto</h2>
          <p className="text-xs text-muted-foreground">
            La estrategia se creara con estos parametros. Podras modificarlos despues.
          </p>
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">EMA Fast</span>
              <span className="font-mono text-foreground">{p.ema_fast}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">EMA Slow</span>
              <span className="font-mono text-foreground">{p.ema_slow}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">RSI Period</span>
              <span className="font-mono text-foreground">{p.rsi_period}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">MACD</span>
              <span className="font-mono text-foreground">{p.macd_fast}/{p.macd_slow}/{p.macd_signal}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">BB Period</span>
              <span className="font-mono text-foreground">{p.bb_period}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">BB Std Dev</span>
              <span className="font-mono text-foreground">{p.bb_std_dev}</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">Stop Loss</span>
              <span className="font-mono text-foreground">{(p.stop_loss_pct * 100).toFixed(1)}%</span>
            </div>
            <div className="flex justify-between py-1 border-b border-border/30">
              <span className="text-muted-foreground">Take Profit</span>
              <span className="font-mono text-foreground">{(p.take_profit_pct * 100).toFixed(1)}%</span>
            </div>
          </div>
        </div>

        <button
          type="submit"
          className="w-full py-2.5 bg-primary text-primary-foreground rounded-md font-medium text-sm hover:bg-primary/90 transition-colors"
        >
          Crear Estrategia
        </button>
      </form>
    </div>
  )
}
