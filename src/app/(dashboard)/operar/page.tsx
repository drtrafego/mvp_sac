import { Bot } from 'lucide-react'
import { AuthError, ForbiddenError } from '@/lib/auth'
import { PageHeader } from '@/components/ui/page-header'
import { OperatorConsole } from '@/components/operator/operator-console'
import { OperatorAccessError, requireOperatorAdmin } from '@/lib/operator/panel-auth'

export const dynamic = 'force-dynamic'

export default async function OperarPage() {
  let actor: Awaited<ReturnType<typeof requireOperatorAdmin>>
  try {
    actor = await requireOperatorAdmin()
  } catch (error) {
    if (error instanceof OperatorAccessError || error instanceof AuthError || error instanceof ForbiddenError) return (
      <div className="max-w-[880px] flex flex-col gap-[var(--space-section)]">
        <PageHeader icon={<Bot size={22} />} title="Operador SAC" description={error instanceof OperatorAccessError && error.status !== 401 ? 'Operador desligado para esta empresa.' : 'Sem permissão para usar o Operador SAC.'} />
      </div>
    )
    throw error
  }
  return (
    <div className="max-w-[880px] flex flex-col gap-[var(--space-section)]">
      <PageHeader icon={<Bot size={22} />} title="Operador SAC" description={`Consultas seguras da empresa ${actor.company.name}. Nesta fase, o operador apenas lê dados e não controla bots, pausas ou automações.`} />
      <OperatorConsole />
    </div>
  )
}
