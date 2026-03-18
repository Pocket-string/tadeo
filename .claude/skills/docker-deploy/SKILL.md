---
name: docker-deploy
description: |
  Deploy completo con Docker + Dokploy + Traefik en VPS.
  Multi-stage Dockerfile optimizado para Next.js 16, Docker Compose con HTTPS automatico,
  cache management, SSH setup, y health checks.
  Validado en produccion con LinkedIn ContentOps + Soiling Calculator en VPS con Dokploy.
allowed-tools:
  - bash
  - read
  - edit
  - write
---

# /docker-deploy - Deploy con Docker + Dokploy

Deploy completo para produccion en VPS con Docker, Dokploy, y Traefik.
Cada modulo ha sido validado en produccion real con multiples proyectos.

**Paso 1: Pregunta que modulos aplicar.**
**Paso 2: Genera configuracion completa.**

---

## Gotchas Criticos (Aprendidos en Produccion)

> Leer ANTES de implementar cualquier modulo.

1. **NUNCA usar `/admin/` como path** — Traefik intercepta `/admin/` con redirect 307. Usar `/panel/` o `/dashboard/` en su lugar.
2. **Docker build cache se acumula** — 30 deploys en 24h con `cleanCache: true` acumularon 42.9GB. Cron diario con `docker builder prune` es obligatorio.
3. **No usar `cleanCache: true` en Dokploy** — Solo activar si cambian dependencias. Cada build limpio reconstruye node_modules desde cero.
4. **`output: 'standalone'` es obligatorio** — Sin esto, el Docker runner necesita todo node_modules (~500MB+). Con standalone, el runner pesa ~80-120MB.
5. **`mkdir -p public` en Dockerfile** — Next.js standalone falla si `/public` no existe, incluso si esta vacio.
6. **NODE_OPTIONS max-old-space-size** — VPS pequenos (2-4GB RAM) necesitan limitar memoria del build. Usar 384-512MB.
7. **NEXT_PUBLIC_* se inyectan en build-time** — Deben ser ARGs en el Dockerfile, no solo env vars en runtime. Las env vars normales (server-side) se inyectan en runtime.
8. **Deploy DESPUES de migracion** — El orden es: `apply_migration` -> deploy. Nunca al reves o tendras runtime crashes.
9. **SSH con alias desde dia 0** — Configurar `~/.ssh/config` con alias + key dedicada. Perder acceso SSH al VPS es catastrofico.

---

## Pregunta Inicial

Usa AskUserQuestion con multiSelect:true para preguntar:

**"Que modulos de deploy quieres configurar?"**

Opciones:
1. **Dockerfile + next.config.ts (Recomendado)** — Multi-stage build optimizado para Next.js + pnpm
2. **Docker Compose** — Orquestacion con Traefik reverse proxy + HTTPS automatico
3. **Dokploy Config** — Configuracion especifica para Dokploy (alternativa a Compose manual)
4. **Cache + Logs Management** — Cron para docker builder prune + log rotation
5. **SSH Setup** — Alias + key dedicada + sudoers passwordless
6. **Health Checks** — Endpoint /api/health + Docker HEALTHCHECK

Si el usuario dice "all" o "todo", aplica todos los modulos.

---

## Modulo 1: Dockerfile + next.config.ts

### 1.1 next.config.ts — Habilitar standalone

```typescript
// next.config.ts
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
          {
            key: 'Content-Security-Policy',
            value: [
              "default-src 'self'",
              "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
              "style-src 'self' 'unsafe-inline'",
              "img-src 'self' blob: data: https:",
              "font-src 'self' data:",
              "connect-src 'self' https://*.supabase.co wss://*.supabase.co",
              "frame-ancestors 'none'",
            ].join('; '),
          },
        ],
      },
    ]
  },
}

export default nextConfig
```

> **NOTA**: Si usas AI (OpenRouter, Gemini, OpenAI), agregar dominios a `connect-src`:
> `https://openrouter.ai https://generativelanguage.googleapis.com https://api.openai.com`

### 1.2 Dockerfile — Multi-stage optimizado

```dockerfile
# --- Base ---
FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile && \
    pnpm store prune 2>/dev/null || true

# --- Builder ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Next.js standalone necesita /public (incluso vacio)
RUN mkdir -p public

# Build-time env vars (NEXT_PUBLIC_* se inyectan en build)
ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL

# Limitar memoria para VPS pequenos (ajustar segun RAM disponible)
ENV NODE_OPTIONS="--max-old-space-size=512"

RUN pnpm run build

# --- Runner (imagen minima de produccion) ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# Usuario no-root por seguridad
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copiar SOLO standalone output + assets estaticos (sin node_modules, sin source)
COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

### 1.3 .dockerignore

```
node_modules
.next
.git
.env
.env.local
.env*.local
*.md
.vscode
.claude
.github
coverage
__tests__
*.test.ts
*.test.tsx
*.spec.ts
*.spec.tsx
```

### 1.4 Variante: npm en vez de pnpm

Si el proyecto usa npm en vez de pnpm:

```dockerfile
# --- Base ---
FROM node:20-alpine AS base

