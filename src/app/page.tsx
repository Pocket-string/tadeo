import Link from 'next/link'

export default function HomePage() {
  return (
    <div className="min-h-screen bg-background flex items-center justify-center">
      <div className="text-center space-y-6 max-w-2xl mx-auto px-6">
        <h1 className="text-display-md md:text-display-xl font-heading font-bold text-foreground">
          Trader
        </h1>
        <p className="text-body-lg md:text-body-xl text-foreground-secondary">
          Sistema agentico de trading algoritmico. Backtesting, senales y ejecucion automatizada.
        </p>
        <div className="flex gap-4 justify-center">
          <Link
            href="/login"
            className="px-6 py-3 bg-primary-500 text-white rounded-xl font-medium hover:bg-primary-600 transition-colors"
          >
            Iniciar Sesion
          </Link>
          <Link
            href="/signup"
            className="px-6 py-3 bg-surface border border-border text-foreground rounded-xl font-medium hover:bg-background transition-colors"
          >
            Registrarse
          </Link>
        </div>
      </div>
    </div>
  )
}
