import { Sidebar } from '@/components/layout/sidebar'
import { MobileSidebarProvider, MobileTopBar } from '@/components/layout/mobile-nav'

export default function MainLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <MobileSidebarProvider>
      <div className="min-h-screen bg-background">
        <Sidebar />
        <MobileTopBar />
        <main className="ml-0 md:ml-64 pt-14 md:pt-0">
          {children}
        </main>
      </div>
    </MobileSidebarProvider>
  )
}