# --- Dependencies ---
FROM base AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

# --- Builder ---
FROM base AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN mkdir -p public

ARG NEXT_PUBLIC_SUPABASE_URL
ARG NEXT_PUBLIC_SUPABASE_ANON_KEY
ARG NEXT_PUBLIC_SITE_URL

ENV NODE_OPTIONS="--max-old-space-size=512"
RUN npm run build

# --- Runner ---
FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

COPY --from=builder /app/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
```

---

## Modulo 2: Docker Compose con Traefik

### 2.1 docker-compose.yml

```yaml
version: '3.8'

services:
  traefik:
    image: traefik:v3.0
    container_name: traefik
    restart: unless-stopped
    command:
      - "--api.dashboard=false"
      - "--providers.docker=true"
      - "--providers.docker.exposedbydefault=false"
      - "--entrypoints.web.address=:80"
      - "--entrypoints.websecure.address=:443"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge=true"
      - "--certificatesresolvers.letsencrypt.acme.httpchallenge.entrypoint=web"
      - "--certificatesresolvers.letsencrypt.acme.email=${ACME_EMAIL}"
      - "--certificatesresolvers.letsencrypt.acme.storage=/letsencrypt/acme.json"
      # Redirect HTTP -> HTTPS
      - "--entrypoints.web.http.redirections.entryPoint.to=websecure"
      - "--entrypoints.web.http.redirections.entryPoint.scheme=https"
    ports:
      - "80:80"
      - "443:443"
    volumes:
      - "/var/run/docker.sock:/var/run/docker.sock:ro"
      - "letsencrypt:/letsencrypt"
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

  app:
    build:
      context: .
      dockerfile: Dockerfile
      args:
        - NEXT_PUBLIC_SUPABASE_URL=${NEXT_PUBLIC_SUPABASE_URL}
        - NEXT_PUBLIC_SUPABASE_ANON_KEY=${NEXT_PUBLIC_SUPABASE_ANON_KEY}
        - NEXT_PUBLIC_SITE_URL=${NEXT_PUBLIC_SITE_URL}
    container_name: ${APP_NAME:-myapp}
    restart: unless-stopped
    environment:
      - NODE_ENV=production
      - SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY}
      - RESEND_API_KEY=${RESEND_API_KEY}
      # Agregar mas env vars server-side aqui
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.app.rule=Host(`${DOMAIN}`)"
      - "traefik.http.routers.app.entrypoints=websecure"
      - "traefik.http.routers.app.tls.certresolver=letsencrypt"
      - "traefik.http.services.app.loadbalancer.server.port=3000"
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
    logging:
      driver: "json-file"
      options:
        max-size: "10m"
        max-file: "3"

volumes:
  letsencrypt:
```

### 2.2 .env.production (template)

```bash
# --- App ---
APP_NAME=myapp
DOMAIN=myapp.example.com
ACME_EMAIL=admin@example.com

# --- Supabase (build-time + runtime) ---
NEXT_PUBLIC_SUPABASE_URL=https://xxxxx.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
NEXT_PUBLIC_SITE_URL=https://myapp.example.com
SUPABASE_SERVICE_ROLE_KEY=eyJ...

# --- Services (runtime only) ---
RESEND_API_KEY=re_xxxxx

# --- AI (runtime only, si aplica) ---
# GOOGLE_GENERATIVE_AI_API_KEY=AIza...
# OPENAI_API_KEY=sk-...
# OPENROUTER_API_KEY=sk-or-...
```

> **CRITICO**: NUNCA commitear `.env.production`. Agregar a `.gitignore`.

---

## Modulo 3: Dokploy Config

Dokploy es una alternativa a Docker Compose manual. Gestiona builds, deployments, y dominios via UI web.

### 3.1 Configuracion en Dokploy UI

```
1. Crear nuevo proyecto → Application → Docker
2. Conectar repositorio Git (GitHub)
3. Configurar:
   - Branch: main
   - Dockerfile path: ./Dockerfile
   - Build args:
     NEXT_PUBLIC_SUPABASE_URL = https://xxxxx.supabase.co
     NEXT_PUBLIC_SUPABASE_ANON_KEY = eyJ...
     NEXT_PUBLIC_SITE_URL = https://myapp.example.com
   - Environment variables (runtime):
     SUPABASE_SERVICE_ROLE_KEY = eyJ...
     RESEND_API_KEY = re_xxxxx
