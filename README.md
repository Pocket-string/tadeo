# Trader | Sistema de Trading Algoritmico

Sistema de trading algoritmico basado en analisis tecnico con backtesting cientifico. Arquitectura Feature-First sobre Next.js 16 + Supabase, desarrollado con SaaS Factory V4.

## Tech Stack

```yaml
Runtime:      Node.js + TypeScript
Framework:    Next.js 16 (App Router) + React 19
Database:     PostgreSQL / Supabase (Auth + DB + RLS)
Styling:      Tailwind CSS 3.4 + shadcn/ui
State:        Zustand
Validation:   Zod
Testing:      Playwright CLI + MCP
AI Tooling:   Claude Code + SaaS Factory V4 Skills
Pkg Manager:  pnpm (npm prohibido)
```

## Arquitectura

```
src/
├── app/                          # Next.js App Router
│   ├── (auth)/                  # Login, signup
│   ├── (main)/dashboard/        # Dashboard principal
│   └── api/market-data/         # API REST para ingesta OHLCV
│
├── features/                     # Feature-First
│   ├── market-data/             # Ingesta y consulta de datos OHLCV
│   │   ├── services/            # getCandles, importCandles, getAvailableSymbols
│   │   └── types/               # Zod schemas (Timeframe, OHLCVCandle, ImportCandles)
│   │
│   ├── indicators/              # Indicadores tecnicos puros
│   │   └── services/            # EMA, MACD, RSI, Bollinger Bands
│   │
│   └── backtesting/             # Motor de backtesting
│       ├── services/            # runBacktest (senales, posiciones, metricas)
│       └── types/               # BacktestConfig, BacktestMetrics, BacktestOutput
│
├── actions/                      # Server Actions (strategies CRUD)
├── components/layout/            # Sidebar, navigation
├── lib/supabase/                 # Cliente Supabase (server + client)
└── types/                        # Tipos de dominio (Strategy, Order, signals)
```

## Base de Datos (Supabase)

5 tablas con RLS habilitado:

| Tabla | Descripcion |
|-------|-------------|
| `profiles` | Usuarios con rol (trader/admin), auto-creado via trigger |
| `ohlcv_candles` | Datos historicos OHLCV (unique: symbol+timeframe+timestamp) |
| `strategies` | Estrategias del usuario con parametros JSON |
| `backtest_results` | Metricas de backtesting (Sharpe, t-stat, drawdown, win rate) |
| `backtest_trades` | Trades individuales de cada backtest |

## Features Implementadas

### Fase 1: Fundamentacion y Captura de Datos (Completada)

- **Indicadores tecnicos**: EMA, MACD, RSI, Bollinger Bands (TypeScript puro, sin deps externas)
- **Motor de backtesting**: Senales por confluencia (EMA cross + MACD + RSI), stop-loss/take-profit, metricas completas
- **Ingesta OHLCV**: API REST + server actions para importar datos historicos
- **Estrategias CRUD**: Crear y listar estrategias con parametros configurables

### KPIs Objetivo

| Metrica | Umbral |
|---------|--------|
| t-statistic | > 3.0 |
| Win rate | > 55% |
| Sharpe ratio | > 1.5 |
| Max drawdown | < 15% |

## Quick Start

### 1. Instalar dependencias

```bash
pnpm install
```

### 2. Configurar variables de entorno

```bash
cp .env.example .env.local
# Editar con credenciales de Supabase:
# NEXT_PUBLIC_SUPABASE_URL=...
# NEXT_PUBLIC_SUPABASE_ANON_KEY=...
```

### 3. Aplicar migraciones

```bash
# Las migraciones estan en supabase/migrations/
# Aplicar via Supabase Dashboard o MCP
```

### 4. Iniciar desarrollo

```bash
pnpm run dev
# Auto-detecta puerto disponible (3000-3006)
```

## Comandos

```bash
pnpm run dev            # Servidor desarrollo
pnpm run build          # Build produccion
pnpm run start          # Servidor produccion
pnpm run lint           # ESLint
pnpm exec tsc --noEmit  # Verificar tipos (debe ser 0 errores)
```

## MCPs Configurados

| MCP | Uso |
|-----|-----|
| Next.js DevTools | Debug en tiempo real via `/_next/mcp` |
| Playwright | Testing automatizado con browser real |
| Supabase | Queries, migraciones, estructura de BD |

## SaaS Factory V4

Este proyecto usa SaaS Factory V4 (Agent-First). Skills disponibles en `.claude/skills/`:

- **xavier** - Orquestador maestro que rutea tareas
- **delegate-flash** - Delegacion a modelos rapidos para tareas mecanicas
- **docker-deploy** - Deploy con Docker + Dokploy
- **prp** / **bucle-agentico** - Planificacion y ejecucion de features complejas
- **supabase** - Gestion completa de base de datos
- **playwright-cli** - Testing automatizado
- Y 9 skills mas (ver `CLAUDE.md` para lista completa)

## Roadmap (PRP-001)

- [x] **Fase 1**: Fundamentacion y Captura de Datos
- [ ] **Fase 2**: Generacion de Senales (UI de estrategias, visualizacion de indicadores)
- [ ] **Fase 3**: Validacion Cientifica (In-Sample/Out-of-Sample, walk-forward analysis)
- [ ] **Fase 4**: Implementacion y Validacion Final (paper trading, ejecucion live)

---

**Trader v1.0** | SaaS Factory V4 | pnpm only
