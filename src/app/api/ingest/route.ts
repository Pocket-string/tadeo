import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ingestFromBinance } from '@/features/market-data/services/ingestPipeline'
import { ingestLimiter } from '@/lib/rate-limit'
import { z } from 'zod'

const IngestRequestSchema = z.object({
  symbol: z.string().min(1).max(20),
  timeframe: z.enum(['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w']),
  startDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
  endDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)),
})

/**
 * POST /api/ingest
 * Triggers data ingestion from Binance for a given symbol/timeframe/date range.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  // Rate limiting: 5 req/min per user
  const { allowed, remaining } = ingestLimiter.check(user.id)
  if (!allowed) {
    return NextResponse.json(
      { error: 'Rate limit exceeded. Max 5 ingestions per minute.' },
      { status: 429, headers: { 'X-RateLimit-Remaining': String(remaining) } }
    )
  }

  const body = await request.json()
  const parsed = IngestRequestSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { symbol, timeframe, startDate, endDate } = parsed.data

  const result = await ingestFromBinance(symbol, timeframe, startDate, endDate)

  if (result.errors.length > 0) {
    return NextResponse.json(
      { ...result, warning: 'Some batches failed' },
      { status: 207 }
    )
  }

  return NextResponse.json(result)
}
