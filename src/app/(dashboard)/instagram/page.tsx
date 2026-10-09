import { InstagramLogoIcon } from '@/components/inbox/ChannelBadge'

export default function InstagramPage() {
  return (
    <div className="studio-inbox-empty hidden md:flex flex-col items-center justify-center h-full gap-3 bg-surface-base text-center">
      <span className="flex h-14 w-14 items-center justify-center rounded-full bg-pink-500/10 text-pink-500">
        <InstagramLogoIcon size={24} className="text-pink-500" />
      </span>
      <p className="text-h2 text-fg">Selecione uma conversa Direct</p>
      <p className="text-body text-fg-muted max-w-[40ch]">
        Escolha um contato na lista ao lado para ver o histórico e responder pelo Instagram.
      </p>
    </div>
  )
}
