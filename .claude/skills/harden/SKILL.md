---
name: harden
description: |
  Aplica capas de seguridad, infraestructura y patrones probados a un proyecto SaaS Factory.
  Cada modulo ha sido validado en produccion real con Dokploy + Traefik + Supabase + Resend.
  Extraido de aprendizajes reales de 4+ proyectos en produccion.
allowed-tools:
  - bash
  - read
  - edit
  - write
---

# /harden - SaaS Hardening Kit

Aplica capas de seguridad, infraestructura y patrones probados a un proyecto SaaS Factory.
Cada modulo ha sido validado en produccion real con Dokploy + Traefik + Supabase + Resend.

**Paso 1: Pregunta al usuario que modulos aplicar.**
**Paso 2: Ejecuta SOLO los modulos seleccionados.**

---

## Gotchas Criticos (Aprendidos en Produccion)

> Leer ANTES de implementar cualquier modulo.

1. **NUNCA usar `/admin/` como path de ruta** — Dokploy/Traefik intercepta `/admin/*` con 307 redirect. Usar `/panel/` en su lugar.
2. **`getProfile` DEBE usar `createServiceClient()`** — La tabla `profiles` tiene RLS. El user client no puede leer otros profiles ni hacer bootstrap de admin.
3. **`sha256` usar Node.js `crypto`** (sync) en server-side, NO Web Crypto API (async). Es mas simple y no requiere `await`.
4. **`RESEND_FROM_EMAIL` puede ser `"App Name <email@domain>"`** — No usar `.email()` en Zod, usar `.min(1)`.
5. **`NEXT_PUBLIC_SITE_URL` usar `.default('http://localhost:3000')`** — NO `.optional()`, para que siempre tenga un valor.
6. **Env validation usar `safeParse()`** con errores formateados, no `.parse()` directo que da errores cripticos.
7. **RLS en la MISMA migracion que CREATE TABLE** — Nunca crear tabla sin policies, ni separar en otra migracion.
8. **Nunca usar `as MyType` para datos externos** — Usar Zod parse. `as` oculta errores que explotan en runtime.
9. **`revalidatePath` causa re-render** — En editores con estado local, usar `useRef` flag para saltar el primer useEffect post-save.

---

## Pregunta Inicial

Usa AskUserQuestion con multiSelect:true para preguntar:

**"Que modulos de hardening quieres aplicar?"**

Opciones:
1. **Core Security (Recomendado)** — Env validation, security headers, rate limiting, .gitignore
2. **Auth + Middleware** — requireAuth, requireAdmin, middleware, profiles con access_level + trial
3. **Email** — Resend transaccional con lazy init y reply-to separado
4. **Tracking** — Funnel analytics fire-and-forget con lead tracking
5. **API Keys** — SHA-256 hashing, scopes, Bearer auth
6. **UI Kit** — 7 componentes base (Button, Card, Input, Select, Badge, ConfirmDialog, KPICard)

Si el usuario dice "all" o "todo", aplica todos los modulos.

---

## Modulo 1: Core Security

**Siempre verificar ANTES de crear:** Lee los archivos existentes. Si ya existen, MERGEA en vez de sobreescribir.

### 1.1 Instalar Zod (si no esta)

Ejecutar: `npm install zod` (o `pnpm add zod` si el proyecto usa pnpm).

### 1.2 `src/lib/env.ts`

```typescript
import { z } from 'zod'

const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url('NEXT_PUBLIC_SUPABASE_URL debe ser una URL valida'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY es requerida'),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1).optional(),
  ADMIN_EMAIL: z.string().email().optional(),
  RESEND_API_KEY: z.string().min(1).optional(),
  RESEND_FROM_EMAIL: z.string().min(1).optional(), // Permite "App <email>" format
  RESEND_REPLY_TO: z.string().email().optional(),
  NEXT_PUBLIC_SITE_URL: z.string().url().default('http://localhost:3000'),
})

const clientSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  NEXT_PUBLIC_SITE_URL: z.string().url().default('http://localhost:3000'),
})

type ServerEnv = z.infer<typeof serverSchema>
type ClientEnv = z.infer<typeof clientSchema>

function parseServerEnv(): ServerEnv {
  const result = serverSchema.safeParse(process.env)
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Variables de entorno invalidas:\n${formatted}`)
  }
  return result.data
}

