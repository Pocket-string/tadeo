---
name: server-action
description: |
  Patron estandarizado de Server Actions en 4 pasos: Auth, Validate, Execute, Side Effects.
  Incluye templates para CRUD, file upload, AI generation, y rate limiting.
  Validado en LinkedIn ContentOps con 20+ server actions en produccion.
allowed-tools:
  - read
  - edit
  - write
---

# /server-action - Patron Estandarizado de Server Actions

Toda Server Action sigue el mismo patron de 4 pasos. Sin excepciones.
Validado en 20+ actions de produccion en LinkedIn ContentOps.

**Paso 1: Pregunta que tipo de action necesita.**
**Paso 2: Genera el codigo completo siguiendo el patron.**

---

## Gotchas Criticos (Aprendidos en Produccion)

> Leer ANTES de implementar cualquier action.

1. **Zod `.nullable().optional()` para inputs de API** — Client envia `null` para campos opcionales, pero Zod `.optional()` solo acepta `undefined`. Usar `.nullable().optional()` para aceptar ambos.
2. **`revalidatePath` causa re-render del server component** — Si tienes un editor con estado local, usa `useRef` flag para saltar el primer useEffect post-save.
3. **Nunca usar `as MyType` para datos externos** — Siempre Zod `.safeParse()`. `as` oculta errores que explotan en runtime.
4. **`formData.get()` retorna `FormDataEntryValue | null`** — Siempre parsear con Zod, nunca confiar en el tipo directo.
5. **Server Actions NO pueden retornar objetos complejos** — Solo plain objects serializables. No Dates, Maps, Sets, o class instances.
6. **`redirect()` lanza internamente** — No poner codigo despues de `redirect()`, nunca se ejecuta.

---

## Pregunta Inicial

Usa AskUserQuestion para preguntar:

**"Que tipo de Server Action necesitas?"**

Opciones:
1. **CRUD Action (Recomendado)** — Create, Read, Update, Delete con Zod validation
2. **Action con Rate Limiting** — Para endpoints publicos o AI
3. **Action con AI Generation** — generateText + Zod validate de respuesta AI
4. **Action con File Upload** — Supabase Storage + validacion de tipo/tamano

---

## El Patron: 4 Pasos

Toda Server Action sigue este flujo exacto:

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth'

// Schema de validacion
const inputSchema = z.object({
  name: z.string().min(1, 'Nombre requerido'),
  email: z.string().email('Email invalido').nullable().optional(),
})

