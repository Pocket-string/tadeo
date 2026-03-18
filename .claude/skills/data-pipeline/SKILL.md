---
name: data-pipeline
description: |
  Patrones de ETL y gestion de datos para pipelines de ingestion batch:
  Load-Summarize-Purge cycle, batch upsert, storage management en free tiers,
  webscraper orchestration, y VACUUM FULL scheduling.
  Extraido del pipeline GPM → Dataset/Raw/ → Sundled → Supabase (1,022 archivos, 0 fallos).
allowed-tools:
  - bash
  - read
  - edit
  - write
---

# /data-pipeline - Patrones de ETL y Gestion de Datos

Patrones probados en produccion para pipelines de ingestion batch con PostgreSQL/Supabase.
Cada patron incluye codigo listo para usar y gotchas aprendidos en operacion real.

**Paso 1: Pregunta al usuario que modulos aplicar.**
**Paso 2: Ejecuta SOLO los modulos seleccionados.**

---

## Gotchas Criticos (Aprendidos en Produccion)

> Leer ANTES de implementar cualquier modulo.

1. **PostgREST row limit silencioso** — `.limit(50000)` se trunca a 1000 filas sin error. Paginar o consultar por particiones (por timestamp, etc.) para obtener mas de 1000 filas.
2. **PostgreSQL NaN > 0 es TRUE** — IEEE 754: NaN no es filtrable con comparaciones. Usar `IS NOT NULL` y sanitizar a null en el ETL antes de insertar.
3. **Webscraper headless bloqueado** — Portales como GreenPowerMonitor detectan Playwright/Puppeteer headless. Usar `--no-headless` (browser visible). En servidores: `xvfb-run`.
4. **CLI Python no carga .env automaticamente** — `os.environ.get()` sin `load_dotenv()`. Pasar env vars explicitamente: `GPM_USER="x" GPM_PASS="y" python -m src.cli ...`
5. **VACUUM FULL obligatorio tras purga masiva** — DELETE + autovacuum recicla tuples pero NO reduce tamano en disco. `VACUUM FULL {table}` reconstruye la tabla. Ejemplo real: 326 MB → 41 MB.
6. **Batch upsert: tamano optimo 200 filas** — Mas grande causa timeouts en Supabase free tier. Mas chico es ineficiente. 200 es el sweet spot para PostgREST.
7. **onConflict requiere UNIQUE CONSTRAINT** — `upsert({...}, { onConflict: 'col1,col2' })` falla silenciosamente si no hay constraint. Verificar con `\d+ table`.

---

## Pregunta Inicial

Usa AskUserQuestion con multiSelect:true para preguntar:

**"Que patrones de data pipeline quieres aplicar?"**

Opciones:
1. **Load-Summarize-Purge (Recomendado)** — Ciclo completo para storage management en free tier
2. **Batch Ingestion API** — API route para carga batch desde filesystem
3. **Webscraper Orchestration** — Patrones para descarga automatizada desde portales web
4. **Storage Management** — Monitoreo, estimacion, y purga programada

Si el usuario dice "all" o "todo", aplica todos los modulos.

---

## Modulo 1: Load-Summarize-Purge Cycle

### 1.1 El Patron

Pipeline ciclico para mantener datos historicos con almacenamiento limitado:

```
LOAD (raw data)  →  SUMMARIZE (daily aggregates)  →  PURGE (old raw)  →  VACUUM FULL
     ↑                                                                         |
     └─────────────────────── siguiente lote ──────────────────────────────────┘
```

**Compresion tipica**: 48:1 (48 registros/dia/string → 1 resumen/dia/string)

### 1.2 Implementacion

