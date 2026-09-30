import { MessageSquare } from 'lucide-react'
import { redirect } from 'next/navigation'

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  // Compatibilidade com favoritos/deep links criados antes da área dedicada.
  const params = await searchParams
  if (params.channel === 'instagram') {
    const nextParams = new URLSearchParams()
    for (const [key, value] of Object.entries(params)) {
      if (key === 'channel' || value === undefined) continue
      for (const item of Array.isArray(value) ? value : [value]) nextParams.append(key, item)
    }
    const query = nextParams.toString()
    redirect(query ? `/instagram?${query}` : '/instagram')
  }

  return (
    <div className="hidden md:flex flex-col items-center justify-center h-full gap-3 bg-surface-base text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-surface-inset text-fg-faint">
        <MessageSquare size={24} strokeWidth={1.5} />
      </span>
      <p className="text-h2 text-fg">Selecione uma conversa</p>
      <p className="text-body text-fg-muted max-w-[40ch]">
        Escolha um lead na lista ao lado para ver o histórico e responder pelo canal disponível.
      </p>
    </div>
  )
}
