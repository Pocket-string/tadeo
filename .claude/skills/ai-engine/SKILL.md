---
name: ai-engine
description: |
  Instala el motor de IA completo: Vercel AI SDK + provider router con fallback automatico,
  cross-model review, BYOK (Bring Your Own Key) por workspace, y rate limiting para endpoints AI.
  Extraido de LinkedIn ContentOps con 10+ endpoints AI en produccion usando Gemini + OpenAI + OpenRouter.
allowed-tools:
  - bash
  - read
  - edit
  - write
---

# /ai-engine - Motor de IA Completo

Instala Vercel AI SDK v5 con router de providers, fallback automatico, cross-model review,
y BYOK multi-tenant. Validado en produccion con 10+ endpoints AI.

**Paso 1: Pregunta que modulos instalar.**
**Paso 2: Ejecuta SOLO los modulos seleccionados.**

---

## Gotchas Criticos (Aprendidos en Produccion)

> Leer ANTES de implementar cualquier modulo.

1. **`generateObject` SIEMPRE falla con inputs largos en Gemini 2.5 Flash** — Falla silenciosamente o retorna JSON malformado cuando el prompt supera ~5000 caracteres. Usar `generateText` + JSON.parse + Zod validate.
2. **Strip markdown fences antes de JSON.parse** — Los modelos a veces envuelven JSON en ` ```json ... ``` `. Siempre limpiar antes de parsear.
3. **AI review es non-blocking** — `reviewCopy()` retorna `null` on failure, NUNCA throw. El usuario recibe su contenido aunque la review falle.
4. **Lazy init de providers** — No instanciar providers a nivel de modulo. Usar funciones factory para evitar errores de build cuando falta API key.
5. **Zod `.nullable().optional()` en schemas de input** — Client puede enviar `null` para campos opcionales.
6. **Rate limit por USER, no por IP** — Para endpoints AI autenticados, limitar por `user.id`. IP solo para endpoints publicos.

---

## Pregunta Inicial

Usa AskUserQuestion con multiSelect:true para preguntar:

**"Que modulos del AI Engine quieres instalar?"**

Opciones:
1. **Setup Base (Recomendado)** — Deps + ai-router.ts con provider fallback
2. **Text Generation** — generateText + JSON.parse + Zod (para prompts largos)
3. **Structured Output** — generateObject con schema Zod (para prompts cortos)
4. **Cross-Model Review** — Un modelo genera, otro critica
5. **BYOK (Bring Your Own Key)** — API keys por workspace en Supabase
6. **Rate Limiting AI** — aiRateLimiter per-user

Si el usuario dice "all" o "todo", aplica todos los modulos.

---

## Modulo 1: Setup Base

### 1.1 Instalar dependencias

```bash
npm install ai @ai-sdk/google @ai-sdk/openai zod
```

### 1.2 `src/shared/lib/gemini.ts`

```typescript
import { createGoogleGenerativeAI } from '@ai-sdk/google'

export const GEMINI_MODEL = 'gemini-2.5-flash-preview-05-20'

/** Default Google provider (uses GOOGLE_AI_API_KEY env var) */
export const google = createGoogleGenerativeAI()

/** Factory for BYOK: create provider with custom API key */
export function createGeminiProvider(apiKey: string) {
  return createGoogleGenerativeAI({ apiKey })
}
```

### 1.3 `src/shared/lib/openai-client.ts`

```typescript
import { createOpenAI } from '@ai-sdk/openai'

export const OPENAI_REVIEW_MODEL = 'gpt-4o-mini'

/** Default OpenAI provider (uses OPENAI_API_KEY env var) */
export const openai = createOpenAI()

/** Factory for BYOK */
export function createOpenAIProvider(apiKey: string) {
  return createOpenAI({ apiKey })
}
```

### 1.4 `src/shared/lib/openrouter.ts`

