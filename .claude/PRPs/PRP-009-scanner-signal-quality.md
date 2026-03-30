# PRP-009: Mejorar Calidad de Senales del Opportunity Scanner

> **Estado**: PENDIENTE
> **Fecha**: 2026-03-29
> **Proyecto**: Trader Bot

---

## Objetivo

Upgradar el Scanner para usar el sistema completo de 7 senales con parametros optimizados por autoresearch,
reemplazando la logica simplificada actual (solo EMA cross + momentum).

## Por Que

| Problema | Solucion |
|----------|----------|
| Scanner usa logica propia simplificada (EMA cross + ADX momentum) ignorando 5 de las 7 senales | Integrar `generateAdaptiveComposite()` del signalRegistry |
| Parametros hardcoded (`DEFAULT_STRATEGY_PARAMS`) sin optimizacion | Cargar best params de `autoresearch_runs` cuando existan |
| SL/TP multipliers hardcoded (1.5/2.5) sin relacion con params de estrategia | Usar `params.stop_loss_pct` y `params.take_profit_pct` |
| No aprovecha senales de alto WR: bb-mean-rev (13W/0L), engulfing-sr (100% WR) | Composite score incluye las 7 senales ponderadas |

**Valor**: Senales de mayor calidad -> menos oportunidades falsas -> mejores resultados en paper/live.

---

## Criterios de Exito

- [ ] Scanner usa `generateAdaptiveComposite()` en vez de logica EMA cross propia
- [ ] SL/TP usan `params.stop_loss_pct` y `params.take_profit_pct` (ATR multipliers)
- [ ] Si existen params optimizados en `autoresearch_runs`, se cargan automaticamente
- [ ] Score incorpora composite confidence (no solo indicadores sueltos)
- [ ] UI muestra senales activas y composite confidence en cada oportunidad
- [ ] `pnpm exec tsc --noEmit` = 0 errores
- [ ] Escaneo desde UI retorna oportunidades con datos correctos

---

## Contexto Tecnico

### Problema: Scanner tiene su propia logica simplificada

**Actual** (`scannerEngine.ts` lineas 56-84):
- Solo detecta EMA cross (fast cruza slow)
- Confluencia basica: MACD histogram + RSI
- Momentum entry si ADX > 30
- **Ignora**: bb-mean-rev, double-pattern, rsi-divergence, volume-confirm, engulfing-sr

**Deseado**: Usar `generateAdaptiveComposite()` que:
- Pondera 7 senales con pesos calibrados por regimen
- Trending: ema-cross 1.5, bb-mean-rev 0.5, adx-trend 0.7
- Ranging: ema-cross 0.3, bb-mean-rev 1.5, adx-trend 0.2
- Threshold adaptativo: 0.3 normal, 0.5 en volatil

### Archivos a Modificar

| Archivo | Accion | Razon |
|---------|--------|-------|
| `src/features/scanner/services/scannerEngine.ts` | **MODIFICAR** | Reemplazar logica de senales con composite |
| `src/actions/scanner.ts` | **MODIFICAR** | Cargar best params de autoresearch_runs |
| `src/features/scanner/types/index.ts` | **MODIFICAR** | Anadir `compositeConfidence`, `activeSignals` |
| `src/features/scanner/components/ScannerDashboard.tsx` | **MODIFICAR** | Mostrar composite confidence + senales activas |

### Funciones a Reusar (sin modificar)

| Funcion | Archivo | Uso |
|---------|---------|-----|
| `precomputeIndicators()` | `signalRegistry.ts` | Pre-calculo de indicadores como Maps |
| `buildContext()` | `signalRegistry.ts` | Construir SignalContext para candle index |
| `generateAdaptiveComposite()` | `signalRegistry.ts` | Composite signal regimen-aware (7 senales) |
| `FULL_SIGNAL_CONFIG` | `signalRegistry.ts` | Preset de 7 senales con pesos calibrados |
| `detectRegime()` | `indicatorEngine.ts` | Clasificacion de regimen |
| `runBacktest()` | `backtestEngine.ts` | Quick backtest de validacion |

