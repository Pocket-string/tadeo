---
name: supabase-patterns
description: |
  Patrones avanzados de Supabase validados en produccion: RLS templates, triggers reutilizables,
  DEFERRABLE constraints para swap, SECURITY DEFINER para cross-RLS, y checklist de migraciones.
  Extraido de 17+ migraciones reales en LinkedIn ContentOps + Soiling Calculator + Sundled Dashboard.
allowed-tools:
  - bash
  - read
  - edit
  - write
---

# /supabase-patterns - Patrones Avanzados de Supabase

Patrones de base de datos probados en produccion con Supabase + PostgreSQL.
Cada patron incluye SQL listo para copiar y gotchas aprendidos en produccion real.

**Paso 1: Pregunta al usuario que modulos aplicar.**
**Paso 2: Ejecuta SOLO los modulos seleccionados.**

---

## Gotchas Criticos (Aprendidos en Produccion)

> Leer ANTES de implementar cualquier modulo.

1. **UNIQUE INDEX NO es deferrable** — Solo un `UNIQUE CONSTRAINT` puede ser `DEFERRABLE`. Si necesitas swap/reorder de filas con restriccion unica, DEBES usar CONSTRAINT, no INDEX.
2. **SECURITY DEFINER corre como `postgres`** — Usa esto SOLO cuando una funcion necesita operar sin filtro RLS. Alternativamente, usa `createServiceClient()` en el servidor.
3. **No incluir columnas GENERATED ALWAYS en INSERT/UPDATE** — Supabase rechaza el payload. Excluir del query y documentar en tipos con `// GENERATED`.
4. **Migraciones SIEMPRE antes de deploy** — El orden es: `apply_migration` → deploy. Nunca al reves o tendras runtime crashes.
5. **RLS en la MISMA migracion que CREATE TABLE** — Nunca crear tabla sin policies en la misma migracion. Una tabla sin RLS es un agujero de seguridad.
6. **`.maybeSingle()` en vez de `.single()`** — `.single()` lanza error si no hay fila. `.maybeSingle()` retorna null. Usar `.maybeSingle()` cuando el registro puede no existir.
7. **`auth.uid()` solo funciona en contexto RLS** — En funciones SECURITY DEFINER, `auth.uid()` es null. Pasar el user_id como parametro.
8. **PostgREST requiere GRANT explicito en schemas custom** — Aunque uses service_role key, PostgREST necesita `GRANT ALL ON {schema}.{table} TO service_role;` para INSERT/UPDATE en schemas no-public. Ejecutar `NOTIFY pgrst, 'reload schema';` despues del GRANT.
9. **DELETE masivo NO libera espacio en disco** — PostgreSQL marca filas como dead tuples. Autovacuum las recicla para reuso, pero el archivo en disco NO se reduce. Ejecutar `VACUUM FULL {schema}.{table};` para reconstruir la tabla y reclamar espacio. Critico en free tier (500 MB).

---

## Pregunta Inicial

Usa AskUserQuestion con multiSelect:true para preguntar:

**"Que patrones de Supabase quieres aplicar?"**

Opciones:
1. **RLS Templates (Recomendado)** — Patron owner-only, admin-all, workspace-based
2. **Triggers Reutilizables** — updated_at, handle_new_user, soft delete
3. **Advanced Constraints** — DEFERRABLE para swap/reorder, partial indexes
4. **Security Definer** — Funciones PL/pgSQL que cruzan RLS
5. **Migration Checklist** — Checklist y orden para migraciones seguras

Si el usuario dice "all" o "todo", aplica todos los modulos.

---

## Modulo 1: RLS Templates

### 1.1 Patron: Owner-Only (Mas comun)

El usuario solo ve/edita sus propios registros.

```sql
-- Template: Owner-only RLS
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

-- Read own records
CREATE POLICY "{table_name}_select_own"
  ON {table_name} FOR SELECT
  USING (auth.uid() = user_id);

-- Insert own records
CREATE POLICY "{table_name}_insert_own"
  ON {table_name} FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Update own records
CREATE POLICY "{table_name}_update_own"
  ON {table_name} FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Delete own records
CREATE POLICY "{table_name}_delete_own"
  ON {table_name} FOR DELETE
  USING (auth.uid() = user_id);
```

### 1.2 Patron: Admin-All + Owner-Own

Admins ven todo, usuarios solo lo suyo.

```sql
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

-- Users read own
CREATE POLICY "{table_name}_select_own"
  ON {table_name} FOR SELECT
  USING (auth.uid() = user_id);

-- Admins read all
CREATE POLICY "{table_name}_admin_select"
  ON {table_name} FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.access_level = 'admin'
    )
  );

-- Users modify own
CREATE POLICY "{table_name}_modify_own"
  ON {table_name} FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
```

### 1.3 Patron: Workspace-Based

