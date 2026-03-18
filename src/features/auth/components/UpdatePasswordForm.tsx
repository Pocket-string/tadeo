'use client'

import { useState } from 'react'
import { updatePassword } from '@/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function UpdatePasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await updatePassword(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    }
  }

  return (
    <form action={handleSubmit} className="space-y-5">
      <Input
        id="password"
        name="password"
        type="password"
        label="Nueva contraseña"
        placeholder="Mínimo 6 caracteres"
        hint="Elige una contraseña segura"
        required
        minLength={6}
      />

      {error && (
        <div className="rounded-lg bg-error-50 border border-error-500 p-3">
          <p className="text-sm text-error-700">{error}</p>
        </div>
      )}

      <Button
        type="submit"
        isLoading={loading}
        className="w-full"
      >
        Actualizar Contraseña
      </Button>
    </form>
  )
}