4. Dominio:
   - Agregar dominio personalizado
   - Habilitar HTTPS (Let's Encrypt automatico)
   - Redirect HTTP -> HTTPS
5. Advanced:
   - Clean cache: OFF (solo activar si cambian deps)
   - Health check path: /api/health
   - Port: 3000
```

### 3.2 Gotchas de Dokploy

```markdown
- cleanCache: true reconstruye todo desde cero. Solo activar cuando cambien dependencias.
  En operacion normal, Docker layer caching es suficiente.
- Dokploy usa Traefik internamente. NO agregar Traefik en docker-compose si usas Dokploy.
- El path /admin/ esta reservado por Traefik. NUNCA usar /admin/ en tus rutas de Next.js.
- Build args en Dokploy se pasan automaticamente al Dockerfile ARG.
- Si el build falla por memoria, reducir NODE_OPTIONS max-old-space-size.
```

---

## Modulo 4: Cache + Logs Management

### 4.1 Cron: Docker builder prune diario

```bash
# /etc/cron.d/docker-cleanup
# Limpiar cache de Docker builds diariamente a las 3 AM
0 3 * * * root docker builder prune -f --filter "until=48h" >> /var/log/docker-cleanup.log 2>&1

# Limpiar imagenes sin usar semanalmente (domingo 4 AM)
0 4 * * 0 root docker image prune -a -f --filter "until=168h" >> /var/log/docker-cleanup.log 2>&1
```

### 4.2 Script de mantenimiento

```bash
#!/bin/bash
# /opt/scripts/docker-maintenance.sh
# Ejecutar manualmente o via cron

set -euo pipefail

echo "=== Docker Maintenance $(date) ==="

# 1. Limpiar build cache (> 48h)
echo "Cleaning build cache..."
docker builder prune -f --filter "until=48h"

# 2. Limpiar imagenes dangling
echo "Cleaning dangling images..."
docker image prune -f

# 3. Limpiar containers parados
echo "Cleaning stopped containers..."
docker container prune -f

# 4. Mostrar uso de disco
echo "Disk usage:"
docker system df

echo "=== Done ==="
```

```bash
# Hacer ejecutable
chmod +x /opt/scripts/docker-maintenance.sh
```

### 4.3 Docker daemon log rotation

```json
// /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  }
}
```

```bash
# Aplicar cambios
sudo systemctl restart docker
```

> **NOTA**: Tambien configurar log rotation por servicio en docker-compose.yml (ya incluido en Modulo 2).

### 4.4 Monitoreo de disco

```bash
#!/bin/bash
# /opt/scripts/check-disk.sh
# Alerta si disco supera 85%

THRESHOLD=85
USAGE=$(df / | tail -1 | awk '{print $5}' | sed 's/%//')

if [ "$USAGE" -gt "$THRESHOLD" ]; then
  echo "ALERTA: Disco al ${USAGE}% — ejecutar docker-maintenance.sh"
  # Opcionalmente enviar email o webhook
fi
```

---

## Modulo 5: SSH Setup

### 5.1 Crear key dedicada por proyecto

```bash
# En tu maquina local
ssh-keygen -t ed25519 -C "deploy@myapp" -f ~/.ssh/id_ed25519_myapp

# Copiar la clave publica al VPS
ssh-copy-id -i ~/.ssh/id_ed25519_myapp.pub usuario@IP_VPS
```

### 5.2 SSH Config con alias

```bash
# ~/.ssh/config

Host vps-myapp
  HostName 123.45.67.89
  User deployer
  IdentityFile ~/.ssh/id_ed25519_myapp
  IdentitiesOnly yes
  ServerAliveInterval 60
  ServerAliveCountMax 3

# Uso:
# ssh vps-myapp
# scp archivo.txt vps-myapp:/path/
```

### 5.3 Usuario deployer con sudoers

```bash
# En el VPS (como root)

# Crear usuario deployer
adduser deployer
usermod -aG docker deployer

# Sudoers passwordless para comandos especificos
cat > /etc/sudoers.d/deployer << 'EOF'
# Docker operations
deployer ALL=(ALL) NOPASSWD: /usr/bin/docker
deployer ALL=(ALL) NOPASSWD: /usr/bin/docker-compose
deployer ALL=(ALL) NOPASSWD: /bin/systemctl restart docker
deployer ALL=(ALL) NOPASSWD: /opt/scripts/docker-maintenance.sh
EOF