```typescript
import { createOpenAI } from '@ai-sdk/openai'

export const OPENROUTER_GEMINI_MODEL = 'google/gemini-2.5-flash-preview'

/** Default OpenRouter provider (uses OPENROUTER_API_KEY env var) */
export const openrouter = createOpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
})

/** Factory for BYOK */
export function createOpenRouterProvider(apiKey: string) {
  return createOpenAI({
    baseURL: 'https://openrouter.ai/api/v1',
    apiKey,
  })
}
```

### 1.5 `src/shared/lib/ai-router.ts`

```typescript
import { generateObject } from 'ai'
import type { LanguageModel, ImageModel } from 'ai'
import type { ZodType } from 'zod'
import { google, createGeminiProvider, GEMINI_MODEL } from './gemini'
import { openrouter, createOpenRouterProvider, OPENROUTER_GEMINI_MODEL } from './openrouter'
import { createOpenAIProvider } from './openai-client'

export type AITask =
  | 'generate-content'
  | 'review-content'
  | 'summarize'
  | 'analyze'
  | 'generate-image'
  | string  // extensible

/**
 * Returns the primary model for a given AI task.
 * Supports BYOK: if workspaceId is provided, uses workspace-specific key.
 */
export async function getModel(task: AITask, workspaceId?: string): Promise<LanguageModel> {
  // BYOK: check workspace keys first
  if (workspaceId) {
    try {
      const { getWorkspaceApiKeys } = await import('@/features/settings/services/api-key-service')
      const keys = await getWorkspaceApiKeys(workspaceId)
      if (keys.google) return createGeminiProvider(keys.google)(GEMINI_MODEL)
    } catch {
      // Feature not implemented yet — fall through to default
    }
  }

  if (!process.env.GOOGLE_AI_API_KEY) {
    throw new Error('NO_API_KEY: Configura GOOGLE_AI_API_KEY en .env.local o en Settings > API Keys')
  }
  return google(GEMINI_MODEL)
}

/**
 * Returns the OpenAI provider (for review tasks).
 */
export async function getOpenAIProvider(workspaceId?: string) {
  if (workspaceId) {
    try {
      const { getWorkspaceApiKeys } = await import('@/features/settings/services/api-key-service')
      const keys = await getWorkspaceApiKeys(workspaceId)
      if (keys.openai) return createOpenAIProvider(keys.openai)
    } catch {
      // Fall through
    }
  }
  if (process.env.OPENAI_API_KEY) {
    const { openai } = await import('./openai-client')
    return openai
  }
  return null
}

/**
 * Returns the fallback model (OpenRouter).
 */
async function getFallbackModel(workspaceId?: string): Promise<LanguageModel | null> {
  if (workspaceId) {
    try {
      const { getWorkspaceApiKeys } = await import('@/features/settings/services/api-key-service')
      const keys = await getWorkspaceApiKeys(workspaceId)
      if (keys.openrouter) return createOpenRouterProvider(keys.openrouter)(OPENROUTER_GEMINI_MODEL)
    } catch {
      // Fall through
    }
  }
  if (!process.env.OPENROUTER_API_KEY) return null
  return openrouter(OPENROUTER_GEMINI_MODEL)
}

/**
 * Wraps generateObject with automatic fallback.
 * Tries primary → falls back to OpenRouter → throws original error.
 */
export async function generateObjectWithFallback<T extends ZodType>(options: {
  task: AITask
  schema: T
  system: string
  prompt: string
  workspaceId?: string
}) {
  const primaryModel = await getModel(options.task, options.workspaceId)

  try {
    return await generateObject({
      model: primaryModel,
      schema: options.schema,
      system: options.system,
      prompt: options.prompt,
    })
  } catch (primaryError) {
    console.warn(
      `[ai-router] Primary provider failed for ${options.task}:`,
      primaryError instanceof Error ? primaryError.message : primaryError
    )

    const fallbackModel = await getFallbackModel(options.workspaceId)
    if (!fallbackModel) throw primaryError

    console.info(`[ai-router] Falling back to OpenRouter for ${options.task}`)

    try {
      return await generateObject({
        model: fallbackModel,
        schema: options.schema,
        system: options.system,
        prompt: options.prompt,
      })
    } catch (fallbackError) {
      console.error(
        `[ai-router] Fallback also failed for ${options.task}:`,
        fallbackError instanceof Error ? fallbackError.message : fallbackError
      )
      throw primaryError
    }
  }
}

/**
 * Guard: ensures AI access is available.
 */
export async function requireAIAccess(workspaceId?: string): Promise<void> {
  const hasGlobalKey = !!process.env.GOOGLE_AI_API_KEY
  if (hasGlobalKey) return

  if (workspaceId) {
    try {
      const { getWorkspaceApiKeys } = await import('@/features/settings/services/api-key-service')
      const keys = await getWorkspaceApiKeys(workspaceId)
      if (keys.google) return
    } catch {
      // Fall through
    }
  }

  throw new Error('NO_API_KEY: Configura GOOGLE_AI_API_KEY en .env.local o en Settings > API Keys')
}
```

