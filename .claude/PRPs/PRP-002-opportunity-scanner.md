# PRP-002: Opportunity Scanner — Sistema Autónomo de Oportunidades

## Objetivo
Convertir la plataforma de "el usuario opera manualmente cada paso" a **"el sistema escanea, analiza, rankea y presenta las mejores oportunidades — el usuario solo aprueba"**.

El usuario ahorra 95% del tiempo. Solo toma la decisión final.

---

## Problema Actual
1. **Proceso manual**: Ingestar → Analizar → Crear estrategia → Backtest → Scientific → Paper → Live (6+ pasos manuales)
2. **Un par a la vez**: Solo puede analizar 1 par/timeframe por sesión
3. **Stops fijos**: SL/TP son porcentajes estáticos, no se adaptan a volatilidad
4. **Sin detección de régimen**: Opera igual en tendencia fuerte que en mercado lateral (chop)
5. **Sin ranking**: No hay forma de comparar oportunidades entre pares

## Solución
**Opportunity Scanner**: Un servicio que automáticamente:
1. Escanea N pares × M timeframes
2. Calcula indicadores + detecta régimen de mercado
3. Genera señales con stops dinámicos (ATR-based)
4. Rankea oportunidades por calidad (score 0-100)
5. Presenta al usuario solo las mejores (score > 70)
6. Usuario aprueba → backtest científico → paper → live

---

## Fases de Implementación

### FASE 1: ATR + Dynamic Stops (Motor mejorado)
**Archivos**: `indicatorEngine.ts`, `backtestEngine.ts`, `paperEngine.ts`

**Cambios**:
- Agregar indicador **ATR(14)** al engine de indicadores
- Reemplazar stops fijos por **ATR-based dynamic stops**:
  - Stop Loss = `entry ± ATR * sl_multiplier` (default 1.5x ATR)
  - Take Profit = `entry ± ATR * tp_multiplier` (default 2.5x ATR)
  - Risk:Reward ratio mínimo 1:1.67
- Agregar **trailing stop** opcional: mueve SL a breakeven cuando price alcanza 1x ATR en profit
- Position sizing basado en ATR: `risk_amount / (ATR * sl_multiplier)` = quantity

**Impacto**: Stops se adaptan a la volatilidad real del mercado. En BTC con ATR=$500, SL=$750. En DOGE con ATR=$0.003, SL=$0.0045.

### FASE 2: Multi-Pair Scanner
**Archivos nuevos**: `src/features/scanner/services/scannerEngine.ts`, `src/features/scanner/types/index.ts`

**Comportamiento**:
```
scanMarket(pairs[], timeframes[]) → Opportunity[]
  Para cada par × timeframe:
    1. Fetch últimas 200 candles
    2. Calcular indicadores (EMA, MACD, RSI, BB, ATR)
    3. Detectar señal actual (buy/sell/none)
    4. Calcular score de oportunidad
    5. Si score > threshold → agregar a resultados
  Ordenar por score DESC
  Retornar top N
```

**Pares default**: BTCUSDT, ETHUSDT, SOLUSDT, BNBUSDT, XRPUSDT, DOGEUSDT, ADAUSDT, AVAXUSDT
**Timeframes default**: 1h, 4h

### FASE 3: Regime Detection
**Archivo**: `indicatorEngine.ts` (extensión)

**Regímenes de mercado**:
| Régimen | Detección | Trading |
|---------|-----------|---------|
| **Trending** | ADX > 25 + EMA slope consistente | ✅ Trade with trend |
| **Ranging** | ADX < 20 + BB squeeze (width < avg) | ⚠️ BB bounces only |
| **Volatile** | ATR > 2x avg ATR | ❌ Skip (too risky) |
| **Choppy** | ADX < 20 + whipsaws (3+ EMA crosses in 20 candles) | ❌ Skip |

**ADX (Average Directional Index)**:
- Mide fuerza de tendencia (no dirección)
- ADX > 25 = tendencia fuerte → EMA crossover signals válidas
- ADX < 20 = sin tendencia → EMA crossover genera whipsaws

**Impacto**: Filtra 60-70% de señales falsas al no operar en mercados sin tendencia.

### FASE 4: Opportunity Score + Dashboard
**Score de Oportunidad (0-100)**:
```
score = (
  trend_score * 0.30 +      // ADX strength + EMA alignment
  momentum_score * 0.25 +   // RSI positioning + MACD histogram
  volatility_score * 0.20 + // ATR regime (goldilocks zone)
  volume_score * 0.15 +     // Volume vs 20-period avg
  rr_score * 0.10           // Risk:Reward ratio
)
```

**Dashboard UI** (`/scanner` page):
- Tabla de oportunidades rankeadas
- Semáforo visual por oportunidad
- Botón "Aprobar" → ejecuta backtest científico automático
- Si pasa → botón "Paper Trade" → si pasa → botón "Go Live"
- Tiempo estimado: 30 segundos de decisión del usuario

### FASE 5: Validación con Playwright
- Ingestar 6 meses de data para 8 pares
- Ejecutar scanner
- Tomar top 3 oportunidades
- Correr scientific backtest en cada una
- Iterar parámetros hasta encontrar ≥1 con semáforo VERDE
- Documentar la estrategia ganadora

---

## Métricas de Éxito
- [ ] Scanner ejecuta en < 30 segundos para 8 pares × 2 timeframes
- [ ] Al menos 1 oportunidad con score > 70 en mercado actual
- [ ] Scientific backtest APROBADO (semáforo verde) en al menos 1 estrategia
- [ ] Walk-Forward consistency > 60%
- [ ] Max drawdown < 15% en OOS
- [ ] El usuario puede ir de "abrir app" a "aprobar trade" en < 2 minutos

---

## Riesgos y Mitigaciones
| Riesgo | Mitigación |
|--------|------------|
| Overfitting al optimizar | Walk-Forward + IS/OOS obligatorio |
| Señales en mercado lateral | Regime detection filtra choppy markets |
| Capital insuficiente ($10) | Paper trade primero, validar antes de escalar |
| Latencia API Binance | Cache de precios, retry con backoff |
| AI hallucination en parámetros | Zod validation + ranges estrictos (ya implementado) |

---

## No Hacer
- NO agregar más indicadores por agregar (KISS)
- NO hacer position sizing agresivo (Kelly requiere 1000+ trades de muestra)
- NO automatizar la decisión final (siempre HUMAN GATE)
- NO operar en más de 3 pares simultáneamente con $10
- NO sacrificar el kill switch ni los límites de drawdown