Multi-tenant: usuarios ven registros de su workspace.

```sql
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

-- Members of workspace can read
CREATE POLICY "{table_name}_workspace_select"
  ON {table_name} FOR SELECT
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

-- Members can insert to their workspace
CREATE POLICY "{table_name}_workspace_insert"
  ON {table_name} FOR INSERT
  WITH CHECK (
    workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

-- Workspace table + members (prerequisito)
CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  role text NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'admin', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Members see own workspaces"
  ON workspaces FOR SELECT
  USING (
    id IN (SELECT workspace_id FROM workspace_members WHERE user_id = auth.uid())
  );

CREATE POLICY "Members see own memberships"
  ON workspace_members FOR SELECT
  USING (user_id = auth.uid());
```

### 1.4 Patron: Service-Only (No user access)

Solo accesible via `createServiceClient()` o funciones SECURITY DEFINER.

```sql
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;
-- No policies = nadie accede via client. Solo service role.
```

---

## Modulo 2: Triggers Reutilizables

### 2.1 Trigger: Auto-update `updated_at`

Crear la funcion UNA vez, reusar en cualquier tabla.

```sql
-- Funcion reutilizable (crear una sola vez)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Aplicar a cualquier tabla con updated_at:
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON {table_name}
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### 2.2 Trigger: Auto-create profile on signup

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (
    new.id,
    new.email,
    COALESCE(new.raw_user_meta_data->>'full_name', '')
  );
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
```

### 2.3 Trigger: Soft Delete (marcar en vez de borrar)

```sql
-- Agregar columna a la tabla
ALTER TABLE {table_name} ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Funcion de soft delete
CREATE OR REPLACE FUNCTION soft_delete_{table_name}()
RETURNS trigger AS $$
BEGIN
  NEW.deleted_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Modificar RLS para excluir soft-deleted
CREATE POLICY "{table_name}_exclude_deleted"
  ON {table_name} FOR SELECT
  USING (deleted_at IS NULL AND auth.uid() = user_id);
```

---

## Modulo 3: Advanced Constraints

### 3.1 DEFERRABLE UNIQUE para Swap/Reorder

> **CRITICO**: Un UNIQUE INDEX no es deferrable. SOLO un UNIQUE CONSTRAINT con DEFERRABLE funciona para swap.

```sql
-- MAL: Esto NO permite swap
CREATE UNIQUE INDEX idx_unique_order ON items (list_id, position);

-- BIEN: Esto SI permite swap
ALTER TABLE items
  ADD CONSTRAINT uq_items_position
  UNIQUE (list_id, position)
  DEFERRABLE INITIALLY IMMEDIATE;

-- Funcion de swap con constraints diferidos
CREATE OR REPLACE FUNCTION swap_item_positions(
  p_item_a uuid,
  p_item_b uuid
) RETURNS void AS $$
DECLARE
  v_pos_a integer;
  v_pos_b integer;
  v_list_id uuid;
BEGIN
  -- Defer the constraint for this transaction
  SET CONSTRAINTS uq_items_position DEFERRED;

  -- Get current positions
  SELECT position, list_id INTO v_pos_a, v_list_id
    FROM items WHERE id = p_item_a;
  SELECT position INTO v_pos_b
    FROM items WHERE id = p_item_b;

  -- Swap
  UPDATE items SET position = v_pos_b WHERE id = p_item_a;
  UPDATE items SET position = v_pos_a WHERE id = p_item_b;
END;
$$ LANGUAGE plpgsql;
```

### 3.2 Partial Indexes (Optimizar queries comunes)

```sql
-- Solo indexar filas activas (mas rapido, menos espacio)
CREATE INDEX idx_api_keys_active
  ON api_keys (key_hash)
  WHERE is_active = true;

-- Solo indexar eventos recientes
CREATE INDEX idx_events_recent
  ON funnel_events (event_name, created_at DESC)
  WHERE created_at > now() - interval '90 days';

-- Solo indexar no-borrados
CREATE INDEX idx_items_active
  ON items (user_id, created_at DESC)
  WHERE deleted_at IS NULL;
```

---

## Modulo 4: Security Definer

### 4.1 Cuando usar SECURITY DEFINER vs createServiceClient()

| Escenario | Solucion |
|-----------|----------|
| Funcion SQL que necesita leer/escribir sin RLS | SECURITY DEFINER |
| Server Action que necesita bypass RLS | `createServiceClient()` |
| Trigger que inserta en tabla con RLS | SECURITY DEFINER |
| API Route que necesita datos de otro usuario | `createServiceClient()` |

### 4.2 Template: Funcion SECURITY DEFINER