### 1.6 Agregar env vars a `.env.example`

```bash
# AI Providers
GOOGLE_AI_API_KEY=your-google-ai-key
OPENAI_API_KEY=your-openai-key        # Opcional: para cross-model review
OPENROUTER_API_KEY=your-openrouter-key # Opcional: fallback provider
```

---

## Modulo 2: Text Generation (Prompts Largos)

> **CRITICO**: Para prompts >5000 chars, NUNCA usar `generateObject`. Usar `generateText` + JSON.parse + Zod.

### 2.1 Helper: `generateTextAsJson`

Agregar a `src/shared/lib/ai-router.ts`:

```typescript
import { generateText } from 'ai'

/**
 * Generates text from AI, parses as JSON, and validates with Zod.
 * Use this instead of generateObject for long prompts (>5000 chars).
 *
 * Why: generateObject fails silently with Gemini on long inputs.
 * This pattern: generateText → strip fences → JSON.parse → Zod validate.
 */
export async function generateTextAsJson<T extends ZodType>(options: {
  task: AITask
  schema: T
  system: string
  prompt: string
  workspaceId?: string
}): Promise<{ data: z.infer<T> } | { error: string }> {
  try {
    const model = await getModel(options.task, options.workspaceId)

    const result = await generateText({
      model,
      system: options.system + '\n\nIMPORTANTE: Responde UNICAMENTE con JSON valido, sin markdown, sin backticks, sin texto adicional.',
      prompt: options.prompt,
    })

    // Strip markdown fences if present
    let jsonText = result.text.trim()
    if (jsonText.startsWith('```')) {
      jsonText = jsonText.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '')
    }

    // Parse JSON
    let parsed: unknown
    try {
      parsed = JSON.parse(jsonText)
    } catch {
      console.error(`[ai-router] Failed to parse JSON for ${options.task}:`, jsonText.slice(0, 500))
      return { error: 'Error al parsear la respuesta de la IA. Intenta de nuevo.' }
    }

    // Validate with Zod
    const validated = options.schema.safeParse(parsed)
    if (!validated.success) {
      console.error(`[ai-router] Zod validation failed for ${options.task}:`, validated.error.issues)
      return { error: 'La IA genero un formato invalido. Intenta de nuevo.' }
    }

    return { data: validated.data }
  } catch (error) {
    console.error(`[ai-router] AI error for ${options.task}:`, error)
    return { error: 'Error al generar contenido. Intenta de nuevo.' }
  }
}
```

---

## Modulo 3: Structured Output (Prompts Cortos)

Para prompts cortos (<5000 chars), `generateObject` funciona bien:

```typescript
import { generateObjectWithFallback } from '@/shared/lib/ai-router'
import { z } from 'zod'

const summarySchema = z.object({
  title: z.string(),
  summary: z.string(),
  keyPoints: z.array(z.string()).min(1).max(5),
})

// Uso en un API route o server action:
const result = await generateObjectWithFallback({
  task: 'summarize',
  schema: summarySchema,
  system: 'Eres un asistente que resume textos de forma concisa.',
  prompt: `Resume este texto: ${shortText}`,
  workspaceId,
})

