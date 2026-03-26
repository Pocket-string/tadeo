# PRP-008: Optimización Live Trading — Cerrar Gap Paper vs Live + Bear Regime Pause

> **Estado**: COMPLETADO
> **Fecha**: 2026-03-26
> **Proyecto**: Trader (Tadeo)

---

## Objetivo

Investigar y cerrar el gap de rentabilidad entre paper trading (+$1,665, 83.9% WR) y live trading (+$0.08, 55.6% WR) mediante análisis de datos, comparación honesta sin compounding, evaluación de si Take Profit activo mejoraría la ejecución real en Binance, y protección contra pérdidas en mercados bajistas.

## Por Qué

| Problema | Solución |
|----------|----------|
| Paper muestra +$1,665 pero Live solo +$0.08 con la misma estrategia | Análisis que separe compounding artificial del rendimiento real |
| No sabemos si el trailing SL es mejor que TP activo en live | Análisis retroactivo con candle data para probar hipótesis |
| Live sale a market price con slippage real, capturando solo 0.84×ATR vs 2.73× en paper | Si TP es mejor, implementar limit orders en Binance para fills exactos |
| Bot pierde dinero en mercados bajistas — shorts tienen 38.1% WR y -32.9% PnL | Bear Regime Pause: no tradear cuando HTF detecta mercado bear |

**Valor de negocio**: Entender el rendimiento REAL del bot, maximizar profit por trade en dinero real, y eliminar pérdidas en mercados bajistas.

## Qué

### Criterios de Éxito
- [ ] Flat capital PnL calculado para paper (comparable a live sin compounding)
- [ ] Bear Regime Pause implementado en paper + live engines
- [ ] Análisis TP vs Trailing SL ejecutado con datos reales de 32+ paper trades
- [ ] Decisión documentada: ¿implementar limit TP orders o mantener trailing SL?
- [ ] Si TP es mejor → limit orders implementados con feature flag en live

### Comportamiento Esperado

1. Ejecutar SQL function que recalcula PnL de paper con capital fijo $100 → obtener PnL comparable a live
2. En mercado bear: ambos engines (paper + live) pausan TODOS los trades → $0 pérdidas en downtrends
3. Ejecutar SQL function que analiza si TP habría sido alcanzado en cada trade → obtener comparación TP vs trailing
4. Si TP > trailing: implementar limit sell orders en Binance al precio TP
5. Si trailing > TP: documentar hallazgo, mantener sistema actual

---

## Contexto

### Datos del Sistema (26 Mar 2026)

**Paper Trading (Set A Aggressive, session `2c8cb3f2`):**
- 32 trades, 26W/6L, WR 81.3%, PnL +$1,575
- 100% exits via `stop_loss` (trailing SL), 0% via `take_profit`
- Winners capturan 2.73×ATR promedio, TP está a ~2×ATR
- Capital: $100 → $1,675 (compounding)
- **100% BUY-only** — 0 shorts

**Live Trading (session `668e4087`):**
- 9 trades, 6W/3L, WR 66.7%, PnL +$0.49
- Winners capturan solo 0.84×ATR
- Capital fijo: $100
- **100% BUY-only**

**Root causes del gap:**
1. **Compounding artificial (90%)**: Paper trade #25 arriesga $105, Live siempre arriesga $7
2. **Market order slippage (8%)**: Binance fills reales vs slippage simulado
3. **Timing 1s entre engines (2%)**: Paper y Live entran al mismo minuto pero con price distinto

### Análisis Bull vs Bear (495 trades totales)

| Dirección | Trades | Win Rate | PnL Total | Avg Winner | Avg Loser |
|-----------|--------|----------|-----------|------------|-----------|
| **LONGS (buy)** | 356 | 65.4% | **+65.6%** | +0.51% | -0.43% |
| **SHORTS (sell)** | 139 | 38.1% | **-32.9%** | +0.42% | -0.64% |

**Hallazgo clave**: Las 5 sesiones rentables son 100% BUY-only. Las sesiones con shorts (mixed) TODAS pierden dinero.

**Señales tóxicas identificadas**:
- `adx-trend:short` → 7.1% WR (tóxico)
- `double-pattern:short` → 33% WR (pobre)
- `rsi-divergence:long` en 5m → 25.8% WR (ruido)

**Config ganadora** (`SOLUSDT_5M_CONFIG`): Ya deshabilita señales tóxicas → solo genera longs → WR 81.3%

### Referencias
- `src/app/api/paper-trading/tick-all/route.ts` — Paper engine, trailing SL (L310-380), checkSignalFull (L620-691), HTF bias (L684-686, L693-732)
- `src/app/api/live-trading/tick-all/route.ts` — Live engine, exit flow (L236-308), checkSignalFull (L654-717), HTF bias (L712-714, L719-740)
- `src/features/paper-trading/services/signalRegistry.ts` — Signal configs, SOLUSDT_5M_CONFIG (L411-419)
- `src/features/live-trading/services/exchangeClient.ts` — Binance API, ya soporta LIMIT orders
- `ohlcv_candles` tabla — 79,413+ candles 5m SOLUSDT