function parseClientEnv(): ClientEnv {
  const result = clientSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    NEXT_PUBLIC_SITE_URL: process.env.NEXT_PUBLIC_SITE_URL,
  })
  if (!result.success) {
    const formatted = result.error.issues
      .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
      .join('\n')
    throw new Error(`Variables de entorno (client) invalidas:\n${formatted}`)
  }
  return result.data
}

/** Server-only env vars. Throws at import time if invalid. Proxy-guarded on client. */
export const serverEnv: ServerEnv =
  typeof window === 'undefined'
    ? parseServerEnv()
    : (new Proxy({} as ServerEnv, {
        get() {
          throw new Error('serverEnv no puede usarse en el cliente')
        },
      }))

/** Client-safe env vars (only NEXT_PUBLIC_*). Safe to import anywhere. */
export const clientEnv: ClientEnv = parseClientEnv()
```

### 1.3 Security Headers — mergear en `next.config.ts`

Agregar al `nextConfig` existente (NO sobreescribir el archivo):

```typescript
const securityHeaders = [
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
]

// Dentro del objeto nextConfig:
{
  poweredByHeader: false,
  async headers() {
    return [{ source: '/(.*)', headers: securityHeaders }]
  },
}
```

### 1.4 `src/lib/rate-limit.ts`

```typescript
interface RateLimitEntry {
  count: number
  resetAt: number
}

interface RateLimiterOpts {
  maxRequests: number
  windowMs: number
}

interface RateLimitResult {
  allowed: boolean
  remaining: number
  retryAfterMs?: number
}

const stores = new Map<string, Map<string, RateLimitEntry>>()

export function createRateLimiter(opts: RateLimiterOpts) {
  const id = `${opts.maxRequests}-${opts.windowMs}`
  if (!stores.has(id)) stores.set(id, new Map())
  const store = stores.get(id)!

  return {
    check(key: string): RateLimitResult {
      const now = Date.now()
      const entry = store.get(key)

      if (!entry || now > entry.resetAt) {
        store.set(key, { count: 1, resetAt: now + opts.windowMs })
        return { allowed: true, remaining: opts.maxRequests - 1 }
      }

      if (entry.count >= opts.maxRequests) {
        return {
          allowed: false,
          remaining: 0,
          retryAfterMs: entry.resetAt - now,
        }
      }

      entry.count++
      return { allowed: true, remaining: opts.maxRequests - entry.count }
    },
  }
}

/** Pre-configured rate limiters */
export const apiRateLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 })
export const aiRateLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 })
export const authRateLimiter = createRateLimiter({ maxRequests: 5, windowMs: 300_000 })
```

### 1.5 Verificar `.gitignore`

Asegurar que estas lineas existan (agregar las que falten):

```gitignore
# Secrets
.env
.env.local
.env*.local
!.env.example

# Claude Code
.claude/settings.local.json
*.mcp.json
!example.mcp.json
```

### 1.6 Crear `.env.example` si no existe

```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key

# App
NEXT_PUBLIC_SITE_URL=http://localhost:3000

# Admin (email del primer admin)
ADMIN_EMAIL=admin@your-app.com

# Email (Resend)
RESEND_API_KEY=re_xxxxxxxxxxxx
RESEND_FROM_EMAIL=Your App <noreply@your-app.com>
RESEND_REPLY_TO=hello@your-app.com
```

---

## Modulo 2: Auth + Middleware

### 2.1 `src/lib/auth.ts`

> **CRITICO**: `getProfile` usa `createServiceClient()` para bypass RLS. Si usas `createClient()` el user NO podra leer su propio profile durante bootstrap.

```typescript
import { redirect } from 'next/navigation'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { serverEnv } from '@/lib/env'
import { createHash } from 'crypto'

/** Verifica sesion activa. Si no hay sesion, redirige a /login. */
export async function requireAuth() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')
  return user
}

/** Obtiene el profile (service client para bypass RLS). */
export async function getProfile(userId: string) {
  const supabase = createServiceClient()
  const { data } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle()  // No lanza error si no existe (vs .single())
  return data
}

/** Obtiene el usuario actual sin redirigir (puede ser null). */
export async function getOptionalUser() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  return user
}

