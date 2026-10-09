export const dynamic = 'force-dynamic'

import { AttentionQueue } from '@/components/inbox/AttentionQueue'
import { requireCompanyRole } from '@/lib/auth'
import { ATTENTION_VIEWS, type AttentionView } from '@/lib/sac-attention-types'

export default async function AtenderAgoraPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams
  const view = typeof params.view === 'string' && ATTENTION_VIEWS.includes(params.view as AttentionView) ? params.view as AttentionView : 'all'
  const requestedPage = typeof params.page === 'string' ? Number(params.page) : 1
  const page = Number.isSafeInteger(requestedPage) && requestedPage > 0 && requestedPage <= 10_000 ? requestedPage : 1
  const { company } = await requireCompanyRole('membro')

  return <AttentionQueue key={`${view}:${page}`} companyName={company.name} initialView={view} initialPage={page} />
}