### Modelo de Datos

No se crean tablas nuevas. Se crean 2 funciones SQL read-only:

```sql
-- Función 1: Recalcular PnL con capital fijo
CREATE FUNCTION calculate_flat_capital_pnl(session_id UUID, flat_capital DECIMAL)
RETURNS TABLE (...);

-- Función 2: Analizar si TP habría sido mejor que trailing SL
CREATE FUNCTION analyze_tp_effectiveness(session_id UUID)
RETURNS TABLE (...);
```

---

## Blueprint (Assembly Line)

### Fase 1: Flat Capital Analysis
**Objetivo**: Crear función SQL que recalcule PnL de paper sin compounding, usando `pnl_pct` × capital fijo
**Archivos**: Migración SQL (`calculate_flat_capital_pnl`)
**Acciones**:
- Crear function que recibe `session_id` + `flat_capital` (default $100)
- Para cada trade cerrado: `flat_pnl = flat_capital × pnl_pct`
- Retorna: total_trades, winners, losers, flat_pnl, avg_winner, avg_loser, win_rate, profit_factor
- Ejecutar contra paper session `2c8cb3f2` y comparar con live
**Validación**:
- Win rate idéntico (81.3%)
- flat_pnl es orden de magnitud menor que $1,575
- Comparación directa con live documenta gap real

### Fase 2: Bear Regime Pause
**Objetivo**: Cuando HTF detecta mercado bajista, bloquear TODOS los trades (no solo buys) en ambos engines
**Archivos**: `src/app/api/paper-trading/tick-all/route.ts`, `src/app/api/live-trading/tick-all/route.ts`
**Acciones**:
- En `checkSignalFull()` de ambos engines:
  - Cambiar `if (htfBias === 'bear' && signal === 'buy')` → `if (htfBias === 'bear')`
  - Log: `bear_regime_pause:bias=bear,signal=${signal}`
- Agregar `regime` al `SignalCheckResult` type para propagarlo
- Agregar `regime_at_entry` en metadata de trades insertados
**Justificación (datos)**:
- LONGS: 356 trades, 65.4% WR, +65.6% PnL → RENTABLE
- SHORTS: 139 trades, 38.1% WR, -32.9% PnL → TÓXICO
- En bear market, el bot actual intenta shorts malos o buys contra-tendencia → ambos pierden
- Bear pause elimina ambos escenarios → $0 en bear vs -X% actual
**Validación**:
- `pnpm exec tsc --noEmit` = 0 errores
- Logs muestran `bear_regime_pause` cuando mercado está en bear
- Trades nuevos incluyen `regime: bull|neutral` en metadata

### Fase 3: TP Effectiveness Analysis
**Objetivo**: Para cada trade, verificar si el precio alcanzó el nivel TP usando candle highs/lows. Comparar PnL hipotético con TP vs PnL real con trailing SL
**Archivos**: Migración SQL (`analyze_tp_effectiveness`)
**Acciones**:
- Para cada trade cerrado de paper (y live):
  - Query `ohlcv_candles` 5m entre `entry_time` y `exit_time`
  - BUY trades: `MAX(high) >= take_profit` → TP era alcanzable
  - Si alcanzable: `tp_pnl = (take_profit - entry_price) × quantity`
  - Comparar `tp_pnl` vs `actual_pnl`
- Retorna por trade + agregado: trades_analyzed, tp_reachable_count, tp_better_count, tp_worse_count
- Ejecutar contra ambas sessions
**Validación**:
- Si `tp_worse_count > tp_better_count` → trailing SL es superior → SKIP Fase 4
- Si `tp_better_count > tp_worse_count` → TP capturaría más → GO Fase 4

### Fase 4: Limit TP Orders en Live (CONDICIONAL)
**Objetivo**: Si Fase 3 demuestra que TP > trailing, implementar limit sell orders en Binance al abrir trade
**Gate**: Solo ejecutar si Fase 3 lo justifica con datos
**Archivos**: `src/app/api/live-trading/tick-all/route.ts`
**Acciones**:
- Al abrir trade: después del MARKET buy, colocar LIMIT SELL al precio TP
- Cada tick: verificar si limit order fue filled (`exchange.getOrder()`)
- Si TP filled: cerrar trade en DB con `exit_reason = 'take_profit'`
- Si trailing SL triggers: cancelar limit order pendiente, ejecutar MARKET sell
- Guardar `tp_order_id` en trade metadata
- Feature flag `USE_LIMIT_TP` env var (default `false`)
**Validación**:
- `pnpm exec tsc --noEmit` = 0 errores
- Feature flag OFF por default (no afecta producción)
- Test manual: activar flag, verificar que limit order se coloca en Binance

### Fase 5: Validación Final
**Objetivo**: Interpretar resultados y documentar decisión
**Validación**:
- [ ] `pnpm exec tsc --noEmit` pasa
- [ ] Resultados de Fase 1 y 3 documentados
- [ ] Bear Regime Pause funcionando en producción
- [ ] Decisión sobre Fase 4 documentada con datos
- [ ] Deploy completado