/** Verifica sesion activa + rol admin. Si no cumple, redirige. */
export async function requireAdmin() {
  const user = await requireAuth()

  // Check profiles table first
  const profile = await getProfile(user.id)
  if (profile?.access_level === 'admin') return user

  // Fallback: email-based check (for bootstrapping)
  if (serverEnv.ADMIN_EMAIL && user.email === serverEnv.ADMIN_EMAIL) return user

  redirect('/dashboard')  // Ruta principal autenticada
}

/** Verifica si la suscripcion esta activa. Retorna null si OK, o mensaje de error. */
export async function requireActiveSubscription(userId: string): Promise<string | null> {
  const profile = await getProfile(userId)
  if (!profile) return null
  if (profile.access_level === 'admin' || profile.access_level === 'paid') return null
  if (profile.trial_ends_at && new Date(profile.trial_ends_at) < new Date()) {
    return 'Tu periodo de prueba ha expirado. Contactanos para continuar.'
  }
  return null
}

/** SHA-256 hash usando Node.js crypto (sync, sin deps externas). */
export function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}
```

### 2.2 `src/lib/supabase/middleware.ts`

```typescript
import { createServerClient, type CookieOptions } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

type CookieToSet = { name: string; value: string; options: CookieOptions }

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet: CookieToSet[]) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const {
    data: { user },
  } = await supabase.auth.getUser()

  return { user, supabaseResponse }
}
```

### 2.3 `src/middleware.ts`

> **IMPORTANTE**: NUNCA usar `/admin/` como prefijo — Traefik lo intercepta. Usar `/panel/` para rutas admin.

```typescript
import { NextResponse, type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

const PUBLIC_ROUTES = new Set([
  '/',
  '/login',
  '/register',
  '/signup',
  '/forgot-password',
  '/reset-password',
  '/check-email',
])

const PUBLIC_PREFIXES = ['/auth/', '/book/', '/api/booking/public']

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Allow public routes
  if (PUBLIC_ROUTES.has(pathname) || PUBLIC_PREFIXES.some((p) => pathname.startsWith(p))) {
    const { supabaseResponse } = await updateSession(request)
    return supabaseResponse
  }

  // Check auth for protected routes
  const { user, supabaseResponse } = await updateSession(request)

  if (!user) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|api/(?!booking)|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
  ],
}
```

### 2.4 Migracion: Tabla profiles

Crear archivo `supabase/migrations/XXX_profiles.sql` (usar siguiente numero disponible):

```sql
-- Profiles: extends auth.users with app-specific data
CREATE TABLE IF NOT EXISTS profiles (
  id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  email text NOT NULL,
  full_name text,
  display_name text,
  avatar_url text,
  access_level text NOT NULL DEFAULT 'free'
    CHECK (access_level IN ('admin', 'paid', 'free', 'founding')),
  trial_ends_at timestamptz DEFAULT (now() + interval '30 days'),
  created_at timestamptz DEFAULT now() NOT NULL,
  updated_at timestamptz DEFAULT now() NOT NULL
);

-- RLS (en la MISMA migracion — nunca separado)
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users read own profile"
  ON profiles FOR SELECT
  USING (auth.uid() = id);

CREATE POLICY "Users update own profile"
  ON profiles FOR UPDATE
  USING (auth.uid() = id)
  WITH CHECK (auth.uid() = id);

CREATE POLICY "Admins read all profiles"
  ON profiles FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.access_level = 'admin'
    )
  );

-- Auto-create profile on signup
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger AS $$
BEGIN
  INSERT INTO public.profiles (id, email, full_name)
  VALUES (new.id, new.email, COALESCE(new.raw_user_meta_data->>'full_name', ''));
  RETURN new;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Auto-update updated_at (reutilizable para cualquier tabla)
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON profiles
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
```

Si Supabase MCP esta disponible, aplicar via `apply_migration`. Si no, guardar el archivo SQL e instruir al usuario.

---

## Modulo 3: Email

> **Patron probado**: `from` es la direccion no-reply, `replyTo` es una casilla real monitoreada (ej. via Cloudflare Email Routing a Gmail).

### 3.1 `src/lib/email/resend.ts`

```typescript
import { Resend } from 'resend'
import { serverEnv } from '@/lib/env'

// Lazy initialize Resend client to avoid build-time errors
let resendInstance: Resend | null = null

