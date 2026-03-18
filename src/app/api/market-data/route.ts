import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { ImportCandlesSchema } from '@/features/market-data/types'

/**
 * POST /api/market-data
 * Importa datos OHLCV. Acepta JSON con formato ImportCandlesInput.
 */
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const body = await request.json()
  const parsed = ImportCandlesSchema.safeParse(body)

  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid input', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { symbol, timeframe, candles } = parsed.data

  const rows = candles.map((c: { timestamp: string; open: number; high: number; low: number; close: number; volume: number }) => ({
    symbol,
    timeframe,
    timestamp: c.timestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume,
  }))

  const { error } = await supabase
    .from('ohlcv_candles')
    .upsert(rows, { onConflict: 'symbol,timeframe,timestamp' })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ inserted: rows.length, symbol, timeframe })
}
