import { Resend } from 'resend'

// Lazy initialize Resend client to avoid build-time errors
let resendInstance: Resend | null = null

export function getResend(): Resend {
  if (!resendInstance) {
    const apiKey = process.env.RESEND_API_KEY
    if (!apiKey) {
      throw new Error('RESEND_API_KEY is not configured')
    }
    resendInstance = new Resend(apiKey)
  }
  return resendInstance
}

// Email configuration
// Note: Use 'onboarding@resend.dev' for testing without verified domain
// Change to your verified domain in production
export const EMAIL_CONFIG = {
  from: process.env.RESEND_FROM_EMAIL || 'Trader <onboarding@resend.dev>',
  replyTo: 'sinsajo.creators@gmail.com',
}
