---
name: feature-scaffold
description: |
  Genera la estructura completa de una feature siguiendo la arquitectura Feature-First.
  Crea components/, hooks/, services/, types/, y store/ con codigo base funcional.
  Sigue las convenciones de SaaS Factory: TypeScript estricto, Zod validation, Supabase services.
allowed-tools:
  - bash
  - read
  - write
---

# /feature-scaffold - Generador de Features

Genera la estructura completa de una feature siguiendo Feature-First architecture.
Cada feature incluye componentes, hooks, services, types, y opcionalmente store y API routes.

**Paso 1: Pregunta nombre y opciones de la feature.**
**Paso 2: Genera toda la estructura con codigo base.**

---

## Pregunta Inicial

Usa AskUserQuestion para preguntar:

**"Describe la feature que quieres crear."**

Preguntas:
1. **Nombre** (texto libre): "Como se llama la feature? (ej: notifications, payments, projects)"
2. **Necesita Zustand store?** — Si la feature tiene estado client-side complejo
3. **Necesita API Route?** — Si la feature expone endpoints REST
4. **Tabla principal en Supabase?** — Nombre de la tabla (si aplica)

---

## Estructura Generada

Para una feature llamada `{name}`:

```
src/features/{name}/
├── components/
│   ├── {Name}List.tsx       # Lista principal
│   ├── {Name}Card.tsx       # Card individual
│   ├── {Name}Form.tsx       # Formulario create/edit
│   └── index.ts             # Barrel export
├── hooks/
│   ├── use{Name}.ts         # Hook para item individual
│   ├── use{Name}s.ts        # Hook para lista
│   └── index.ts
├── services/
│   ├── {name}Service.ts     # CRUD service layer
│   └── index.ts
├── types/
│   ├── {name}.ts            # Interfaces + Zod schemas
│   └── index.ts
└── store/                   # (opcional)
    ├── {name}Store.ts       # Zustand store
    └── index.ts
```

---

## Template: Types (`src/features/{name}/types/{name}.ts`)

```typescript
import { z } from 'zod'

// --- Zod Schemas (source of truth) ---

export const {name}Schema = z.object({
  id: z.string().uuid(),
  user_id: z.string().uuid(),
  title: z.string().min(1, 'Titulo requerido').max(200),
  description: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
  created_at: z.string().datetime(),
  updated_at: z.string().datetime(),
})

export const create{Name}Schema = {name}Schema.omit({
  id: true,
  user_id: true,
  created_at: true,
  updated_at: true,
})

export const update{Name}Schema = create{Name}Schema.partial().extend({
  id: z.string().uuid(),
})

// --- TypeScript Types (derived from Zod) ---

export type {Name} = z.infer<typeof {name}Schema>
export type Create{Name} = z.infer<typeof create{Name}Schema>
export type Update{Name} = z.infer<typeof update{Name}Schema>
```

### Types index.ts

```typescript
export * from './{name}'
```

---

## Template: Service (`src/features/{name}/services/{name}Service.ts`)

```typescript
import { createClient } from '@/lib/supabase/server'
import type { {Name}, Create{Name}, Update{Name} } from '../types'

const TABLE = '{table_name}'

export async function get{Name}s(userId: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })

  if (error) return { data: null, error: error.message }
  return { data: data as {Name}[], error: null }
}

export async function get{Name}ById(id: string) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from(TABLE)
    .select('*')
    .eq('id', id)
    .maybeSingle()

  if (error) return { data: null, error: error.message }
  return { data: data as {Name} | null, error: null }
}

export async function create{Name}(userId: string, input: Create{Name}) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from(TABLE)
    .insert({ ...input, user_id: userId })
    .select()
    .single()

  if (error) return { data: null, error: error.message }
  return { data: data as {Name}, error: null }
}

export async function update{Name}(id: string, userId: string, input: Partial<Create{Name}>) {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from(TABLE)
    .update(input)
    .eq('id', id)
    .eq('user_id', userId)
    .select()
    .single()

  if (error) return { data: null, error: error.message }
  return { data: data as {Name}, error: null }
}

export async function delete{Name}(id: string, userId: string) {
  const supabase = await createClient()
  const { error } = await supabase
    .from(TABLE)
    .delete()
    .eq('id', id)
    .eq('user_id', userId)

  if (error) return { error: error.message }
  return { error: null }
}
```

### Services index.ts

```typescript
export * from './{name}Service'
```

---

## Template: Hook (`src/features/{name}/hooks/use{Name}s.ts`)

```typescript
'use client'

import { useState, useEffect } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { {Name} } from '../types'

export function use{Name}s() {
  const [items, setItems] = useState<{Name}[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    async function fetch() {
      const supabase = createClient()
      const { data, error } = await supabase
        .from('{table_name}')
        .select('*')
        .order('created_at', { ascending: false })

      if (error) {
        setError(error.message)
      } else {
        setItems(data as {Name}[])
      }
      setLoading(false)
    }
    fetch()
  }, [])

  return { items, loading, error }
}
```

### Hooks index.ts

