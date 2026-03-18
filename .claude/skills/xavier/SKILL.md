---
name: xavier
description: |
  Master orchestrator que detecta senales en las tareas del usuario y enruta
  al skill, agente y modo de ejecucion correcto. Compone workflows multi-skill,
  decide SPRINT vs BLUEPRINT, y detecta cuando el conocimiento acumulado
  justifica crear un nuevo skill. El cerebro de la fabrica SaaS.
allowed-tools:
  - bash
  - read
---

# Xavier - Master Orchestrator

El cerebro de la fabrica. Analiza cada tarea del usuario, detecta que skills necesita,
elige el modo de ejecucion, y coordina la secuencia completa.

Los skills son los X-Men — cada uno con un superpoder distinto.
Xavier los entrena, los detecta, y los dirige.

**Activar Xavier cuando**: llega una tarea no-trivial que podria beneficiarse de uno o mas skills.
**NO activar cuando**: la tarea es trivial (typo, 1 linea, pregunta informativa).

---

## Signal Detection Matrix

Para cada tarea, evaluar estas senales contra los 8 skills disponibles.

### Tipos de Senal

- **Lexica** (1 punto): Keywords en el request del usuario
- **Estructural** (2 puntos): Estado del codebase (archivos que faltan, patrones ausentes)
- **Contextual** (2 puntos): Etapa del proyecto, lo que ya existe

### Matriz

| Skill | Senales Lexicas | Senales Estructurales | Senales Contextuales | Threshold |
|-------|----------------|----------------------|---------------------|-----------|
| **harden** | "security", "env validation", "rate limit", "headers", ".env", "API keys", "email", "Resend", "UI kit" | Falta `src/lib/env.ts`, falta `src/lib/rate-limit.ts`, no security headers en `next.config.ts`, falta `.env.example` | Proyecto nuevo pre-produccion; usuario dice "production-ready" o "listo para deploy" | 3+ pts |
| **supabase-patterns** | "RLS", "row level security", "migration", "trigger", "DEFERRABLE", "constraint", "swap", "reorder" | Archivos `.sql` mencionados, tabla nueva sin RLS, `supabase/migrations/` referenciado | Feature que almacena datos; tabla nueva necesaria; tabla existente sin RLS | 3+ pts |
| **server-action** | "server action", "form action", "CRUD", "create/update/delete", "file upload action", "'use server'" | Usuario quiere crear logica server-side; feature tiene types/services pero no actions | Feature con UI lista pero sin logica server-side; formulario que necesita backend | 2+ pts |
| **ai-engine** | "AI", "LLM", "generateText", "generateObject", "OpenRouter", "Gemini", "GPT", "BYOK", "streaming", "cross-model" | No `ai` en package.json; no existe `src/shared/lib/ai-router.ts` | Feature que requiere generacion, analisis, o revision con IA | 3+ pts |
| **feature-scaffold** | "new feature", "create feature", "scaffold", nombre de feature especifico (ej: "notifications", "payments") | No existe `src/features/{name}/` para la feature pedida | Usuario describe feature completa end-to-end; necesita components + hooks + services | 2+ pts |
| **docker-deploy** | "deploy", "Docker", "Dockerfile", "Compose", "Dokploy", "VPS", "production", "health check", "standalone" | No existe `Dockerfile`, falta `output: 'standalone'` en `next.config.ts` | Proyecto feature-complete listo para produccion; usuario dice "deploy" o "lanzar" | 3+ pts |
| **skill-creator** | "create skill", "new skill", "skill template" | Birth Protocol activado (ver seccion abajo) | 3+ patrones repetidos en dominio sin skill | 2+ pts |
| **delegate-flash** | "Flash", "delegar", "tarea mecanica", "generar boilerplate", "barrel exports", "mock data" | Tarea del Green Zone (ver /delegate-flash): tipos desde SQL, tests simples, componentes puros, Zod desde interface | Tarea repetitiva/mecanica con input/output bien definido; no requiere razonamiento profundo | 2+ pts |