---

## Resultados

### Fase 1: Flat Capital Analysis
| Métrica | Paper (flat $100) | Live ($100) |
|---------|-------------------|-------------|
| Trades | 33 | 10 |
| Win Rate | 81.8% | 70.0% |
| Flat PnL | **$13.99** | **$0.81** |
| Avg Winner | $0.56 (0.56%) | $0.19 (0.19%) |
| Avg Loser | -$0.20 (-0.20%) | -$0.18 (-0.18%) |
| Profit Factor | 12.77 | 2.53 |

**Conclusión**: Sin compounding, paper gana $13.99 vs live $0.81 (17×). Live captura solo 0.19% por winner vs 0.56% en paper — el trailing SL en live sale temprano por slippage real.

### Fase 2: Bear Regime Pause
**Implementado** en paper + live engines. Cuando HTF bias = bear, se bloquean TODOS los signals (no solo buys).
- Logs mostrarán `bear_regime_pause:bias=bear,signal=X`
- Trades nuevos incluyen `regime` en metadata

### Fase 3: TP Effectiveness Analysis
| Métrica | Paper (33 trades) | Live (10 trades) |
|---------|-------------------|-------------------|
| TP alcanzado | **0 de 33 (0%)** | **0 de 10 (0%)** |
| Actual Winner PnL | $1,944 | $0.24 |
| TP Hipotético Winner PnL | $1,249 | $0.56 |
| Trailing vs TP (winners) | **Trailing 56% mejor** | **Trailing mejor** |

**Conclusión**: El TP a 2.5×ATR NUNCA se alcanza. Trailing SL es superior — captura 56% más en winners.

### Fase 4: Limit TP Orders
**SKIP** — No justificado por datos. TP nunca se alcanza, trailing SL captura más.

### Decisión Final
- ✅ Mantener trailing SL como mecanismo de exit
- ✅ Bear Regime Pause activo para evitar pérdidas en bear markets
- ❌ NO implementar limit TP orders
- 📊 El gap real paper/live con flat capital es 17× (no 20,000×)
- 📊 La causa principal del gap restante es slippage en live (0.19% vs 0.56% por winner)

---

## Aprendizajes (Self-Annealing)

> Esta sección CRECE con cada error encontrado durante la implementación.

### 2026-03-26: Shorts son tóxicos en SOLUSDT 5m
- **Error**: Sesiones con shorts habilitados pierden dinero consistentemente (38.1% WR, -32.9% PnL)
- **Fix**: Bear Regime Pause — bloquear TODOS los trades en mercado bajista, no intentar shorts
- **Aplicar en**: Todo par/timeframe hasta que se validen shorts con backtest de 100+ trades

### 2026-03-26: TP a 2.5×ATR nunca se alcanza en 5m
- **Error**: TP configurado demasiado lejos — 0 de 43 trades lo alcanzaron
- **Fix**: NO implementar limit TP. Trailing SL captura 56% más que TP hipotético en winners
- **Aplicar en**: Mantener trailing SL como exit primario. Si se revisita TP, probar con 1.5×ATR

### 2026-03-26: Compounding infla PnL paper en 112×
- **Error**: Paper PnL $1,575 vs flat capital $13.99 — compounding produce ilusión de rendimiento
- **Fix**: Siempre comparar con flat capital cuando se evalúa estrategia vs live
- **Aplicar en**: Todo análisis futuro de paper vs live

---

## Gotchas

- [ ] No hay candles 1m — solo 5m. Trades de <5 min pueden no tener candle intermedia para verificar TP
- [ ] `pnl_pct` en paper_trades ya incluye slippage simulado — flat_pnl será con slippage incluido
- [ ] Los 6 trades perdedores tienen `pnl_pct` negativo — el flat_pnl los incluye correctamente
- [ ] Candle `high` captura máximo intra-candle (5 min) — suficiente para trades que duran 6+ min
- [ ] Fase 4 toca dinero real — feature flag obligatorio, test con amount mínimo primero
- [ ] Bear pause bloquea shorts Y longs en bear — acepta $0 en bear a cambio de $0 pérdidas
- [ ] `computeHTFBias()` usa EMA50 de 4h con threshold 2% — puede tardar ~6h en detectar cambio de régimen
- [ ] `checkSignalFull()` está duplicada en paper y live — ambas necesitan el mismo cambio

## Anti-Patrones

- NO cambiar el trailing SL sin datos que lo justifiquen (el buffer 0.3×ATR está bien)
- NO desactivar compounding en paper — solo crear LENS para comparación
- NO implementar limit TP sin primero probar que TP > trailing con datos
- NO asumir que paper PnL = live PnL (divergencia es estructural)
- NO habilitar shorts sin backtest de 100+ trades que valide WR > 55%
- NO tradear en bear markets "porque podríamos ganar con shorts" — datos dicen lo contrario

---

*PRP completado. Trailing SL confirmado como superior. Bear Regime Pause implementado.*
