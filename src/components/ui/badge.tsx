interface BadgeProps {
  children: React.ReactNode
  variant?: 'default' | 'pending' | 'confirmed' | 'cancelled' | 'completed'
  className?: string
}

const variantStyles = {
  default: 'bg-gray-100 text-gray-700',
  pending: 'bg-warning-100 text-warning-700',
  confirmed: 'bg-success-100 text-success-700',
  cancelled: 'bg-error-100 text-error-700',
  completed: 'bg-primary-100 text-primary-700',
}

export function Badge({ children, variant = 'default', className = '' }: BadgeProps) {
  return (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${variantStyles[variant]} ${className}`}>
      {children}
    </span>
  )
}