// result.object es tipado como z.infer<typeof summarySchema>
```

---

## Modulo 4: Cross-Model Review

### 4.1 `src/shared/types/ai-review.ts`

```typescript
import { z } from 'zod'

export const contentReviewSchema = z.object({
  score: z.number().min(0).max(10),
  strengths: z.array(z.string()).max(3),
  weaknesses: z.array(z.string()).max(3),
  recommendation: z.string(),
  summary: z.string(),
})

export type ContentReview = z.infer<typeof contentReviewSchema>
```

### 4.2 `src/shared/lib/ai-reviewer.ts`

```typescript
import { generateObject } from 'ai'
import { getOpenAIProvider } from './ai-router'
import { contentReviewSchema } from '../types/ai-review'
import type { ContentReview } from '../types/ai-review'

const REVIEW_MODEL = 'gpt-4o-mini'

/**
 * Reviews generated content using a DIFFERENT model (ChatGPT).
 * Returns null gracefully if no OpenAI key is available.
 *
 * Pattern: Model A generates, Model B reviews. Catches blind spots.
 */
export async function reviewContent(
  content: string,
  contentType: string,
  context: string,
  workspaceId?: string
): Promise<ContentReview | null> {
  const provider = await getOpenAIProvider(workspaceId)
  if (!provider) return null

  try {
    const result = await generateObject({
      model: provider(REVIEW_MODEL),
      schema: contentReviewSchema,
      system: `Eres un editor senior que revisa contenido generado por IA.
Tu trabajo es dar una segunda opinion rapida.

Evalua:
- Claridad y coherencia
- Tono apropiado para el contexto
- Precision de la informacion
- Calidad general

Se conciso y accionable. Maximo 3 fortalezas, 3 debilidades.`,
      prompt: `Evalua este contenido:

**Tipo**: ${contentType}
**Contexto**: ${context}

**Contenido**:
${content}

Proporciona score (0-10), fortalezas, debilidades, recomendacion y resumen de una linea.`,
    })

    return result.object
  } catch (error) {
    console.warn('[ai-reviewer] Review failed:', error instanceof Error ? error.message : error)
    return null  // Non-blocking: never throw
  }
}
```

---

## Modulo 5: BYOK (Bring Your Own Key)

### 5.1 Migracion: Tabla workspace_api_keys

```sql
CREATE TABLE workspace_api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google', 'openai', 'openrouter')),
  encrypted_key text NOT NULL,
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL,
  UNIQUE (workspace_id, provider)
);

ALTER TABLE workspace_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Workspace members manage keys"
  ON workspace_api_keys FOR ALL
  USING (
    workspace_id IN (
      SELECT wm.workspace_id FROM workspace_members wm
      WHERE wm.user_id = auth.uid()
    )
  );

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON workspace_api_keys
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

### 5.2 `src/shared/lib/encryption.ts`

```typescript
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'

const ALGORITHM = 'aes-256-gcm'

function getEncryptionKey(): Buffer {
  const key = process.env.ENCRYPTION_KEY
  if (!key || key.length !== 64) {
    throw new Error('ENCRYPTION_KEY must be a 64-character hex string (32 bytes)')
  }
  return Buffer.from(key, 'hex')
}

export function encrypt(text: string): string {
  const key = getEncryptionKey()
  const iv = randomBytes(16)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(text, 'utf8', 'hex')
  encrypted += cipher.final('hex')
  const authTag = cipher.getAuthTag().toString('hex')
  return `${iv.toString('hex')}:${authTag}:${encrypted}`
}

export function decrypt(encrypted: string): string {
  const key = getEncryptionKey()
  const [ivHex, authTagHex, encryptedText] = encrypted.split(':')
  const iv = Buffer.from(ivHex, 'hex')
  const authTag = Buffer.from(authTagHex, 'hex')
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  let decrypted = decipher.update(encryptedText, 'hex', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}
```