### Reglas de Evaluacion

1. Sumar puntos de senales detectadas por skill
2. Skill se activa cuando score >= threshold de esa fila
3. **0 skills activos** → ejecutar sin skill, delegar a agente apropiado
4. **1 skill activo** → invocar ese skill directamente
5. **2+ skills activos** → proceder a Composition Sequences

### False Positives (Cuidado)

Estas combinaciones NO activan el skill correspondiente:

- "AI" en contexto de "documentacion de AI templates" → NO es ai-engine
- "deploy" en "deploy this migration" → NO es docker-deploy, ES supabase-patterns
- "security" en "SECURITY DEFINER" → NO es harden, ES supabase-patterns
- "action" en "user action on the UI" → NO es server-action
- "scaffold" en "scaffold this test" → NO es feature-scaffold

**Regla de oro**: ante duda, preguntar al usuario. 5 segundos de clarificacion > 5 minutos de routing incorrecto.

---

## Routing Engine

### Etapa 1: Mode Selection

```
SPRINT cuando:
  - Tarea describible en 1 oracion
  - Afecta 1-3 archivos
  - Sin cambios DB schema
  - Sin dependencias complejas entre componentes
  - Resultado verificable inmediatamente

BLUEPRINT cuando:
  - Multiples componentes coordinados
  - Cambios en DB + codigo + UI
  - Fases que dependen una de otra
  - Requiere entender contexto antes de implementar

OVERRIDE:
  - Si SPRINT detecta 3+ skills → upgrade automatico a BLUEPRINT
  - Informar al usuario: "Esta tarea involucra [dominios]. Modo BLUEPRINT para secuenciar correctamente."
```

### Etapa 2: Skill Selection

```
1. Ejecutar Signal Detection Matrix contra el request
2. Recolectar skills con score >= threshold
3. Switch:
   - 0 skills → ejecutar directamente, delegar a agente apropiado
   - 1 skill → invocar ese skill (el skill maneja su propio flujo)
   - 2+ skills → construir Composition Sequence (ver abajo)
```

### Etapa 3: Agent Delegation

Para tareas que caen FUERA de skills, o como complemento:

| Dominio | Agente |
|---------|--------|
| DB / SQL / RLS / migraciones | supabase-admin |
| UI / React / Tailwind / responsive | frontend-specialist |
| Server Actions / APIs / logica backend | backend-specialist |
| Exploracion profunda del codebase | codebase-analyst |
| Tests / QA / quality gates | validacion-calidad |
| Deploy / env vars / dominios | vercel-deployer |
| Documentacion / README | gestor-documentacion |

Reglas:
- **SPRINT**: maximo 1 agente
- **BLUEPRINT**: 1 agente por fase (ideal)
- Cuando un skill se invoca, el skill maneja su ejecucion — el agente es para tareas fuera de skills

---

## Composition Sequences

Cuando 2+ skills se activan, Xavier los secuencia segun estas composiciones canonicas.

### A: Nueva Feature con DB (mas comun)

```
Trigger: "Necesito [feature] que guarde [datos] en la base de datos"

Secuencia:
  1. /feature-scaffold  → Generar estructura + types + components
  2. /supabase-patterns → Crear migracion con RLS + triggers
  3. /server-action     → Crear CRUD actions usando types del paso 1
  4. (opcional) /harden → Si es primera feature, aplicar Core Security + Auth
```

### B: Feature con AI

```
Trigger: "Necesito una feature de AI que [genere/analice/revise]"

Secuencia:
  1. /feature-scaffold  → Generar estructura de la feature
  2. /ai-engine         → Instalar providers + crear logica de generacion
  3. /server-action     → Wrappear generacion AI en action con rate limiting
  4. /supabase-patterns → Almacenar resultados AI (si persistencia)
```

### C: Production Hardening

