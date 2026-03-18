# BUSINESS_LOGIC.md - Sistema Agentico de Trading Algoritmico

> Generado por SaaS Factory | Fecha: 2026-03-17

## 1. Problema de Negocio

**Dolor:** Los traders humanos toman decisiones emocionales influenciadas por sesgos cognitivos (efecto de disposicion, exceso de confianza, comportamiento de manada), lo que resulta en perdidas sistematicas y falta de consistencia operativa.

**Costo actual:**
- Decisiones impulsivas que ignoran reglas empiricas
- Imposibilidad de operar 24/7 sin fatiga
- Falta de validacion estadistica de estrategias antes de ejecutarlas
- Ejecucion lenta de ordenes (segundos vs milisegundos)

## 2. Solucion

**Propuesta de valor:** Un pipeline end-to-end de trading algoritmico que ingesta datos historicos, genera senales basadas en indicadores tecnicos, valida estrategias con backtesting cientifico y ejecuta ordenes de forma automatizada y desapasionada.

**Flujo principal (Happy Path):**
1. Sistema ingesta datos OHLCV (Open, High, Low, Close, Volume) historicos
2. Motor de indicadores calcula EMA, MACD, RSI, Bandas de Bollinger
3. Generador de senales detecta confluencia de indicadores → senal BUY/SELL
4. Backtest valida la estrategia con datos In-Sample y Out-of-Sample
5. Si t-statistic > 3.0 → estrategia aprobada para paper trading
6. Paper trading valida en tiempo real sin riesgo
7. Si paper trading exitoso → ejecucion en vivo con gestion de riesgo

## 3. Usuario Objetivo

**Roles:**
- **Trader**: Configura estrategias, revisa senales, monitorea rendimiento
- **Admin**: Gestiona usuarios, acceso a ejecucion en vivo

**Contexto:** Traders individuales o equipos pequenos que buscan sistematizar su operativa y eliminar el componente emocional.

## 4. Arquitectura de Datos

**Input:**
- Datos historicos OHLCV (multiples timeframes: 1m, 5m, 15m, 1h, 4h, 1d)
- Parametros de estrategia (periodos EMA, RSI, MACD, etc.)
- Configuracion de riesgo (stop-loss %, take-profit %)

**Output:**
- Senales de trading (BUY/SELL con nivel de confianza)
- Resultados de backtesting (win rate, Sharpe ratio, t-statistic, drawdown)
- Ordenes ejecutadas (paper y live)
- Dashboard de rendimiento en tiempo real

**Storage (Supabase tables):**

```sql
-- Ya existe
profiles (id, email, full_name, avatar_url, role, created_at, updated_at)

-- Por crear (Fase 1)
ohlcv_candles (
  id uuid primary key,
  symbol text not null,
  timeframe text not null,
  timestamp timestamptz not null,
  open decimal not null,
  high decimal not null,
  low decimal not null,
  close decimal not null,
  volume decimal not null,
  created_at timestamptz default now(),
  UNIQUE(symbol, timeframe, timestamp)
)

-- Por crear (Fase 2)
strategies (
  id uuid primary key,
  user_id uuid references profiles(id),
  name text not null,
  description text,
  status text default 'draft',
  parameters jsonb not null,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)

trading_signals (
  id uuid primary key,
  strategy_id uuid references strategies(id),
  symbol text not null,
  timestamp timestamptz not null,
  type text not null, -- 'buy' | 'sell'
  strength text not null, -- 'weak' | 'moderate' | 'strong'
  price decimal not null,
  indicators jsonb not null,
  confidence decimal not null,
  created_at timestamptz default now()
)

-- Por crear (Fase 3)
backtest_results (
  id uuid primary key,
  strategy_id uuid references strategies(id),
  status text default 'pending',
  symbol text not null,
  timeframe text not null,
  start_date timestamptz not null,
  end_date timestamptz not null,
  total_trades int,
  winning_trades int,
  losing_trades int,
  win_rate decimal,
  net_profit decimal,
  max_drawdown decimal,
  sharpe_ratio decimal,
  t_statistic decimal,
  profit_factor decimal,
  is_in_sample boolean default true,
  is_out_of_sample boolean default false,
  created_at timestamptz default now()
)

backtest_trades (
  id uuid primary key,
  backtest_id uuid references backtest_results(id),
  entry_time timestamptz not null,
  exit_time timestamptz not null,
  type text not null,
  entry_price decimal not null,
  exit_price decimal not null,
  quantity decimal not null,
  pnl decimal not null,
  pnl_pct decimal not null,
  exit_reason text not null
)

-- Por crear (Fase N)
orders (
  id uuid primary key,
  strategy_id uuid references strategies(id),
  symbol text not null,
  type text not null,
  side text not null,
  quantity decimal not null,
  price decimal,
  stop_price decimal,
  status text default 'pending',
  filled_price decimal,
  filled_at timestamptz,
  is_paper boolean default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
)
```

## 5. KPI de Exito

**Metrica principal:** Estrategia validada con t-statistic > 3.0 en Out-of-Sample, ejecutando ordenes automatizadas en < 100ms.

**Metricas secundarias:**
- Win rate > 55%
- Sharpe ratio > 1.5
- Max drawdown < 15%
- Profit factor > 1.5
- Ausencia verificada de overfitting (walk-forward analysis)

## 6. Especificacion Tecnica

### Features a Implementar (Feature-First)

```
src/features/
├── auth/              # Autenticacion (YA IMPLEMENTADO)
├── market-data/       # Ingesta y almacenamiento OHLCV
├── indicators/        # Calculo de indicadores tecnicos
├── signals/           # Generacion de senales de trading
├── strategies/        # CRUD y configuracion de estrategias
├── backtesting/       # Motor de backtesting y validacion
├── orders/            # Gestion de ordenes (paper + live)
└── dashboard/         # Metricas y rendimiento
```

### Stack Confirmado
- **Frontend:** Next.js 16 + React 19 + TypeScript + Tailwind 3.4
- **Backend:** Supabase (Auth + Database + RLS)
- **Validacion:** Zod
- **Estado:** Zustand
- **Testing:** Playwright CLI + MCP

### Fases de Implementacion (Blueprint del PRP-001)

1. [x] Auth base (COMPLETADO)
2. [ ] Fase 1: Fundamentacion y Captura de Datos (OHLCV + motor de backtesting)
3. [ ] Fase 2: Generacion de Senales (EMA, MACD, RSI, Bollinger)
4. [ ] Fase 3: Validacion Cientifica (Backtesting In-Sample / Out-of-Sample)
5. [ ] Fase N: Implementacion y Ejecucion (Paper Trading → Live)

### Restricciones del PRP
- Maximo 5-7 parametros por estrategia (evitar overfitting)
- Todo basado en reglas empiricas, NO intuicion humana
- Validar siempre Out-of-Sample antes de aprobar estrategia
- NO hardcodear valores de indicadores (usar constantes configurables)
