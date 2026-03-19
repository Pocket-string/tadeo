'use server'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { z } from 'zod'
import { DEFAULT_STRATEGY_PARAMS } from '@/types/database'

const CreateStrategySchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).nullable().optional(),
})

export async function createStrategy(formData: FormData) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const parsed = CreateStrategySchema.parse({
    name: formData.get('name'),
    description: formData.get('description') || null,
  })

  const { error } = await supabase
    .from('strategies')
    .insert({
      user_id: user.id,
      name: parsed.name,
      description: parsed.description,
      parameters: DEFAULT_STRATEGY_PARAMS,
    })

  if (error) throw new Error(`Failed to create strategy: ${error.message}`)
}

export async function createStrategyFromScanner(input: {
  name: string
  description: string
  parameters: Record<string, number>
}) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const params = { ...DEFAULT_STRATEGY_PARAMS, ...input.parameters }

  const { data, error } = await supabase
    .from('strategies')
    .insert({
      user_id: user.id,
      name: input.name,
      description: `[Scanner] ${input.description}`,
      parameters: params,
    })
    .select('id, name')
    .single()

  if (error) throw new Error(`Failed to create strategy: ${error.message}`)
  return data
}

export async function getStrategies() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/login')

  const { data, error } = await supabase
    .from('strategies')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })

  if (error) throw new Error(`Failed to fetch strategies: ${error.message}`)
  return data ?? []
}
