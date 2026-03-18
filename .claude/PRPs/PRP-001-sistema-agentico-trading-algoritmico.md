# PRP-001: Sistema Agentico de Trading Algoritmico (AI-First)

**Estado:** EN PROGRESO (Fase 1 completada)
**Fecha:** 2026-03-18
**Enfoque:** AI-First con Human-in-the-Loop

---

## Seccion 1: Vision

| Campo | Descripcion |
|-------|-------------|
| **Objetivo** | Sistema de trading algoritmico donde la IA es el motor central: analiza mercados, genera hipotesis de estrategia, valida con backtesting cientifico y ejecuta — con el humano como supervisor de decisiones criticas. |
| **Por Que** | Los traders humanos pierden por sesgos cognitivos (disposicion, sobreconfianza, manada). Pero la automatizacion ciega tambien falla. La combinacion optima es **IA que propone + Humano que aprueba**. |
| **Diferenciador** | No es solo un backtester con UI. Es un **agente que investiga, propone estrategias, las valida cientificamente y pide aprobacion** antes de operar. |

### Flujo AI-First + Human-in-the-Loop

```
┌─────────────────────────────────────────────────────────────┐
│                    CICLO CONTINUO                            │
│                                                             │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐              │
│  │ AI Agent │───>│ Analisis │───>│ Hipotesis│              │
│  │ Ingesta  │    │ Tecnico  │    │ Estrategia│             │
│  └──────────┘    └──────────┘    └─────┬─────┘             │
│                                        │                    │
│                                        v                    │
│                                  ┌──────────┐              │
│                                  │ Backtest │              │
│                                  │ Cientifico│             │
│                                  └─────┬─────┘             │
│                                        │                    │
│                                        v                    │
│                              ┌─────────────────┐           │
│                              │  HUMAN GATE     │           │
│                              │  ¿Aprobar?      │           │
│                              │  ✅ Si  ❌ No   │           │
│                              └────┬───────┬────┘           │
│                                   │       │                 │
│                              ┌────v──┐ ┌──v────┐           │
│                              │ Paper │ │Ajustar│           │
│                              │Trading│ │Params │           │
│                              └───┬───┘ └───────┘           │
│                                  │                          │
│                                  v                          │
│                          ┌───────────────┐                  │
│                          │  HUMAN GATE   │                  │
│                          │  ¿Go Live?    │                  │
│                          └───────────────┘                  │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Seccion 2: Lo Que Ya Existe (Fase 1 Completada)

### Base de Datos (Supabase - 5 tablas con RLS)
- `profiles` — Usuarios con roles (trader/admin)
- `ohlcv_candles` — Datos historicos OHLCV
- `strategies` — Estrategias con parametros JSON
- `backtest_results` — Metricas estadisticas
- `backtest_trades` — Trades individuales de backtests

### Codigo Backend (TypeScript puro)
- `features/indicators/services/indicatorEngine.ts` — EMA, MACD, RSI, Bollinger Bands
- `features/backtesting/services/backtestEngine.ts` — Motor completo (senales, posiciones, metricas)
- `features/market-data/services/marketDataService.ts` — CRUD de datos OHLCV
- `app/api/market-data/route.ts` — API REST para ingesta
- `actions/strategies.ts` — Server Actions de estrategias

### Lo Que Falta
- Cero UI funcional (dashboard es placeholder)
- Sin ingesta automatica de datos (solo manual via API)
- Sin componente AI (no analiza, no propone, no aprende)
- Sin pipeline de validacion cientifica (In-Sample/Out-of-Sample)
- Sin paper trading ni ejecucion live

---

## Seccion 3: Blueprint (6 Fases)

> Cada fase sigue el BUCLE AGENTICO: Delimitar → Mapear contexto real → Ejecutar → Auto-blindaje → Transicionar

---

### Fase 2: Data Pipeline Inteligente + UI Base
**Objetivo:** Ingesta automatizada de datos de mercado y dashboard funcional.

**Entregables:**
- Pipeline ETL que ingesta datos de multiples fuentes (APIs publicas de crypto/forex)
- Batch upsert optimizado (patron data-pipeline: 200 rows, Load-Summarize-Purge)
- Dashboard con lista de simbolos disponibles, conteo de candles, ultimo dato
- Pagina de estrategias: crear, listar, ver parametros
- Sidebar navegable con todas las secciones

**Skills a usar:** `data-pipeline`, `feature-scaffold`, `server-action`, `harden`

**Validacion:**
- [ ] Pipeline ingesta 10,000+ candles sin error
- [ ] Dashboard muestra datos reales de Supabase
- [ ] CRUD de estrategias funcional end-to-end
- [ ] `pnpm exec tsc --noEmit` = 0 errores
- [ ] `pnpm run build` exitoso

**HUMAN GATE:** Revision del dashboard y aprobacion de UX antes de continuar.

---

### Fase 3: Motor AI de Analisis y Generacion de Estrategias
**Objetivo:** La IA analiza datos de mercado, detecta patrones y propone estrategias completas.

**Entregables:**
- Endpoint AI que recibe un simbolo/timeframe y analiza:
  - Tendencia actual (EMA alignment)
  - Momentum (MACD divergencias, RSI zonas)
  - Volatilidad (Bollinger squeeze/expansion)
  - Volumen anomalo
- AI Strategy Generator: dado un analisis, propone parametros optimizados
  - Sugiere EMA periods, RSI thresholds, stop-loss/take-profit
  - Explica el razonamiento en lenguaje natural
  - Limita a max 7 parametros (anti-overfitting)
- UI de analisis: el usuario selecciona simbolo → ve analisis AI → aprueba/modifica estrategia propuesta

**Skills a usar:** `ai-engine`, `server-action`, `feature-scaffold`

**Validacion:**
- [ ] AI genera analisis coherentes para al menos 5 simbolos
- [ ] Estrategias propuestas tienen parametros dentro de rangos validos
- [ ] El usuario puede modificar parametros antes de guardar
- [ ] Rate limiting activo en endpoints AI

**HUMAN GATE:** El usuario revisa y aprueba cada estrategia propuesta por la IA. Nunca se guarda automaticamente.

---

### Fase 4: Backtesting Cientifico con Visualizacion
**Objetivo:** Validacion estadistica rigurosa con UI interactiva y reportes comprensibles.

**Entregables:**
- Backtesting con split In-Sample (70%) / Out-of-Sample (30%)
- Walk-Forward Analysis (ventanas deslizantes)
- Deteccion automatica de overfitting (comparar IS vs OOS degradation)
- UI de resultados:
  - Equity curve interactiva (chart)
  - Tabla de trades con filtros
  - Metricas resumen: Sharpe, t-stat, win rate, max drawdown, profit factor
  - Semaforo de aprobacion (verde/amarillo/rojo por metrica)
- AI Review: la IA analiza los resultados del backtest y genera un reporte:
  - "Esta estrategia muestra sobreajuste porque IS Sharpe=2.1 pero OOS Sharpe=0.3"
  - "Recomendacion: reducir periodos EMA, ampliar stop-loss"
  - Confianza general (alta/media/baja)

**Skills a usar:** `ai-engine`, `feature-scaffold`, `server-action`, `supabase-patterns`

**Validacion:**
- [ ] Backtest completo en <5s para 10,000 candles
- [ ] Metricas IS y OOS calculadas separadamente
- [ ] AI review genera analisis util y accionable
- [ ] Visualizaciones renderizan correctamente
- [ ] t-statistic calculado correctamente (verificar con caso manual)

**HUMAN GATE:** El usuario revisa el reporte AI + metricas. Solo estrategias aprobadas avanzan a paper trading.

**KPIs de aprobacion (semaforo verde):**

| Metrica | Verde | Amarillo | Rojo |
|---------|-------|----------|------|
| t-statistic OOS | > 3.0 | 2.0 - 3.0 | < 2.0 |
| Win rate | > 55% | 45% - 55% | < 45% |
| Sharpe ratio | > 1.5 | 1.0 - 1.5 | < 1.0 |
| Max drawdown | < 15% | 15% - 25% | > 25% |
| Profit factor | > 1.5 | 1.0 - 1.5 | < 1.0 |
| IS vs OOS degradation | < 20% | 20% - 40% | > 40% |

---

### Fase 5: Paper Trading + Monitoreo en Tiempo Real
**Objetivo:** Validar la estrategia aprobada en condiciones de mercado real sin riesgo financiero.

**Entregables:**
- Conexion a feed de precios en tiempo real (WebSocket o polling)
- Motor de ejecucion paper: genera ordenes simuladas basadas en senales del motor
- Dashboard de monitoreo en vivo:
  - Precio actual vs senales activas
  - Posiciones abiertas (paper) con P&L en tiempo real
  - Log de ordenes ejecutadas
  - Alertas cuando la estrategia genera senal
- AI Monitor: supervisa el rendimiento paper vs backtest esperado
  - Alerta si hay divergencia significativa (regime change detection)
  - Sugiere pausa si drawdown excede umbral

**Skills a usar:** `data-pipeline`, `feature-scaffold`, `server-action`, `ai-engine`

**Validacion:**
- [ ] Paper trading ejecuta ordenes correctamente por >7 dias
- [ ] Metricas paper correlacionan con backtest OOS (±20%)
- [ ] Alertas de divergencia funcionan
- [ ] Dashboard muestra datos en tiempo real sin lag perceptible

**HUMAN GATE:** El usuario decide si la estrategia pasa a live despues de minimo 7 dias de paper trading exitoso. La IA recomienda pero NUNCA decide ir a live.

---

### Fase 6: Ejecucion Live + Risk Management
**Objetivo:** Ejecucion automatizada con gestion de riesgo dinamica y kill switch humano.

**Entregables:**
- Integracion con broker/exchange API (configurable)
- Risk Manager automatico:
  - Position sizing dinamico (Kelly criterion o fraccion fija)
  - Max drawdown diario → pausa automatica
  - Max posiciones abiertas simultaneas
  - Correlacion entre posiciones (no concentrar riesgo)
- Kill Switch: boton de emergencia que cierra todas las posiciones y pausa el sistema
- Dashboard ejecutivo:
  - P&L acumulado real
  - Comparativa paper vs live
  - Estado del sistema (activo/pausado/emergencia)
- AI Advisor: reporte diario con analisis de rendimiento y recomendaciones

**Skills a usar:** `harden`, `server-action`, `ai-engine`, `docker-deploy`

**Validacion:**
- [ ] Ordenes se ejecutan en <100ms
- [ ] Kill switch funciona instantaneamente
- [ ] Risk manager pausa correctamente al exceder limites
- [ ] Notificaciones al usuario en eventos criticos
- [ ] Security audit: API keys encriptadas, rate limiting, auth en todos los endpoints

**HUMAN GATE:** El humano SIEMPRE tiene el control final. El sistema puede pausarse solo (risk manager), pero NUNCA puede reactivarse solo. Toda reactivacion requiere aprobacion humana explicita.

---

## Seccion 4: Stack de Skills por Fase

| Fase | Skills Primarios | Skills Soporte |
|------|-----------------|----------------|
| 2 - Data Pipeline + UI | `data-pipeline`, `feature-scaffold` | `server-action`, `harden` |
| 3 - Motor AI | `ai-engine`, `feature-scaffold` | `server-action` |
| 4 - Backtesting | `ai-engine`, `supabase-patterns` | `feature-scaffold`, `server-action` |
| 5 - Paper Trading | `data-pipeline`, `ai-engine` | `feature-scaffold`, `server-action` |
| 6 - Live Execution | `harden`, `ai-engine` | `server-action`, `docker-deploy` |

**Transversales (todas las fases):** `xavier` (orquestacion), `delegate-flash` (tareas mecanicas), `playwright-cli` (testing visual)

---

## Seccion 5: Human-in-the-Loop Matrix

| Evento | Accion AI | Requiere Aprobacion Humana |
|--------|-----------|---------------------------|
| Proponer nueva estrategia | AI genera parametros + razonamiento | **SI** — el usuario revisa y aprueba/modifica |
| Ejecutar backtest | AI lanza automaticamente | NO — es analisis, no accion |
| Interpretar resultados backtest | AI genera reporte + recomendacion | **SI** — el usuario decide si aprobar |
| Activar paper trading | AI recomienda | **SI** — el usuario activa manualmente |
| Pasar de paper a live | AI recomienda despues de 7+ dias | **SI** — decision humana explicita |
| Pausar por risk management | AI pausa automaticamente | NO — seguridad no espera (pero notifica) |
| Reactivar despues de pausa | AI no puede reactivar | **SI** — solo el humano reactiva |
| Ajustar parametros en vivo | AI sugiere ajustes | **SI** — el usuario aprueba cada cambio |
| Kill switch | Humano o AI (en emergencia) | NO — seguridad primero, preguntar despues |

**Principio fundamental:** La IA tiene autonomia para PROTEGER (pausar, alertar, cerrar en emergencia) pero NUNCA para ARRIESGAR (activar, incrementar posicion, pasar a live).

---

## Seccion 6: Gotchas y Anti-Patrones

### Gotchas Criticas
- [ ] Max 5-7 parametros por estrategia (evitar overfitting)
- [ ] Datos limpios: sin sesgo de supervivencia ni look-ahead bias
- [ ] Ejecucion de ordenes en milisegundos
- [ ] PostgREST trunca a 1000 rows silenciosamente — paginar siempre
- [ ] `generateObject` falla con Gemini en prompts >5000 chars — usar `generateText` + JSON.parse
- [ ] NUNCA hardcodear valores de indicadores o parametros de riesgo
- [ ] Rate limiting en TODOS los endpoints AI (10 req/min por user)

### Anti-Patrones
- **NO** heuristicas basadas en intuicion — todo empirico y programable
- **NO** ignorar paper trading despues de backtest exitoso
- **NO** permitir que la IA active trading live autonomamente
- **NO** ignorar errores de TypeScript ("funciona en dev" no es excusa)
- **NO** crear tablas sin RLS en la misma migracion
- **NO** usar `npm` (solo `pnpm`)

---

## Seccion 7: Aprendizajes (Auto-Blindaje)

*Esta seccion CRECE con cada error encontrado durante la implementacion.*

### Fase 1 (Completada)
- Supabase necesita tabla `profiles` como prerequisito (FK de `strategies`)
- Batch SQL via Management API funciona ejecutando en partes separadas
- Los tipos de indicadores deben exportarse desde su propia feature, no desde types/database.ts

### Fase 2 (Completada)
- Binance API publica no requiere API key para klines
- Batch upsert de 200 rows es el sweet spot para Supabase free tier
- Rate limiting in-memory es suficiente para MVP (patron harden)

### Fase 3 (Completada)
- Vercel AI SDK v6 usa `temperature` pero NO `maxTokens` (removido)
- Provider routing Google > OpenRouter > OpenAI funciona con createGoogleGenerativeAI
- generateText + JSON.parse + Zod es mas robusto que generateObject para Gemini
- Human Gate debe ser un boton de aprobacion explicito, no automatico

### Fase 4 (Completada)
- IS/OOS split de 70/30 necesita minimo 100 candles
- Walk-Forward necesita minimo 350 candles (5 ventanas x 70 minimo)
- AI Review es non-blocking: si falla, el backtest sigue sin review
- El semaforo agrega scores: green=2, yellow=1, red=0 para un veredicto overall

### Fase 5 (Completada)
- Paper trading session-based con tick engine
- AI Monitor detecta divergencia paper vs backtest (rule-based + AI)
- Alertas con 3 niveles (info/warning/critical) + shouldPause flag
- Human Gate: AI recomienda pausar pero nunca detiene automaticamente
- Auto-refresh de precios cada 15s en dashboard

### Fase 6 (Completada)
- Exchange client abstraction (Binance real + simulador para testing)
- Signed requests con HMAC-SHA256 para API de Binance
- Risk Manager con 6 checks: position size, daily DD, total DD, open positions, daily trades, loss streak
- Kill Switch: cierra todas las posiciones y marca sesion como emergency
- Live execution engine: Signal → Risk Check → Exchange Order → DB Record
- calculatePositionSize con fixed fractional method
- AI Advisor: reporte diario con metricas, comparacion paper vs live, analisis AI
- Human Gate: solo admin puede acceder a live trading; reactivacion siempre requiere humano
- Migracion SQL con RLS para live_sessions y live_trades

---

*PRP-001 v2.0 — AI-First con Human-in-the-Loop*
*Todas las 6 fases completadas.*