---

## Blueprint

### Fase 1: Upgradar scannerEngine.ts
**Objetivo**: Reemplazar logica simplificada con composite system de 7 senales
**Cambios en `scanPair()`**:
1. Importar `precomputeIndicators`, `buildContext`, `generateAdaptiveComposite`, `FULL_SIGNAL_CONFIG`
2. Usar `precomputeIndicators()` para calcular todos los indicadores como Maps
3. Usar `buildContext()` para el ultimo candle
4. Llamar `generateAdaptiveComposite()` en vez de la deteccion manual de EMA cross (eliminar lineas 56-84)
5. Si composite.direction === 'long' -> signal = 'buy', 'short' -> 'sell', 'neutral' -> null
6. Usar `params.stop_loss_pct` y `params.take_profit_pct` en vez de hardcoded 1.5/2.5
7. Incorporar `composite.totalConfidence` en `calculateOpportunityScore()` como factor de peso
8. Retornar `compositeConfidence` y `activeSignals` en el Opportunity
**Validacion**: `pnpm exec tsc --noEmit` pasa

### Fase 2: Cargar params optimizados en server action
**Objetivo**: Usar best params de autoresearch si existen
**Cambios en `src/actions/scanner.ts`**:
1. Query `autoresearch_runs` WHERE status='completed' ORDER BY final_score DESC LIMIT 1
2. Si hay resultado y `best_params` no es null -> merge con DEFAULT_STRATEGY_PARAMS
3. Pasar signal_systems (de best_params o FULL_SIGNAL_CONFIG) al scanMarket
4. Si no hay resultado -> fallback a DEFAULT_STRATEGY_PARAMS + FULL_SIGNAL_CONFIG
**Validacion**: Escaneo usa params optimizados cuando existen en DB

### Fase 3: Actualizar tipos y UI
**Objetivo**: Dashboard muestra datos del composite signal
**Cambios en tipos** (`src/features/scanner/types/index.ts`):
- Anadir `compositeConfidence: number` (0-1) a `Opportunity`
- Anadir `activeSignals: string[]` (ej: ['ema-cross', 'bb-mean-rev'])
**Cambios en UI** (`ScannerDashboard.tsx`):
- Mostrar chips/badges con senales activas en cada OpportunityCard
- Mostrar composite confidence como porcentaje
- Ordenar senales por peso (mas importante primero)
**Validacion**: UI muestra senales activas correctamente

### Fase 4: Verificacion End-to-End
**Objetivo**: Sistema funciona completo
**Validacion**:
- [ ] `pnpm exec tsc --noEmit` = 0 errores
- [ ] `pnpm run build` exitoso
- [ ] Escaneo desde UI retorna oportunidades con composite data
- [ ] Score refleja calidad del composite signal
- [ ] Aprobar oportunidad -> crea estrategia con params correctos

---

## Gotchas

- [ ] `precomputeIndicators()` necesita `signal_systems` en los params — incluir FULL_SIGNAL_CONFIG
- [ ] `buildContext()` necesita candle index (number), no timestamp — usar `candles.length - 1`
- [ ] `best_params` de autoresearch_runs viene como JSONB — no necesita Number() coercion
- [ ] El scanner calcula indicadores directamente — al migrar a precomputeIndicators verificar equivalencia
- [ ] `generateAdaptiveComposite()` necesita ADX precalculado — esta en precomputeIndicators

## Anti-Patrones

- NO crear nuevos indicadores — usar los existentes en signalRegistry
- NO duplicar logica — eliminar deteccion manual de EMA cross, no dejarla como fallback
- NO cambiar el signalRegistry — solo consumirlo desde el scanner
- NO crear archivos nuevos — solo modificar los 4 existentes

---

*PRP pendiente aprobacion. No se ha modificado codigo.*