export function getResend(): Resend {
  if (!resendInstance) {
    if (!serverEnv.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not configured')
    }
    resendInstance = new Resend(serverEnv.RESEND_API_KEY)
  }
  return resendInstance
}

// Email configuration — from y replyTo SEPARADOS
export const EMAIL_CONFIG = {
  from: serverEnv.RESEND_FROM_EMAIL || 'App Name <onboarding@resend.dev>',
  replyTo: serverEnv.RESEND_REPLY_TO || serverEnv.RESEND_FROM_EMAIL || 'noreply@example.com',
}

// Generic send helper
export async function sendEmail(opts: {
  to: string
  subject: string
  text?: string
  html?: string
}): Promise<{ error: string | null }> {
  try {
    const resend = getResend()
    await resend.emails.send({
      from: EMAIL_CONFIG.from,
      replyTo: EMAIL_CONFIG.replyTo,
      to: opts.to,
      subject: opts.subject,
      ...(opts.html ? { html: opts.html } : {}),
      ...(opts.text ? { text: opts.text } : {}),
    })
    return { error: null }
  } catch (err) {
    console.error('[Email] Failed to send:', err)
    return { error: err instanceof Error ? err.message : 'Failed to send email' }
  }
}
```

### 3.2 `src/lib/email/index.ts`

```typescript
export { sendEmail, getResend, EMAIL_CONFIG } from './resend'
```

### 3.3 Verificar dependencia

Ejecutar: `npm install resend` (si no esta instalada). Verificar con `npm ls resend`.

---

## Modulo 4: Tracking

### 4.1 `src/lib/tracking.ts`

```typescript
import { createServiceClient } from '@/lib/supabase/server'

interface TrackEvent {
  event: string
  userId?: string
  leadId?: string
  metadata?: Record<string, unknown>
  ip?: string
}

/** Fire-and-forget event tracking. Never throws — silently logs errors. */
export async function track({ event, userId, leadId, metadata, ip }: TrackEvent): Promise<void> {
  try {
    const supabase = createServiceClient()
    await supabase.from('funnel_events').insert({
      event_name: event,
      user_id: userId ?? null,
      lead_id: leadId ?? null,
      metadata: metadata ?? {},
      ip_address: ip ?? null,
    })
  } catch (e) {
    console.warn('[track] Failed to log event:', event, e)
  }
}
```

### 4.2 Migracion: Tabla funnel_events

```sql
-- Funnel events: analytics tracking con lead + IP tracking
CREATE TABLE funnel_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_name text NOT NULL,
  user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  lead_id uuid,
  metadata jsonb DEFAULT '{}',
  ip_address text,
  created_at timestamptz DEFAULT now() NOT NULL
);

-- RLS: solo admins leen, service role inserta
ALTER TABLE funnel_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Admins read funnel events"
  ON funnel_events FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM profiles p
      WHERE p.id = auth.uid() AND p.access_level = 'admin'
    )
  );

-- Indexes para queries de funnel
CREATE INDEX idx_funnel_events_name_date
  ON funnel_events (event_name, created_at DESC);
CREATE INDEX idx_funnel_events_user
  ON funnel_events (user_id) WHERE user_id IS NOT NULL;
```

> **Nota**: `lead_id` es uuid sin FK por ahora. Cuando se cree tabla `leads`, agregar la FK.

---

## Modulo 5: API Keys

### 5.1 Agregar a `src/lib/auth.ts`

Agregar estas funciones al archivo `auth.ts` existente (del Modulo 2):

```typescript
interface ApiKeyAuth {
  userId: string
  scopes: string[]
}

/**
 * Authenticates a request using an API key (Bearer sk_live_...).
 * Returns the associated userId and scopes, or null if invalid.
 */
export async function authenticateApiKey(
  request: Request,
): Promise<ApiKeyAuth | null> {
  const authHeader = request.headers.get('authorization')
  if (!authHeader?.startsWith('Bearer sk_')) return null

  const rawKey = authHeader.slice(7) // remove "Bearer "
  const keyHash = sha256(rawKey) // sync — usa Node.js crypto

  const supabase = createServiceClient()
  const { data } = await supabase
    .from('api_keys')
    .select('user_id, scopes, is_active')
    .eq('key_hash', keyHash)
    .single()

  if (!data || !data.is_active) return null

  // Update last_used_at (fire-and-forget)
  supabase
    .from('api_keys')
    .update({ last_used_at: new Date().toISOString() })
    .eq('key_hash', keyHash)
    .then(() => {})

  return {
    userId: data.user_id as string,
    scopes: data.scopes as string[],
  }
}
```

### 5.2 `src/actions/api-keys.ts`

```typescript
'use server'