chmod 440 /etc/sudoers.d/deployer
```

### 5.4 Checklist SSH desde dia 0

```markdown
- [ ] Crear key ed25519 dedicada para el proyecto
- [ ] Configurar ~/.ssh/config con alias
- [ ] Copiar clave publica al VPS
- [ ] Crear usuario deployer (no usar root)
- [ ] Agregar deployer al grupo docker
- [ ] Configurar sudoers passwordless para docker
- [ ] Verificar conexion: `ssh vps-myapp`
- [ ] Guardar backup de la clave privada en lugar seguro
```

---

## Modulo 6: Health Checks

### 6.1 API Health Endpoint

```typescript
// src/app/api/health/route.ts
import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  const checks: Record<string, 'ok' | 'error'> = {
    server: 'ok',
    database: 'error',
  }

  // Check Supabase connection
  try {
    const supabase = await createClient()
    const { error } = await supabase.from('profiles').select('id').limit(1)
    checks.database = error ? 'error' : 'ok'
  } catch {
    checks.database = 'error'
  }

  const allOk = Object.values(checks).every((v) => v === 'ok')

  return NextResponse.json(
    {
      status: allOk ? 'healthy' : 'degraded',
      checks,
      timestamp: new Date().toISOString(),
    },
    { status: allOk ? 200 : 503 }
  )
}
```

### 6.2 Health check simple (sin DB)

Si no necesitas verificar la base de datos:

```typescript
// src/app/api/health/route.ts
import { NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'

export async function GET() {
  return NextResponse.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
  })
}
```

### 6.3 Docker HEALTHCHECK en Dockerfile

Agregar al final del Dockerfile (antes de CMD):

```dockerfile
# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=40s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1
```

### 6.4 Docker Compose health check

Ya incluido en el Modulo 2 (`docker-compose.yml`), pero aqui esta aislado:

```yaml
services:
  app:
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s
```

> **Por que `wget` y no `curl`?** — La imagen `node:20-alpine` incluye `wget` pero NO `curl`. Usar `wget --spider` para check sin descargar body.

---

## Flujo de Ejecucion

1. **Preguntar** que modulos aplicar (multiSelect)
2. **Detectar** package manager del proyecto (pnpm vs npm)
3. **Verificar** que `next.config.ts` existe y agregar `output: 'standalone'`
4. **Crear** archivos segun modulos seleccionados:
   - Modulo 1: Dockerfile + .dockerignore + next.config.ts update
   - Modulo 2: docker-compose.yml + .env.production template
   - Modulo 3: Instrucciones de Dokploy (no archivos)
   - Modulo 4: Scripts de mantenimiento (instrucciones para VPS)
   - Modulo 5: Instrucciones SSH (ejecutar en local + VPS)
   - Modulo 6: src/app/api/health/route.ts + HEALTHCHECK en Dockerfile
5. **Verificar** build local: `docker build -t test .`
6. **Mostrar** resumen con proximos pasos

---

## Orden de Deploy (Checklist Final)

```markdown
## Pre-Deploy
- [ ] Migraciones SQL aplicadas en Supabase
- [ ] RLS habilitado en todas las tablas nuevas
- [ ] `output: 'standalone'` en next.config.ts
- [ ] .env.production configurado en VPS/Dokploy
- [ ] Health check endpoint creado
- [ ] .dockerignore actualizado

## Deploy
- [ ] Build Docker exitoso
- [ ] Container arranca sin errores
- [ ] Health check responde 200
- [ ] HTTPS activo (Let's Encrypt)
- [ ] Dominio resuelve correctamente

## Post-Deploy
- [ ] Verificar funcionalidad en produccion
- [ ] Cron de limpieza Docker configurado
- [ ] Log rotation configurado
- [ ] SSH alias configurado para el equipo
```

---

## Mensaje Final

```
Deploy configurado!

Modulos aplicados:
  [x] Dockerfile — Multi-stage build (4 etapas: base, deps, builder, runner)
  [x] Docker Compose — Traefik + HTTPS automatico + log rotation
  [x] Dokploy Config — Configuracion lista para Dokploy UI
  [x] Cache + Logs — Cron diario de limpieza + daemon log rotation
  [x] SSH Setup — Key dedicada + alias + deployer user
  [x] Health Checks — /api/health + Docker HEALTHCHECK

Gotchas recordar:
  - NUNCA /admin/ path (Traefik intercepta)
  - cleanCache: OFF en Dokploy (solo si cambian deps)
  - Migracion ANTES de deploy, nunca al reves
  - Cron diario de docker builder prune (30 deploys = 42.9GB)
  - SSH con alias desde dia 0

Orden de deploy:
  1. Aplicar migraciones SQL
  2. Build + deploy Docker
  3. Verificar health check
  4. Verificar HTTPS
```