```
Trigger: "Hacer production-ready" o "preparar para deploy"

Secuencia:
  1. /harden            → Env validation, headers, rate limiting, auth
  2. /supabase-patterns → Verificar RLS en todas las tablas, migration checklist
  3. /docker-deploy     → Dockerfile, Compose/Dokploy, health checks
```

### D: Content Pipeline Feature

```
Trigger: "Necesito [research/topic/campaign/post/visual] feature"

Secuencia:
  1. /feature-scaffold  → Generar estructura en src/features/{name}/
  2. /supabase-patterns → Tabla + RLS + triggers (si almacena datos)
  3. /ai-engine         → Integracion AI (Gemini para generacion, OpenAI para review)
  4. /server-action     → Actions con rate limiting + Zod validation
```

### E: Auditoria de Seguridad

```
Trigger: "Auditar seguridad", "es seguro?", "revisar vulnerabilidades"

Secuencia:
  1. /harden            → Verificar env, headers, rate limiting existen
  2. /supabase-patterns → Correr migration checklist, verificar RLS
  3. validacion-calidad → Typecheck, lint, verificar no `any`
```

### Regla de Secuenciacion

- Cada paso se completa ANTES de iniciar el siguiente
- En BLUEPRINT, cada paso = una Fase del bucle-agentico
- En SPRINT, composiciones con 3+ skills se upgraden a BLUEPRINT automaticamente
- Entre pasos, Xavier re-evalua: ¿el paso anterior cambio lo que se necesita?

---

## Skill Birth Protocol

Xavier detecta cuando el conocimiento acumulado justifica crear un NUEVO skill.

### Senales de Deteccion

| Senal | Descripcion | Threshold |
|-------|-------------|-----------|
| **Gotcha Counter** | Gotchas documentados en Auto-Blindaje para un dominio SIN skill existente | 3+ gotchas en mismo dominio |
| **Task Repetition** | Mismo tipo de tarea pedida multiples veces sin skill que la cubra | 3+ ocurrencias similares |
| **Cross-Skill Gap** | Tarea que no triggea ningun skill pero requiere conocimiento especializado | 2+ gaps en mismo dominio |
| **Agent Overload** | Mismo agente manejando tareas complejas repetitivas que podrian sistematizarse | 5+ delegaciones similares |

### Donde Buscar Senales

Xavier lee estas fuentes para detectar patrones:

1. **CLAUDE.md** seccion "Aprendizajes" → gotchas globales
2. **PRPs** secciones "Aprendizajes" → gotchas por feature
3. **Memory files** → patrones cross-session
4. **Historial de conversacion** → tareas repetidas en la sesion actual

### Decision Tree

```
Algun threshold alcanzado?
  |
  +- NO → Continuar operacion normal
  |
  +- SI → Proponer al usuario:
          "He detectado un patron recurrente en [dominio].
           [N] tareas similares se han manejado manualmente.
           Propongo crear el skill '[nombre]' que cubriria [descripcion].
           ¿Lo creo?"
          |
          +- SI      → Invocar /skill-creator con spec acumulada
          +- NO      → Reset contadores, documentar decision
          +- DESPUES → Seguir tracking, subir threshold +2
```

### Ejemplos de Skills que Podrian Nacer

| Patron Detectado | Skill Propuesto | Razon |
|-----------------|-----------------|-------|
| 3+ integraciones Stripe con webhooks, checkout, subscriptions | `payments-stripe` | Integracion compleja con muchos gotchas |
| 4+ tareas de image optimization, CDN, Supabase Storage | `media-pipeline` | Manejo de media con patrones consistentes |
| 3+ tareas de cron jobs, background tasks, queues | `background-jobs` | Ningun skill cubre procesamiento asincrono |
| 5+ dashboards con widgets, charts, KPIs | `dashboard-builder` | frontend-specialist los maneja pero siguen un patron |
| 3+ flujos de content pipeline (research → post → visual) | `content-pipeline` | Dominio especifico de ContentOps con muchos pasos |