import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { requireAuth, sha256 } from '@/lib/auth'

export async function createApiKey(formData: FormData) {
  const user = await requireAuth()
  const label = formData.get('label') as string
  const scopes = (formData.get('scopes') as string || '').split(',').filter(Boolean)

  if (!label || label.length < 2) {
    return { error: 'Label is required (min 2 chars)' }
  }

  // Generate cryptographic key
  const rawKey = `sk_live_${crypto.randomUUID().replace(/-/g, '')}${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  const keyHash = sha256(rawKey) // sync — Node.js crypto
  const keyPrefix = rawKey.slice(0, 12)

  const supabase = await createClient()
  const { error } = await supabase.from('api_keys').insert({
    user_id: user.id,
    key_hash: keyHash,
    key_prefix: keyPrefix,
    label,
    scopes,
  })

  if (error) return { error: error.message }

  revalidatePath('/settings')
  // Return the raw key ONLY on creation — it will never be shown again
  return { data: { rawKey, keyPrefix, label } }
}

export async function revokeApiKey(keyId: string) {
  const user = await requireAuth()
  const supabase = await createClient()

  const { error } = await supabase
    .from('api_keys')
    .update({ is_active: false })
    .eq('id', keyId)
    .eq('user_id', user.id)

  if (error) return { error: error.message }

  revalidatePath('/settings')
  return { success: true }
}

export async function listApiKeys() {
  const user = await requireAuth()
  const supabase = await createClient()

  const { data, error } = await supabase
    .from('api_keys')
    .select('id, key_prefix, label, scopes, is_active, created_at, last_used_at')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) return { error: error.message }
  return { data }
}
```

### 5.3 Migracion: Tabla api_keys

```sql
-- API Keys: SHA-256 hashed, scoped access
CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  label text NOT NULL,
  scopes text[] NOT NULL DEFAULT '{}',
  is_active boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_at timestamptz DEFAULT now() NOT NULL
);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users manage own API keys"
  ON api_keys FOR ALL
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX idx_api_keys_hash ON api_keys (key_hash) WHERE is_active = true;
CREATE INDEX idx_api_keys_user ON api_keys (user_id);
```

### 5.4 Template de API Route

Crear `src/app/api/v1/_lib/helpers.ts`:

```typescript
import { NextResponse } from 'next/server'
import { authenticateApiKey } from '@/lib/auth'
import { createRateLimiter } from '@/lib/rate-limit'

const apiLimiter = createRateLimiter({ maxRequests: 60, windowMs: 60_000 })

export async function withApiAuth(
  request: Request,
  requiredScope: string,
  handler: (userId: string) => Promise<NextResponse>
): Promise<NextResponse> {
  // Rate limit by IP
  const ip = request.headers.get('x-forwarded-for') || 'unknown'
  const limit = apiLimiter.check(ip)
  if (!limit.allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded', retryAfterMs: limit.retryAfterMs },
      { status: 429 }
    )
  }

  // Authenticate — returns null if invalid
  const auth = await authenticateApiKey(request)
  if (!auth) {
    return NextResponse.json({ error: 'Invalid API key' }, { status: 401 })
  }

  // Check scope
  if (!auth.scopes.includes(requiredScope)) {
    return NextResponse.json(
      { error: `Missing required scope: ${requiredScope}` },
      { status: 403 }
    )
  }

  return handler(auth.userId)
}
```

---

## Modulo 6: UI Kit

### 6.1 `src/components/ui/button.tsx`

```tsx
import { forwardRef, type ButtonHTMLAttributes } from 'react'

type Variant = 'primary' | 'secondary' | 'outline' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: Size
}

const variantClasses: Record<Variant, string> = {
  primary: 'bg-blue-600 text-white hover:bg-blue-700 focus:ring-blue-500',
  secondary: 'bg-gray-100 text-gray-900 hover:bg-gray-200 focus:ring-gray-500',
  outline: 'border border-gray-300 text-gray-700 hover:bg-gray-50 focus:ring-blue-500',
  ghost: 'text-gray-700 hover:bg-gray-100 focus:ring-gray-500',
  danger: 'bg-red-600 text-white hover:bg-red-700 focus:ring-red-500',
}

const sizeClasses: Record<Size, string> = {
  sm: 'px-3 py-1.5 text-sm',
  md: 'px-4 py-2 text-sm',
  lg: 'px-6 py-3 text-base',
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', disabled, children, ...props }, ref) => {
    return (
      <button
        ref={ref}
        disabled={disabled}
        className={`inline-flex items-center justify-center rounded-md font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 ${variantClasses[variant]} ${sizeClasses[size]} ${className}`}
        {...props}
      >
        {children}
      </button>
    )
  }
)
Button.displayName = 'Button'
```

### 6.2 `src/components/ui/card.tsx`

```tsx
interface CardProps {
  children: React.ReactNode
  className?: string
}

export function Card({ children, className = '' }: CardProps) {
  return (
    <div className={`rounded-lg border border-gray-200 bg-white p-6 shadow-sm ${className}`}>
      {children}
    </div>
  )
}

export function CardHeader({ children, className = '' }: CardProps) {
  return <div className={`mb-4 ${className}`}>{children}</div>
}

export function CardTitle({ children, className = '' }: CardProps) {
  return <h3 className={`text-lg font-semibold ${className}`}>{children}</h3>
}

export function CardContent({ children, className = '' }: CardProps) {
  return <div className={className}>{children}</div>
}
```

### 6.3 `src/components/ui/input.tsx`

```tsx
import { forwardRef, type InputHTMLAttributes } from 'react'

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  helperText?: string
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ label, error, helperText, className = '', id, ...props }, ref) => {
    const inputId = id || props.name
    return (
      <div>
        {label && (
          <label htmlFor={inputId} className="block text-sm font-medium text-gray-700 mb-1">
            {label}
          </label>
        )}
        <input
          ref={ref}
          id={inputId}
          className={`block w-full rounded-md border px-3 py-2 text-sm shadow-sm transition-colors focus:outline-none focus:ring-2 focus:ring-offset-0 ${
            error
              ? 'border-red-300 focus:border-red-500 focus:ring-red-500'
              : 'border-gray-300 focus:border-blue-500 focus:ring-blue-500'
          } ${className}`}
          {...props}
        />
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
        {helperText && !error && <p className="mt-1 text-sm text-gray-500">{helperText}</p>}
      </div>
    )
  }
)
Input.displayName = 'Input'
```

### 6.4 `src/components/ui/select.tsx`

```tsx
import { forwardRef, type SelectHTMLAttributes } from 'react'

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  label?: string
  error?: string
  options: { value: string; label: string }[]
  placeholder?: string
}

export const Select = forwardRef<HTMLSelectElement, SelectProps>(
  ({ label, error, options, placeholder, className = '', id, ...props }, ref) => {
    const selectId = id || props.name
    return (
      <div>
        {label && (
          <label htmlFor={selectId} className="block text-sm font-medium text-gray-700 mb-1">
            {label}
          </label>
        )}
        <select
          ref={ref}
          id={selectId}
          className={`block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500 ${className}`}
          {...props}
        >
          {placeholder && <option value="">{placeholder}</option>}
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        {error && <p className="mt-1 text-sm text-red-600">{error}</p>}
      </div>
    )
  }
)
Select.displayName = 'Select'
```

### 6.5 `src/components/ui/badge.tsx`

```tsx
type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info'

interface BadgeProps {
  children: React.ReactNode
  variant?: BadgeVariant
  className?: string
}

const variantClasses: Record<BadgeVariant, string> = {
  default: 'bg-gray-100 text-gray-800',
  success: 'bg-green-100 text-green-800',
  warning: 'bg-yellow-100 text-yellow-800',
  danger: 'bg-red-100 text-red-800',
  info: 'bg-blue-100 text-blue-800',
}

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${variantClasses[variant]} ${className}`}>
      {children}
    </span>
  )
}
```

### 6.6 `src/components/ui/confirm-dialog.tsx`

```tsx
'use client'

