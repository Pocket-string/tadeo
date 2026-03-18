/**
 * Simple in-memory rate limiter.
 * Pattern: harden skill - rate limiting per user.id
 */

interface RateLimitEntry {
  count: number
  resetAt: number
}

const store = new Map<string, RateLimitEntry>()

// Cleanup old entries every 5 minutes
if (typeof setInterval !== 'undefined') {
  setInterval(() => {
    const now = Date.now()
    for (const [key, entry] of store) {
      if (entry.resetAt < now) store.delete(key)
    }
  }, 5 * 60 * 1000)
}

export interface RateLimitConfig {
  maxRequests: number
  windowMs: number
}

export function createRateLimiter(config: RateLimitConfig) {
  return {
    check(identifier: string): { allowed: boolean; remaining: number; resetAt: number } {
      const now = Date.now()
      const key = identifier
      const entry = store.get(key)

      if (!entry || entry.resetAt < now) {
        store.set(key, { count: 1, resetAt: now + config.windowMs })
        return { allowed: true, remaining: config.maxRequests - 1, resetAt: now + config.windowMs }
      }

      if (entry.count >= config.maxRequests) {
        return { allowed: false, remaining: 0, resetAt: entry.resetAt }
      }

      entry.count++
      return { allowed: true, remaining: config.maxRequests - entry.count, resetAt: entry.resetAt }
    },
  }
}

// Pre-configured limiters
export const apiLimiter = createRateLimiter({ maxRequests: 30, windowMs: 60_000 })
export const ingestLimiter = createRateLimiter({ maxRequests: 5, windowMs: 60_000 })
export const aiLimiter = createRateLimiter({ maxRequests: 10, windowMs: 60_000 })