---

## Anti-Patterns

| Anti-Pattern | Que Hacer |
|-------------|-----------|
| **Over-routing**: invocar skill para tarea de <2 min | Si es trivial (typo, 1 CSS class, rename), SPRINT directo sin skill |
| **Skill stacking**: 3 skills para agregar 1 campo a un form | Solo componer si genuinamente cruza dominios |
| **Birth prematuro**: proponer skill tras 1 ocurrencia | Respetar thresholds. Minimo 3+ ocurrencias |
| **Routing sin leer**: seleccionar skill por keywords sin verificar estado | SIEMPRE verificar senales estructurales. Si harden ya se aplico, no re-invocar |
| **Re-aplicar skills completados**: correr harden cuando todos sus modulos ya estan | Leer archivos existentes antes de invocar |
| **BLUEPRINT para one-liners**: usar BLUEPRINT para "fix the button color" | Confiar en el decision tree de Mode Selection |
| **Forzar skill contra intent del usuario**: usuario quiere approach custom | Xavier sugiere, NUNCA fuerza. Si el usuario dice "lo hago diferente", respetar |
| **Agentes en paralelo**: delegar a 3+ agentes simultaneamente | Maximo 1 agente en SPRINT, 1 por fase en BLUEPRINT |

---

## Flujo de Ejecucion

```
1. RECIBIR request del usuario

2. SIGNAL DETECTION
   - Evaluar las 8 filas de la matriz
   - Calcular score por skill
   - Identificar skills activos (score >= threshold)

3. MODE SELECTION
   - Evaluar SPRINT vs BLUEPRINT
   - Si SPRINT + 3 skills → upgrade a BLUEPRINT

4. ROUTING
   - 0 skills → delegar a agente apropiado directamente
   - 1 skill → invocar ese skill
   - 2+ skills → construir Composition Sequence
   - Informar al usuario que skills se van a usar

5. EJECUCION
   - El skill invocado maneja su propio flujo (AskUserQuestion, modulos, etc.)
   - Xavier NO interviene durante la ejecucion del skill
   - En Composition: esperar que skill N termine antes de invocar skill N+1

6. POST-EJECUCION
   - Evaluar Skill Birth Protocol (buscar patrones acumulados)
   - Auto-Blindaje si hubo errores
   - Confirmar resultado al usuario

7. TRANSICION (si hay mas skills en la secuencia)
   - Re-evaluar: ¿el paso anterior cambio lo que se necesita?
   - Ajustar secuencia restante si es necesario
   - Continuar con siguiente skill
```

---

## Quick Reference Card

```
SKILL CATALOG:
  /harden            → Seguridad, auth, env, rate limit, email, API keys, UI kit
  /supabase-patterns → RLS, triggers, constraints, SECURITY DEFINER, migraciones
  /server-action     → Auth → Validate → Execute → Side Effects (4 templates)
  /ai-engine         → Vercel AI SDK v6, provider routing, BYOK, cross-model review
  /feature-scaffold  → Estructura Feature-First completa
  /docker-deploy     → Dockerfile, Compose, Dokploy, cache, SSH, health checks
  /delegate-flash    → Delegar tareas mecanicas a Gemini Flash (prompts optimizados)
  /skill-creator     → Crear nuevos skills

AGENT CATALOG:
  @codebase-analyst      → Analisis profundo de patrones
  @frontend-specialist   → React, Tailwind, UI/UX
  @backend-specialist    → Server Actions, APIs
  @supabase-admin        → Database, Auth, RLS
  @validacion-calidad    → Tests, QA
  @vercel-deployer       → Deploy, env vars
  @gestor-documentacion  → Docs, README

MODES:
  SPRINT    → 1-3 archivos, sin DB schema, resultado inmediato
  BLUEPRINT → Multi-fase, DB + codigo + UI, contexto mapping just-in-time
```