import { useState, type ReactNode } from 'react'
import { Button } from './button'

interface ConfirmDialogProps {
  trigger: ReactNode
  title: string
  description: string
  confirmLabel?: string
  onConfirm: () => void | Promise<void>
  variant?: 'danger' | 'primary'
}

export function ConfirmDialog({
  trigger,
  title,
  description,
  confirmLabel = 'Confirm',
  onConfirm,
  variant = 'danger',
}: ConfirmDialogProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleConfirm() {
    setLoading(true)
    try {
      await onConfirm()
    } finally {
      setLoading(false)
      setOpen(false)
    }
  }

  return (
    <>
      <span onClick={() => setOpen(true)} className="cursor-pointer">{trigger}</span>

      {open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="fixed inset-0 bg-black/50" onClick={() => setOpen(false)} />
          <div className="relative z-10 w-full max-w-md rounded-lg bg-white p-6 shadow-xl">
            <h3 className="text-lg font-semibold">{title}</h3>
            <p className="mt-2 text-sm text-gray-600">{description}</p>
            <div className="mt-6 flex justify-end gap-3">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={loading}>
                Cancel
              </Button>
              <Button variant={variant} onClick={handleConfirm} disabled={loading}>
                {loading ? 'Processing...' : confirmLabel}
              </Button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
```

### 6.7 `src/components/ui/kpi-card.tsx`

```tsx
interface KPICardProps {
  label: string
  value: string | number
  sub?: string
  icon?: React.ReactNode
  alert?: boolean
}

export function KPICard({ label, value, sub, icon, alert }: KPICardProps) {
  return (
    <div className={`rounded-lg border p-4 ${alert ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-gray-500">{label}</p>
        {icon && <span className="text-gray-400">{icon}</span>}
      </div>
      <p className={`mt-2 text-2xl font-bold ${alert ? 'text-red-600' : 'text-gray-900'}`}>
        {value}
      </p>
      {sub && <p className="mt-1 text-xs text-gray-500">{sub}</p>}
    </div>
  )
}
```

### 6.8 `src/components/ui/index.ts`

```typescript
export { Button } from './button'
export { Card, CardHeader, CardTitle, CardContent } from './card'
export { Input } from './input'
export { Select } from './select'
export { Badge } from './badge'
export { ConfirmDialog } from './confirm-dialog'
export { KPICard } from './kpi-card'
```

---

## Flujo de Ejecucion

1. **Preguntar** que modulos aplicar (multiSelect)
2. **Leer archivos existentes** antes de crear/editar para NO sobreescribir trabajo previo
3. **Instalar dependencias** faltantes (`npm install zod`, `npm install resend` segun modulos)
4. **Crear archivos** de cada modulo seleccionado
5. **Aplicar migraciones** via Supabase MCP si esta disponible; si no, guardar los `.sql`
6. **Verificar tipos**: `npx tsc --noEmit`
7. **Mostrar resumen** de lo aplicado

---

## Mensaje Final

Despues de aplicar todos los modulos, mostrar:

```
Hardening aplicado!

Modulos instalados:
  [x] Core Security — env.ts (safeParse + Proxy), security headers, rate-limit.ts, .gitignore
  [x] Auth + Middleware — auth.ts (service client), middleware.ts, profiles migration
  [x] Email — resend.ts (lazy init, replyTo separado)
  [x] Tracking — tracking.ts (lead + IP tracking), funnel_events migration
  [x] API Keys — api-keys action, migration, API route helper
  [x] UI Kit — 7 componentes (Button, Card, Input, Select, Badge, ConfirmDialog, KPICard)

Gotchas aplicados:
  - /admin/ path bloqueado por Traefik — usar /panel/ para rutas admin
  - getProfile usa createServiceClient (bypass RLS)
  - sha256 es sync (Node.js crypto, no Web Crypto)
  - RESEND_FROM_EMAIL soporta "App <email>" format
  - serverEnv con Proxy guard anti-client-import

Proximos pasos:
  1. Configura .env.local con tus credenciales de Supabase
  2. Aplica migraciones pendientes (si no se aplicaron via MCP)
  3. npm run dev para verificar que todo funciona

Tu app ahora tiene {N} capas de seguridad desde el dia 0.
```

Marcar solo los modulos que efectivamente se aplicaron.