```sql
-- Funcion que opera sin filtro RLS (corre como postgres)
CREATE OR REPLACE FUNCTION admin_get_all_users()
RETURNS TABLE (
  id uuid,
  email text,
  full_name text,
  access_level text,
  created_at timestamptz
) AS $$
BEGIN
  RETURN QUERY
    SELECT p.id, p.email, p.full_name, p.access_level, p.created_at
    FROM profiles p
    ORDER BY p.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- IMPORTANTE: Restringir acceso a la funcion
REVOKE ALL ON FUNCTION admin_get_all_users() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION admin_get_all_users() TO authenticated;
```

### 4.3 Template: Funcion con validacion interna

```sql
-- Funcion que valida permisos DENTRO de la funcion
CREATE OR REPLACE FUNCTION get_workspace_stats(p_workspace_id uuid)
RETURNS jsonb AS $$
DECLARE
  v_is_member boolean;
  v_result jsonb;
BEGIN
  -- Verificar membresia (ya que RLS no aplica en SECURITY DEFINER)
  SELECT EXISTS(
    SELECT 1 FROM workspace_members
    WHERE workspace_id = p_workspace_id AND user_id = auth.uid()
  ) INTO v_is_member;

  IF NOT v_is_member THEN
    RAISE EXCEPTION 'No tienes acceso a este workspace';
  END IF;

  -- Query sin filtro RLS
  SELECT jsonb_build_object(
    'total_users', (SELECT count(*) FROM workspace_members WHERE workspace_id = p_workspace_id),
    'total_items', (SELECT count(*) FROM items WHERE workspace_id = p_workspace_id)
  ) INTO v_result;

  RETURN v_result;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;
```

---

## Modulo 5: Migration Checklist

### 5.1 Checklist para cada migracion

Antes de aplicar cualquier migracion, verificar:

```markdown
- [ ] Tabla nueva incluye RLS + policies en la misma migracion
- [ ] Columna `created_at timestamptz DEFAULT now() NOT NULL` presente
- [ ] Columna `updated_at timestamptz DEFAULT now() NOT NULL` con trigger
- [ ] FKs con ON DELETE apropiado (CASCADE, SET NULL, o RESTRICT)
- [ ] Indexes en columnas usadas en WHERE/JOIN frecuentes
- [ ] No columnas GENERATED ALWAYS en INSERT/UPDATE code paths
- [ ] UUIDs como PK (gen_random_uuid()) en vez de serial/bigserial
- [ ] CHECK constraints para enums en vez de tipos enum de Postgres
- [ ] Migracion testeada localmente antes de aplicar en produccion
```

### 5.2 Orden de operaciones

```
1. Escribir SQL de migracion
2. Aplicar migracion (Supabase MCP o archivo .sql)
3. Actualizar tipos TypeScript (database.ts)
4. Actualizar service layer
5. Deploy codigo
```

> **NUNCA al reves**: deploy ANTES de migracion = runtime crash.

### 5.3 Template de migracion completa

```sql
-- Migration: {NNN}_{descriptive_name}.sql
-- Description: {Que hace esta migracion}
-- Date: {YYYY-MM-DD}

-- 1. Create table
CREATE TABLE {table_name} (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- campos especificos aqui
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- 2. RLS (SIEMPRE en la misma migracion)
ALTER TABLE {table_name} ENABLE ROW LEVEL SECURITY;

CREATE POLICY "{table_name}_select_own"
  ON {table_name} FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "{table_name}_insert_own"
  ON {table_name} FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "{table_name}_update_own"
  ON {table_name} FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "{table_name}_delete_own"
  ON {table_name} FOR DELETE
  USING (auth.uid() = user_id);

-- 3. Indexes
CREATE INDEX idx_{table_name}_user ON {table_name} (user_id);

-- 4. Triggers
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON {table_name}
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

---

## Flujo de Ejecucion

1. **Preguntar** que modulos aplicar (multiSelect)
2. **Verificar** que la funcion `update_updated_at()` existe (crear si no)
3. **Aplicar** modulos seleccionados
4. **Si hay migraciones**, aplicar via Supabase MCP o guardar como `.sql`
5. **Mostrar resumen** con SQL aplicado

---

## Mensaje Final

```
Patrones Supabase aplicados!

Modulos:
  [x] RLS Templates — {N} patrones (owner-only, admin-all, workspace, service-only)
  [x] Triggers — updated_at, handle_new_user, soft delete
  [x] Advanced Constraints — DEFERRABLE unique, partial indexes
  [x] Security Definer — Templates con validacion interna
  [x] Migration Checklist — Template + orden de operaciones

Gotchas recordar:
  - UNIQUE INDEX != UNIQUE CONSTRAINT (solo constraint es deferrable)
  - SECURITY DEFINER = corre como postgres (validar permisos internamente)
  - .maybeSingle() en vez de .single() cuando el registro puede no existir
  - Migracion ANTES de deploy, nunca al reves
  - GRANT explicito en schemas custom para PostgREST writes
  - VACUUM FULL tras DELETE masivo para reclamar espacio en disco
```
