'use client'

import { useState, useTransition } from 'react'
import { triggerManualDiscovery } from '@/actions/discoveries'
import { ProposalList } from './ProposalList'
import type { ProposalRecord } from '../types'
import type { DiscoveryRun } from '@/actions/discoveries'

type Tab = 'pending' | 'deployed' | 'rejected'
type QualityPreset = 'strict' | 'balanced' | 'exploratory'

const QUALITY_PRESETS: Record<QualityPreset, { label: string; minScore: number; description: string }> = {
  strict: { label: 'Estricto', minScore: 6, description: 'Solo las mejores estrategias' },
  balanced: { label: 'Balanceado', minScore: 4, description: 'Balance calidad/cantidad' },
  exploratory: { label: 'Exploratorio', minScore: 3, description: 'Mas propuestas, menor filtro' },
}

interface Props {
  proposals: ProposalRecord[]
  runs: DiscoveryRun[]
}

export function DiscoveriesClient({ proposals, runs }: Props) {
  const [tab, setTab] = useState<Tab>('pending')
  const [qualityPreset, setQualityPreset] = useState<QualityPreset>('balanced')
  const [isRunning, startTransition] = useTransition()
  const [runResult, setRunResult] = useState<string | null>(null)

  const pending = proposals.filter(p => p.status === 'pending')
  const deployed = proposals.filter(p => p.status === 'deployed')
  const rejected = proposals.filter(p => p.status === 'rejected')

  const counts: Record<Tab, number> = {
    pending: pending.length,
    deployed: deployed.length,
    rejected: rejected.length,
  }

  const tabLabels: Record<Tab, string> = {
    pending: 'Pendientes',
    deployed: 'Desplegadas',
    rejected: 'Rechazadas',
  }

  const currentProposals = tab === 'pending' ? pending : tab === 'deployed' ? deployed : rejected

  function handleRunDiscovery() {
    setRunResult(null)
    startTransition(async () => {
      try {
        const result = await triggerManualDiscovery(QUALITY_PRESETS[qualityPreset].minScore)
        if (result.proposals > 0) {
          setRunResult(`${result.proposals} propuestas encontradas de ${result.tested} hipotesis probadas`)
        } else {
          const reason = result.errors.length > 0
            ? result.errors[0]
            : `${result.tested} hipotesis probadas, ninguna supero el umbral`
          setRunResult(`Sin propuestas: ${reason}`)
        }
      } catch (err) {
        setRunResult(`Error: ${err instanceof Error ? err.message : 'Unknown'}`)
      }
    })
  }

  return (
    <div className="p-4 md:p-8">
      <div className="max-w-6xl mx-auto">
        {/* Header */}
        <div className="mb-6 md:mb-8">
          <h1 className="text-3xl font-heading font-bold text-foreground">
            Strategy Discoveries
          </h1>
          <p className="text-foreground/60 mt-2">
            Estrategias descubiertas por IA. Revisa metricas, aprueba o rechaza.
          </p>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
          {(['pending', 'deployed', 'rejected'] as Tab[]).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`bg-surface rounded-xl p-4 border text-left transition-colors ${
                tab === t ? 'border-primary-500 ring-1 ring-primary-500/20' : 'border-border hover:border-primary-500/30'
              }`}
            >
              <p className="text-sm text-foreground/60">{tabLabels[t]}</p>
              <p className={`text-2xl font-bold ${
                t === 'pending' ? 'text-warning-500' : t === 'deployed' ? 'text-success-500' : 'text-foreground/40'
              }`}>{counts[t]}</p>
            </button>
          ))}
        </div>

        {/* Manual Discovery Trigger */}
        <div className="bg-surface rounded-xl border border-border p-4 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div className="flex-1">
              <h3 className="font-semibold text-foreground text-sm">Ejecutar Discovery</h3>
              <p className="text-xs text-foreground/50 mt-0.5">
                Escanea mercados activos y genera nuevas propuestas
              </p>
            </div>

            {/* Quality Preset */}
            <div className="flex gap-1">
              {(Object.keys(QUALITY_PRESETS) as QualityPreset[]).map(preset => (
                <button
                  key={preset}
                  onClick={() => setQualityPreset(preset)}
                  title={QUALITY_PRESETS[preset].description}
                  className={`px-3 py-1.5 text-xs rounded-lg transition-colors ${
                    qualityPreset === preset
                      ? 'bg-primary-500 text-white font-medium'
                      : 'bg-surface border border-border text-foreground/60 hover:text-foreground'
                  }`}
                >
                  {QUALITY_PRESETS[preset].label}
                </button>
              ))}
            </div>

            <button
              onClick={handleRunDiscovery}
              disabled={isRunning}
              className="px-5 py-2 bg-primary-500 text-white rounded-xl font-medium hover:bg-primary-500/90 transition-colors disabled:opacity-50 text-sm whitespace-nowrap"
            >
              {isRunning ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                  Escaneando...
                </span>
              ) : (
                'Ejecutar ahora'
              )}
            </button>
          </div>

          {runResult && (
            <p className={`text-sm mt-3 pt-3 border-t border-border ${
              runResult.startsWith('Error') || runResult.startsWith('Sin')
                ? 'text-warning-500' : 'text-success-500'
            }`}>
              {runResult}
            </p>
          )}
        </div>

        {/* Proposals for current tab */}
        {currentProposals.length > 0 ? (
          <section className="mb-10">
            <h2 className="text-xl font-semibold mb-4 text-foreground">
              {tabLabels[tab]} ({counts[tab]})
            </h2>
            <ProposalList proposals={currentProposals} showActions={tab === 'pending'} />
          </section>
        ) : (
          <div className="bg-surface rounded-xl p-12 border border-border text-center mb-10">
            <p className="text-foreground/60 text-lg">
              {tab === 'pending' ? 'Sin propuestas pendientes' :
               tab === 'deployed' ? 'Sin propuestas desplegadas' : 'Sin propuestas rechazadas'}
            </p>
            <p className="text-foreground/40 text-sm mt-2">
              {tab === 'pending'
                ? 'Ejecuta el discovery manualmente o espera al cron (cada 6h)'
                : 'Las propuestas apareceran aqui cuando las revises'}
            </p>
          </div>
        )}

        {/* Run History */}
        {runs.length > 0 && (
          <section>
            <h2 className="text-xl font-semibold mb-4 text-foreground/70">
              Historial de ejecuciones
            </h2>
            <div className="bg-surface rounded-xl border border-border overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-foreground/50">
                    <th className="text-left p-3 font-medium">Fecha</th>
                    <th className="text-left p-3 font-medium">Trigger</th>
                    <th className="text-left p-3 font-medium">Pares</th>
                    <th className="text-right p-3 font-medium">Hipotesis</th>
                    <th className="text-right p-3 font-medium">Propuestas</th>
                    <th className="text-right p-3 font-medium">Rechazadas</th>
                    <th className="text-right p-3 font-medium">Duracion</th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map(run => (
                    <tr key={run.id} className="border-b border-border/50 hover:bg-foreground/5">
                      <td className="p-3 text-foreground/70 whitespace-nowrap">
                        {new Date(run.started_at).toLocaleString('es', {
                          day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'
                        })}
                      </td>
                      <td className="p-3">
                        <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                          run.trigger === 'manual' ? 'bg-primary-500/10 text-primary-500' :
                          run.trigger === 'auto-retire' ? 'bg-warning-500/10 text-warning-500' :
                          'bg-foreground/10 text-foreground/50'
                        }`}>
                          {run.trigger}
                        </span>
                      </td>
                      <td className="p-3 text-foreground/60 text-xs font-mono">
                        {run.symbols.join(', ')}
                      </td>
                      <td className="p-3 text-right text-foreground/70">
                        {run.hypotheses_generated} / {run.hypotheses_tested}
                      </td>
                      <td className="p-3 text-right">
                        <span className={run.proposals_saved > 0 ? 'text-success-500 font-medium' : 'text-foreground/40'}>
                          {run.proposals_saved}
                        </span>
                      </td>
                      <td className="p-3 text-right text-foreground/40">
                        {run.proposals_rejected}
                      </td>
                      <td className="p-3 text-right text-foreground/50">
                        {run.duration_ms ? `${(run.duration_ms / 1000).toFixed(0)}s` : '...'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {runs.some(r => r.errors.length > 0) && (
              <details className="mt-2">
                <summary className="text-xs text-foreground/40 cursor-pointer hover:text-foreground/60">
                  Ver errores
                </summary>
                <div className="mt-2 p-3 bg-error-500/5 rounded-lg text-xs text-error-500 space-y-1">
                  {runs.flatMap(r => r.errors).map((err, i) => (
                    <p key={i}>{err}</p>
                  ))}
                </div>
              </details>
            )}
          </section>
        )}
      </div>
    </div>
  )
}
