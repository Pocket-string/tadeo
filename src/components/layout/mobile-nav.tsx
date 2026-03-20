'use client'

import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { usePathname } from 'next/navigation'
import Link from 'next/link'

// --- Context ---
interface MobileSidebarState {
  isOpen: boolean
  toggle: () => void
  close: () => void
}

const MobileSidebarContext = createContext<MobileSidebarState>({
  isOpen: false,
  toggle: () => {},
  close: () => {},
})

export function useMobileSidebar() {
  return useContext(MobileSidebarContext)
}

export function MobileSidebarProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false)
  const pathname = usePathname()

  const toggle = useCallback(() => setIsOpen(prev => !prev), [])
  const close = useCallback(() => setIsOpen(false), [])

  // Auto-close on navigation
  useEffect(() => {
    close()
  }, [pathname, close])

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  return (
    <MobileSidebarContext.Provider value={{ isOpen, toggle, close }}>
      {children}
    </MobileSidebarContext.Provider>
  )
}

// --- Mobile Top Bar ---
export function MobileTopBar() {
  const { toggle } = useMobileSidebar()

  return (
    <div className="fixed top-0 left-0 right-0 h-14 bg-primary-500 text-white flex items-center px-4 z-30 md:hidden">
      <button
        onClick={toggle}
        className="w-10 h-10 flex items-center justify-center rounded-lg hover:bg-white/10 transition-colors"
        aria-label="Toggle menu"
      >
        <svg className="w-6 h-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
          <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 6.75h16.5M3.75 12h16.5m-16.5 5.25h16.5" />
        </svg>
      </button>
      <Link href="/dashboard" className="flex items-center gap-2 ml-3">
        <div className="w-8 h-8 bg-secondary-500 rounded-lg flex items-center justify-center">
          <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
          </svg>
        </div>
        <span className="font-heading font-semibold">Trader</span>
      </Link>
    </div>
  )
}

// --- Mobile Overlay Drawer ---
export function MobileOverlay({ children }: { children: React.ReactNode }) {
  const { isOpen, close } = useMobileSidebar()

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 md:hidden">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 animate-fade-in"
        onClick={close}
      />
      {/* Drawer */}
      <aside className="absolute left-0 top-0 bottom-0 w-64 bg-primary-500 text-white flex flex-col animate-slide-in-left">
        {children}
      </aside>
    </div>
  )
}
