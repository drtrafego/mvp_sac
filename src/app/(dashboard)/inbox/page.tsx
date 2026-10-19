import { MessageSquare } from 'lucide-react'
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await searchParams

  return (
    <div className="studio-inbox-empty hidden md:flex flex-col items-center justify-center h-full gap-3 bg-surface-base text-center">
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
