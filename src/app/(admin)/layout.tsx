export const dynamic = 'force-dynamic'

import { redirect } from 'next/navigation'
import { getCurrentUser } from '@/lib/auth'
import { AdminSidebar, AdminTopbar } from '@/components/layout/admin-sidebar'

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const user = await getCurrentUser()
  if (!user) redirect('/handler/sign-in')
  if (!user.isAdmin) redirect('/')

  return (
    <div className="flex h-screen bg-surface-base">
      <AdminSidebar />
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <AdminTopbar />
        <main className="scroll-thin flex-1 overflow-auto p-[var(--space-shell)]">
          <div className="shell">{children}</div>
        </main>
      </div>
    </div>
  )
}
