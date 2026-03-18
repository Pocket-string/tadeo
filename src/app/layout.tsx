import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Trader | Sistema de Trading Algoritmico',
  description: 'Sistema agentico de trading algoritmico end-to-end. Backtesting, generacion de senales y ejecucion automatizada.',
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