export async function myAction(formData: FormData) {
  // 1. AUTH — verificar sesion
  const user = await requireAuth()

  // 2. VALIDATE — parsear input con Zod
  const parsed = inputSchema.safeParse({
    name: formData.get('name'),
    email: formData.get('email'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos invalidos' }
  }

  // 3. EXECUTE — operacion en Supabase
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('items')
    .insert({ ...parsed.data, user_id: user.id })
    .select()
    .single()

  if (error) return { error: error.message }

  // 4. SIDE EFFECTS — revalidar cache, tracking, redirect
  revalidatePath('/items')
  return { data }
}
```

---

## Template 1: CRUD Action

### Create

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth'

const createSchema = z.object({
  title: z.string().min(1, 'Titulo requerido').max(200),
  description: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'archived']).default('draft'),
})

export async function createItem(formData: FormData) {
  const user = await requireAuth()

  const parsed = createSchema.safeParse({
    title: formData.get('title'),
    description: formData.get('description') || null,
    status: formData.get('status') || 'draft',
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos invalidos' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('items')
    .insert({ ...parsed.data, user_id: user.id })
    .select()
    .single()

  if (error) return { error: error.message }

  revalidatePath('/items')
  return { data }
}
```

### Update

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth'

const updateSchema = z.object({
  id: z.string().uuid('ID invalido'),
  title: z.string().min(1).max(200).optional(),
  description: z.string().nullable().optional(),
  status: z.enum(['draft', 'active', 'archived']).optional(),
})

export async function updateItem(formData: FormData) {
  const user = await requireAuth()

  const parsed = updateSchema.safeParse({
    id: formData.get('id'),
    title: formData.get('title'),
    description: formData.get('description'),
    status: formData.get('status'),
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos invalidos' }
  }

  const { id, ...updates } = parsed.data
  // Remove undefined values
  const cleanUpdates = Object.fromEntries(
    Object.entries(updates).filter(([, v]) => v !== undefined)
  )

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('items')
    .update(cleanUpdates)
    .eq('id', id)
    .eq('user_id', user.id)  // RLS safety: verificar ownership
    .select()
    .single()

  if (error) return { error: error.message }

  revalidatePath('/items')
  revalidatePath(`/items/${id}`)
  return { data }
}
```

### Delete

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth'

const deleteSchema = z.object({
  id: z.string().uuid('ID invalido'),
})

export async function deleteItem(rawId: string) {
  const user = await requireAuth()

  const parsed = deleteSchema.safeParse({ id: rawId })
  if (!parsed.success) {
    return { error: 'ID invalido' }
  }

  const supabase = await createClient()
  const { error } = await supabase
    .from('items')
    .delete()
    .eq('id', parsed.data.id)
    .eq('user_id', user.id)

  if (error) return { error: error.message }

  revalidatePath('/items')
  return { success: true }
}
```

---

## Template 2: Action con Rate Limiting

```typescript
'use server'

import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth'
import { apiRateLimiter } from '@/lib/rate-limit'

const exportSchema = z.object({
  format: z.enum(['csv', 'json', 'xlsx']),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
})

export async function exportData(formData: FormData) {
  const user = await requireAuth()

  // Rate limit por usuario (10 exports por minuto)
  const limit = apiRateLimiter.check(user.id)
  if (!limit.allowed) {
    return { error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' }
  }

  const parsed = exportSchema.safeParse({
    format: formData.get('format'),
    dateFrom: formData.get('dateFrom') || undefined,
    dateTo: formData.get('dateTo') || undefined,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos invalidos' }
  }

  const supabase = await createClient()
  let query = supabase.from('items').select('*').eq('user_id', user.id)

  if (parsed.data.dateFrom) {
    query = query.gte('created_at', parsed.data.dateFrom)
  }
  if (parsed.data.dateTo) {
    query = query.lte('created_at', parsed.data.dateTo)
  }

  const { data, error } = await query
  if (error) return { error: error.message }

  return { data, format: parsed.data.format }
}
```

---

## Template 3: Action con AI Generation

> **CRITICO**: Usar `generateText` + `JSON.parse` + Zod validate para prompts largos. `generateObject` falla con Gemini en inputs >5000 chars.

```typescript
'use server'

import { z } from 'zod'
import { generateText } from 'ai'
import { requireAuth } from '@/lib/auth'
import { aiRateLimiter } from '@/lib/rate-limit'
import { getModel } from '@/shared/lib/ai-router'

// Schema de INPUT
const inputSchema = z.object({
  topic: z.string().min(1, 'Tema requerido'),
  context: z.string().nullable().optional(),
})

// Schema de OUTPUT (lo que esperamos del AI)
const aiOutputSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  tags: z.array(z.string()).min(1),
})

export async function generateContent(formData: FormData) {
  // 1. Auth
  const user = await requireAuth()

  // 2. Rate limit (10 req/min para AI)
  const limit = aiRateLimiter.check(user.id)
  if (!limit.allowed) {
    return { error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' }
  }

  // 3. Validate input
  const parsed = inputSchema.safeParse({
    topic: formData.get('topic'),
    context: formData.get('context') || null,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos invalidos' }
  }

  // 4. Generate with AI (text-based JSON — generateObject fails with long prompts)
  try {
    const result = await generateText({
      model: await getModel('generate-content'),
      system: `Genera contenido en formato JSON. Responde UNICAMENTE con JSON valido, sin markdown, sin backticks.`,
      prompt: `Tema: ${parsed.data.topic}\n${parsed.data.context ? `Contexto: ${parsed.data.context}` : ''}

Responde con: { "title": "...", "summary": "...", "tags": ["..."] }`,
    })

    // 5. Parse + validate AI response
    let jsonText = result.text.trim()
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    let aiData: unknown
    try {
      aiData = JSON.parse(jsonText)
    } catch {
      return { error: 'Error al parsear la respuesta de la IA. Intenta de nuevo.' }
    }

    const validated = aiOutputSchema.safeParse(aiData)
    if (!validated.success) {
      return { error: 'La IA genero un formato invalido. Intenta de nuevo.' }
    }

    return { data: validated.data }
  } catch (error) {
    console.error('[generateContent] AI error:', error)
    return { error: 'Error al generar contenido. Intenta de nuevo.' }
  }
}
```

---

## Template 4: Action con File Upload

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireAuth } from '@/lib/auth'

const MAX_FILE_SIZE = 5 * 1024 * 1024 // 5MB
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']

const uploadSchema = z.object({
  itemId: z.string().uuid(),
  label: z.string().min(1).max(100).optional(),
})

export async function uploadFile(formData: FormData) {
  const user = await requireAuth()

  // Validate metadata
  const parsed = uploadSchema.safeParse({
    itemId: formData.get('itemId'),
    label: formData.get('label') || undefined,
  })
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Datos invalidos' }
  }

  // Validate file
  const file = formData.get('file') as File | null
  if (!file || file.size === 0) {
    return { error: 'Archivo requerido' }
  }
  if (file.size > MAX_FILE_SIZE) {
    return { error: `Archivo demasiado grande. Maximo ${MAX_FILE_SIZE / 1024 / 1024}MB` }
  }
  if (!ALLOWED_TYPES.includes(file.type)) {
    return { error: `Tipo no permitido. Permitidos: ${ALLOWED_TYPES.join(', ')}` }
  }

  // Sanitize filename
  const ext = file.name.split('.').pop()?.toLowerCase() || 'bin'
  const safeName = `${user.id}/${parsed.data.itemId}/${Date.now()}.${ext}`

  const supabase = await createClient()

  // Upload to Supabase Storage
  const { error: uploadError } = await supabase.storage
    .from('uploads')
    .upload(safeName, file, { contentType: file.type })

  if (uploadError) return { error: uploadError.message }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('uploads')
    .getPublicUrl(safeName)

  // Save reference in DB
  const { error: dbError } = await supabase.from('attachments').insert({
    item_id: parsed.data.itemId,
    user_id: user.id,
    file_url: urlData.publicUrl,
    file_name: file.name,
    file_size: file.size,
    file_type: file.type,
    label: parsed.data.label ?? null,
  })

  if (dbError) return { error: dbError.message }

  revalidatePath(`/items/${parsed.data.itemId}`)
  return { data: { url: urlData.publicUrl } }
}
```

---

## Anti-Patron: useRef Flag para revalidatePath

Cuando un editor tiene estado local y usas `revalidatePath`, el server component re-renderiza y pasa nuevos props. Si tu `useEffect` sincroniza props → estado local, sobreescribira lo que el usuario acaba de guardar.

```tsx
'use client'

import { useRef, useEffect, useState } from 'react'

interface EditorProps {
  initialContent: string
  onSave: (content: string) => Promise<void>
}

export function Editor({ initialContent, onSave }: EditorProps) {
  const [content, setContent] = useState(initialContent)
  const justSavedRef = useRef(false)

  // Sincronizar props → estado, EXCEPTO despues de guardar
  useEffect(() => {
    if (justSavedRef.current) {
      justSavedRef.current = false
      return // Skip — ya tenemos el estado correcto post-save
    }
    setContent(initialContent)
  }, [initialContent])

  async function handleSave() {
    justSavedRef.current = true // Flag ANTES de guardar
    await onSave(content)
  }

  return (
    <div>
      <textarea value={content} onChange={(e) => setContent(e.target.value)} />
      <button onClick={handleSave}>Guardar</button>
    </div>
  )
}
```

---

## Flujo de Ejecucion

1. **Preguntar** que tipo de action necesita
2. **Leer** archivos existentes en `src/actions/` para no duplicar
3. **Generar** la action siguiendo el template seleccionado
4. **Verificar** que las importaciones existen (auth.ts, rate-limit.ts, supabase/server.ts)
5. **Crear** schemas Zod en el mismo archivo o en `src/shared/types/`

---

## Mensaje Final

```
Server Action creada!

Patron aplicado: {tipo}
Archivo: src/actions/{nombre}.ts

Estructura:
  1. Auth — requireAuth()
  2. Validate — Zod safeParse
  3. Execute — Supabase query
  4. Side Effects — revalidatePath

Gotchas recordar:
  - .nullable().optional() para campos que pueden ser null
  - Nunca usar `as MyType` — siempre Zod parse
  - revalidatePath causa re-render: useRef flag si hay editor
```