### 5.3 `src/features/settings/services/api-key-service.ts`

```typescript
import { createServiceClient } from '@/lib/supabase/server'
import { encrypt, decrypt } from '@/shared/lib/encryption'

interface WorkspaceKeys {
  google?: string
  openai?: string
  openrouter?: string
}

export async function getWorkspaceApiKeys(workspaceId: string): Promise<WorkspaceKeys> {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('workspace_api_keys')
    .select('provider, encrypted_key')
    .eq('workspace_id', workspaceId)

  if (!data) return {}

  const keys: WorkspaceKeys = {}
  for (const row of data) {
    try {
      const decrypted = decrypt(row.encrypted_key)
      keys[row.provider as keyof WorkspaceKeys] = decrypted
    } catch {
      console.warn(`[api-key-service] Failed to decrypt ${row.provider} key`)
    }
  }
  return keys
}

export async function setWorkspaceApiKey(
  workspaceId: string,
  provider: 'google' | 'openai' | 'openrouter',
  apiKey: string
) {
  const supabase = createServiceClient()
  const encrypted = encrypt(apiKey)

  const { error } = await supabase
    .from('workspace_api_keys')
    .upsert({
      workspace_id: workspaceId,
      provider,
      encrypted_key: encrypted,
    }, { onConflict: 'workspace_id,provider' })

  if (error) throw error
}
```

### 5.4 Agregar a `.env.example`

```bash
# Encryption (generar con: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
ENCRYPTION_KEY=your-64-char-hex-string
```

---

## Modulo 6: Rate Limiting AI

Ya incluido en `/harden` modulo Core Security. Si no se aplico, crear `src/lib/rate-limit.ts` con:

```typescript
import { createRateLimiter } from '@/lib/rate-limit'

// Pre-configured: 10 AI requests per minute per user
export const aiRateLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 })
```

Uso en API route:

```typescript
export async function POST(request: Request) {
  const user = await requireAuth()

  const limit = aiRateLimiter.check(user.id) // Por USER, no por IP
  if (!limit.allowed) {
    return Response.json(
      { error: 'Demasiadas solicitudes. Intenta de nuevo en un momento.' },
      { status: 429 }
    )
  }

  // ... rest of handler
}
```

---

## Flujo de Ejecucion

1. **Preguntar** que modulos instalar (multiSelect)
2. **Instalar deps**: `npm install ai @ai-sdk/google @ai-sdk/openai zod`
3. **Crear archivos** de cada modulo seleccionado
4. **Actualizar** `.env.example` con nuevas variables
5. **Aplicar migraciones** si BYOK seleccionado
6. **Verificar tipos**: `npx tsc --noEmit`
7. **Mostrar resumen**

---

## Mensaje Final

```
AI Engine instalado!

Modulos:
  [x] Setup Base — ai-router.ts con fallback Gemini → OpenRouter
  [x] Text Generation — generateTextAsJson() para prompts largos
  [x] Structured Output — generateObjectWithFallback() para prompts cortos
  [x] Cross-Model Review — Gemini genera, GPT-4o-mini revisa
  [x] BYOK — API keys encriptadas por workspace
  [x] Rate Limiting — 10 req/min por usuario en endpoints AI

Providers configurados:
  - Primary: Google Gemini (gemini-2.5-flash)
  - Review: OpenAI (gpt-4o-mini)
  - Fallback: OpenRouter (configurable)

Gotchas recordar:
  - generateObject falla con prompts largos en Gemini — usar generateTextAsJson
  - Strip markdown fences antes de JSON.parse
  - AI review es non-blocking (retorna null, nunca throw)
  - Rate limit por user.id, no por IP

Proximos pasos:
  1. Configura GOOGLE_AI_API_KEY en .env.local
  2. (Opcional) Configura OPENAI_API_KEY para cross-model review
  3. (Opcional) Configura OPENROUTER_API_KEY para fallback
  4. Crea tu primer endpoint AI en src/app/api/ai/
```
