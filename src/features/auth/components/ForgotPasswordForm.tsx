'use client'

import { useState } from 'react'
import { resetPassword } from '@/actions/auth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

export function ForgotPasswordForm() {
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)
  const [loading, setLoading] = useState(false)

  async function handleSubmit(formData: FormData) {
    setLoading(true)
    setError(null)

    const result = await resetPassword(formData)

    if (result?.error) {
      setError(result.error)
      setLoading(false)
    } else {
      setSuccess(true)
      setLoading(false)
    }
  }

  if (success) {
    return (
      <div className="rounded-lg bg-success-50 border border-success-500 p-6 text-center">
        <div className="mb-3">
          <svg className="w-12 h-12 mx-auto text-success-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
        </div>
        <p className="text-success-700 font-medium">Revisa tu correo electrónico</p>
        <p className="text-success-600 text-sm mt-1">Te hemos enviado un enlace para restablecer tu contraseña.</p>
      </div>
    )
  }

  return (
    <form action={handleSubmit} className="space-y-5">
      <Input
        id="email"
        name="email"
        type="email"
        label="Correo electrónico"
        placeholder="tu@email.com"
        hint="Te enviaremos un enlace para restablecer tu contraseña"
        required
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
        Enviar Enlace
      </Button>
    </form>
  )
}