```typescript
export { use{Name}s } from './use{Name}s'
```

---

## Template: Components

### `{Name}List.tsx`

```tsx
import type { {Name} } from '../types'
import { {Name}Card } from './{Name}Card'

interface {Name}ListProps {
  items: {Name}[]
}

export function {Name}List({ items }: {Name}ListProps) {
  if (items.length === 0) {
    return (
      <div className="text-center py-12 text-gray-500">
        <p>No hay elementos todavia.</p>
      </div>
    )
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {items.map((item) => (
        <{Name}Card key={item.id} item={item} />
      ))}
    </div>
  )
}
```

### `{Name}Card.tsx`

```tsx
import type { {Name} } from '../types'
import { Badge } from '@/components/ui/badge'

interface {Name}CardProps {
  item: {Name}
}

export function {Name}Card({ item }: {Name}CardProps) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-4 shadow-sm hover:shadow-md transition-shadow">
      <div className="flex items-start justify-between">
        <h3 className="font-medium text-gray-900">{item.title}</h3>
        <Badge variant={item.status === 'active' ? 'success' : 'default'}>
          {item.status}
        </Badge>
      </div>
      {item.description && (
        <p className="mt-2 text-sm text-gray-600 line-clamp-2">{item.description}</p>
      )}
      <p className="mt-3 text-xs text-gray-400">
        {new Date(item.created_at).toLocaleDateString()}
      </p>
    </div>
  )
}
```

### `{Name}Form.tsx`

```tsx
'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { Create{Name} } from '../types'

interface {Name}FormProps {
  onSubmit: (data: Create{Name}) => Promise<{ error?: string }>
  initialData?: Partial<Create{Name}>
  submitLabel?: string
}

export function {Name}Form({ onSubmit, initialData, submitLabel = 'Crear' }: {Name}FormProps) {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setLoading(true)
    setError(null)

    const form = new FormData(e.currentTarget)
    const result = await onSubmit({
      title: form.get('title') as string,
      description: (form.get('description') as string) || null,
      status: (form.get('status') as 'draft' | 'active' | 'archived') || 'draft',
    })

    if (result.error) setError(result.error)
    setLoading(false)
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <div className="rounded-md bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}
      <Input
        name="title"
        label="Titulo"
        defaultValue={initialData?.title}
        required
      />
      <Input
        name="description"
        label="Descripcion"
        defaultValue={initialData?.description ?? ''}
      />
      <Button type="submit" disabled={loading}>
        {loading ? 'Guardando...' : submitLabel}
      </Button>
    </form>
  )
}
```

### Components index.ts

```typescript
export { {Name}List } from './{Name}List'
export { {Name}Card } from './{Name}Card'
export { {Name}Form } from './{Name}Form'
```

---

## Template: Zustand Store (Opcional)

### `src/features/{name}/store/{name}Store.ts`

```typescript
import { create } from 'zustand'
import type { {Name} } from '../types'

interface {Name}State {
  items: {Name}[]
  selectedId: string | null
  loading: boolean

  setItems: (items: {Name}[]) => void
  addItem: (item: {Name}) => void
  updateItem: (id: string, updates: Partial<{Name}>) => void
  removeItem: (id: string) => void
  setSelected: (id: string | null) => void
  setLoading: (loading: boolean) => void
}

export const use{Name}Store = create<{Name}State>((set) => ({
  items: [],
  selectedId: null,
  loading: false,

  setItems: (items) => set({ items }),
  addItem: (item) => set((s) => ({ items: [item, ...s.items] })),
  updateItem: (id, updates) =>
    set((s) => ({
      items: s.items.map((i) => (i.id === id ? { ...i, ...updates } : i)),
    })),
  removeItem: (id) =>
    set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  setSelected: (id) => set({ selectedId: id }),
  setLoading: (loading) => set({ loading }),
}))
```

### Store index.ts

```typescript
export { use{Name}Store } from './{name}Store'
```

---

## Flujo de Ejecucion

1. **Preguntar** nombre de feature + opciones
2. **Verificar** que `src/features/{name}` no existe ya
3. **Crear** directorios y archivos
4. **Reemplazar** todos los placeholders:
   - `{name}` → nombre en camelCase (ej: `notification`)
   - `{Name}` → nombre en PascalCase (ej: `Notification`)
   - `{table_name}` → nombre de tabla en Supabase (ej: `notifications`)
5. **Verificar tipos**: `npx tsc --noEmit`

---

## Mensaje Final

```
Feature "{name}" creada!

Estructura:
  src/features/{name}/
  ├── components/ — {Name}List, {Name}Card, {Name}Form
  ├── hooks/ — use{Name}s
  ├── services/ — CRUD service
  ├── types/ — Zod schemas + TypeScript types
  └── store/ — Zustand store (si aplica)

Proximos pasos:
  1. Crear migracion SQL para tabla '{table_name}' (usa /supabase-patterns)
  2. Crear server actions en src/actions/{name}.ts (usa /server-action)
  3. Crear pagina en src/app/(main)/{name}/page.tsx
  4. Importar componentes desde features/{name}/components
```