```typescript
// 1. LOAD — batch ingestion por rango de fechas
const loadResult = await fetch('/api/ingest', {
  method: 'POST',
  body: JSON.stringify({
    plantId: 'PLT_A',
    start: '2025-11-01',
    end: '2025-11-30',
  }),
})

// 2. SUMMARIZE — generar aggregates diarios
const summaryResult = await fetch('/api/backfill', {
  method: 'POST',
  body: JSON.stringify({
    plantId: 'PLT_A',
    start: '2025-11-01',
    end: '2025-11-30',
    purgeAfterDays: 14,  // opcional: purga automatica
  }),
})

// 3. PURGE — eliminar datos raw antiguos (si no se hizo en paso 2)
// Solo mantener ultimos N dias de granularidad 30-min
const { error } = await supabase
  .from('fact_string')
  .delete()
  .eq('plant_id', 'PLT_A')
  .lt('Fecha', cutoffDate)

// 4. VACUUM — reclamar espacio en disco
// Ejecutar via Supabase Management API:
// POST /v1/projects/{ref}/database/query
// Body: { "query": "VACUUM FULL sunalize.fact_string;" }
```

### 1.3 Estimacion de Storage

```
fact_string:           ~23 MB / dia / 693 strings (30-min intervals)
daily_string_summary:  ~0.48 MB / dia / 693 strings (1 row/string/dia)

14 dias raw:           ~326 MB
147 dias summarized:   ~70 MB
Total estimado:        ~83 MB (17% de 500 MB free tier)
```

**Formula**: `dias_raw * 23 MB + dias_historicos * 0.48 MB < 500 MB`

---

## Modulo 2: Batch Ingestion API

### 2.1 Patron: API Route con Day-by-Day Processing

```typescript
// POST /api/ingest
// Body: { plantId, start, end, dryRun? }
// Lee CSVs de filesystem, parsea, upserta en batch

export async function POST(request: Request) {
  const { plantId, start, end, dryRun } = await request.json()

  // Validaciones
  const dates = generateDateRange(start, end ?? start)
  if (dates.length > 45) {
    return NextResponse.json(
      { error: 'Max 45 days per request' },
      { status: 400 }
    )
  }

  // Cargar dimension tables UNA vez
  const { data: trackers } = await supabase
    .from('dim_trackers')
    .select('*')
    .eq('plant_id', plantId)

  // Procesar dia por dia
  const results = []
  for (const dateStr of dates) {
    const dayResult = await processDay(supabase, dateStr, plantId, trackers, dryRun)
    results.push({ date: dateStr, ...dayResult })
  }

  return NextResponse.json({ message: 'Complete', results })
}
```

### 2.2 Batch Upsert Pattern

```typescript
const BATCH_SIZE = 200  // Sweet spot para Supabase free tier

async function batchUpsert(supabase, table: string, rows: any[], conflictCols: string) {
  let upserted = 0
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE)
    const { error } = await supabase
      .from(table)
      .upsert(batch, { onConflict: conflictCols })

    if (error) throw new Error(`Batch ${i}: ${error.message}`)
    upserted += batch.length
  }
  return upserted
}
```

### 2.3 Schema Mapping (entre pipelines)

Cuando el ETL produce un schema diferente al destino:

```typescript
// Mapear campos del ETL al schema de destino
const destRows = etlRows.map(r => ({
  plant_id: r.plant_id,
  Fecha: r.ts_local,        // renombrar campo
  string_id: r.string_id,
  i_string: r.i_string,
  v_string: r.v_string,
  p_string: r.p_string,
  poa: r.poa,
  // Omitir campos no necesarios (org_id, etc.)
}))
```

---

## Modulo 3: Webscraper Orchestration

### 3.1 Descarga por Lotes Mensuales

```bash
# Patron: descargar en lotes de 1 mes para manejar fallos y reintentos
# 7 queries/dia: I_Strings_CT1/2/3, V_String_CT1/2/3, POA

cd "path/to/webscraper"

# Pasar credenciales explicitamente (CLI no carga .env)
GPM_USER="user@email.com" GPM_PASS="password" \
  venv/Scripts/python -m src.cli download \
  --plant ANGAMOS \
  --start 2025-11-01 --end 2025-11-30 \
  --outdir "path/to/Dataset/Raw" \
  --no-headless  # OBLIGATORIO: headless bloqueado por portal
```

### 3.2 Estructura de Output Esperada

