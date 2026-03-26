# PRP-007: Live Trading — De Paper a Dinero Real en Binance

> **Estado**: PENDIENTE
> **Fecha**: 2026-03-26
> **Proyecto**: Trader (Tadeo)

---

## Objetivo

Habilitar live trading en Binance Spot copiando la sesion paper SOL-5m-Optimized Aggressive (+225% ROI, 87.5% WR, PF 30), cerrando los gaps de paridad entre paper y live (breakeven, EMA trailing, Binance compliance).

## Por Que

| Problema | Solucion |
|----------|----------|
| Paper trading valida senales pero no genera ganancias reales | Live trading ejecuta ordenes reales en Binance |
| Estrategia demostro 87.5% WR con PF 30+ en 16 trades | Momento ideal para ir live con capital controlado |

**Valor de negocio**: Primera monetizacion real del robot de trading algoritmico.

## Que

### Criterios de Exito
- [ ] Sesion live activa ejecutando ordenes reales en Binance SOLUSDT spot
- [ ] Breakeven + EMA Trailing funcionando en live (paridad con paper)
- [ ] Kill switch funcional (emergency stop automatico a -15% DD)
- [ ] Balance USDC verificado antes de primer trade
- [ ] Logs de cada orden con exchange_order_id en live_agent_log

### Comportamiento Esperado
1. Cron cada 5 min llama `/api/live-trading/tick-all`
2. Engine genera senal (misma logica que paper)
3. Risk check valida: drawdown, posiciones, loss streak
4. Si aprobado → orden MARKET en Binance → fill real
5. Posicion abierta: breakeven a 0.5x ATR → EMA trailing
6. SL/TP hit → orden MARKET de cierre → update stats
7. Si drawdown > 15% → KILL SWITCH automatico

---

## Contexto

### Infraestructura Existente (~80% lista)
- `src/features/live-trading/services/exchangeClient.ts` — Binance API client
- `src/features/live-trading/services/liveEngine.ts` — Session lifecycle
- `src/features/live-trading/services/riskManager.ts` — Risk checks + kill switch
- `src/app/api/live-trading/tick-all/route.ts` — Cron con signal engine + circuit breakers
- `src/app/api/cron/tick/route.ts` — Unified cron (paper + live en paralelo)
- DB: `live_sessions` + `live_trades` tables con RLS
- UI: `LiveTradingDashboard` component

### Gaps a Cerrar
1. Breakeven mechanism (NO en live tick-all)
2. EMA Trailing Stop (NO en live tick-all, solo ATR basico)
3. `risk_tier` column en `live_sessions` (solo en paper_sessions)
4. `metadata` JSONB en `live_trades` (entry_atr, breakeven_hit)
5. `live_agent_log` table (no existe en migraciones)
6. Binance LOT_SIZE/MIN_NOTIONAL compliance
7. Signal cache key sin strategy_id (cross-contamination)
8. BINANCE_API_KEY no configurada en Dokploy

---

## Blueprint (Assembly Line)

### Fase 1: Migracion DB
**Objetivo**: Schema completo para live trading
**Validacion**: Columnas y tabla visibles via list_tables

### Fase 2: Breakeven + EMA Trailing en Live tick-all
**Objetivo**: Paridad completa con paper en gestion de posiciones
**Validacion**: TypeScript compila, logica identica a paper tick-all

### Fase 3: Binance Order Compliance
**Objetivo**: Ordenes validas (LOT_SIZE, MIN_NOTIONAL, PRICE_FILTER)
**Validacion**: Orden simulada pasa validaciones

### Fase 4: Environment + Crear Sesion
**Objetivo**: API keys configuradas, sesion live creada con balance real
**Validacion**: Session visible en UI, balance confirmado

### Fase 5: Deploy + Validacion E2E
**Objetivo**: Sistema live operando
**Validacion**: tsc clean, primer tick logueado, exchange_order_id real

---

## Seguridad

### Kill Switch (ya implementado)
- Total drawdown > 15% → emergency (requiere humano)
- Daily drawdown > 5% → paused
- 3 perdidas consecutivas → cooldown 1 hora

### Recomendacion de capital
- Empezar con maximo 15% del USDC total en Binance
- Aggressive tier = 7% riesgo por trade
- Con $100 capital, cada trade arriesga ~$7

---

## Gotchas
- [ ] Binance rechaza ordenes con quantity no redondeada al stepSize
- [ ] SOLUSDT spot = solo BUY (no short selling)
- [ ] El cron tick ya llama live + paper (no necesita nuevo cron)
- [ ] Live trades NO simulan slippage — fill real del exchange
- [ ] API keys con IP whitelist + trade-only permissions

## Aprendizajes
> (Se llenara durante implementacion)