```
Dataset/Raw/
  2025/
    11/
      01/
        I_Strings_CT1.csv
        I_Strings_CT2.csv
        I_Strings_CT3.csv
        V_String_CT1.csv
        V_String_CT2.csv
        V_String_CT3.csv
        POA.csv
        manifest.json        # metadata de la descarga
      02/
        ...
```

### 3.3 Validacion Post-Descarga

```bash
# Verificar que todos los archivos existen para el rango
venv/Scripts/python -m src.cli validate --start 2025-11-01 --end 2025-11-30

# O via API:
# GET /api/ingest?date=2025-11-01
# Respuesta: { files: { I_CT1: true, I_CT2: true, ..., POA: true } }
```

### 3.4 Metricas de Referencia

```
Velocidad tipica:    ~30 seg/archivo, 7 archivos/dia = ~3.5 min/dia
Lote mensual (30d):  ~105 min = ~1.75 horas
Tasa de exito real:  1,022/1,022 archivos = 100% (con --no-headless)
```

---

## Modulo 4: Storage Management

### 4.1 Monitoreo de Tamano

```sql
-- Tamano por tabla
SELECT
  schemaname || '.' || relname AS table,
  pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
  pg_size_pretty(pg_relation_size(relid)) AS data_size,
  pg_size_pretty(pg_indexes_size(relid)) AS index_size
FROM pg_catalog.pg_statio_user_tables
ORDER BY pg_total_relation_size(relid) DESC;

-- Tamano total de la BD
SELECT pg_size_pretty(pg_database_size(current_database()));

-- Dead tuples (indicador de necesidad de VACUUM)
SELECT
  schemaname || '.' || relname AS table,
  n_live_tup AS live_rows,
  n_dead_tup AS dead_rows,
  last_autovacuum
FROM pg_stat_user_tables
WHERE n_dead_tup > 0
ORDER BY n_dead_tup DESC;
```

### 4.2 Purga Programada

```sql
-- Purgar datos raw mayores a N dias
DELETE FROM sunalize.fact_string
WHERE plant_id = 'PLT_A'
  AND "Fecha" < (
    SELECT MAX("Fecha") - INTERVAL '14 days'
    FROM sunalize.fact_string
    WHERE plant_id = 'PLT_A'
  );

-- OBLIGATORIO despues de DELETE masivo:
VACUUM FULL sunalize.fact_string;
```

### 4.3 Alertas de Capacidad

```typescript
// Verificar uso de storage antes de carga
async function checkStorageCapacity(supabase, maxMb = 450) {
  const { data } = await supabase.rpc('pg_database_size', {
    db: 'postgres'
  })

  const usedMb = data / (1024 * 1024)
  if (usedMb > maxMb) {
    throw new Error(
      `Storage ${usedMb.toFixed(0)} MB exceeds ${maxMb} MB threshold. ` +
      `Purge old data before loading more.`
    )
  }
  return usedMb
}
```

---

## Flujo de Ejecucion

1. **Preguntar** que modulos aplicar (multiSelect)
2. **Evaluar** infraestructura existente (ETL functions, API routes, DB schema)
3. **Aplicar** modulos seleccionados
4. **Si hay nuevos API routes**, crear con batch upsert y schema mapping
5. **Si hay storage concern**, implementar Load-Summarize-Purge cycle
6. **Mostrar resumen** con archivos creados/modificados

---

## Mensaje Final

```
Data Pipeline configurado!

Modulos:
  [x] Load-Summarize-Purge — Ciclo completo con compresion 48:1
  [x] Batch Ingestion API — /api/ingest con day-by-day + batch upsert
  [x] Webscraper Orchestration — Descarga por lotes, --no-headless
  [x] Storage Management — Monitoreo, purga, VACUUM FULL

Gotchas recordar:
  - PostgREST limita a 1000 filas silenciosamente
  - NaN > 0 es TRUE en PostgreSQL (sanitizar en ETL)
  - Webscraper: siempre --no-headless para portales con bot detection
  - VACUUM FULL obligatorio tras DELETE masivo
  - Batch upsert: 200 filas optimo para free tier
```
