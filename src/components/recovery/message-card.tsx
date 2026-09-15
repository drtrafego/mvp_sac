'use client'

import { Pencil, Trash2, MessageSquare, Image, Video, FileText, Mic, LayoutList, Layers } from 'lucide-react'
import { Switch } from '@/components/ui/switch'
import { cn } from '@/lib/utils'

interface ButtonOption {
  id: string
  label: string
}

interface Message {
  id: number
  order: number
  messageType: string | null
  content: string | null
  mediaUrl: string | null
  caption: string | null
  buttonsJson?: unknown
  templateName?: string | null
  delayMinutes: number | null
  isActive: boolean | null
}

interface MessageCardProps {
  message: Message
  onEdit: (msg: Message) => void
  onDelete: (id: number) => void
  onToggle: (id: number, active: boolean) => void
}

const typeIcons: Record<string, React.ReactNode> = {
  text: <MessageSquare size={13} />,
  image: <Image size={13} />,
  video: <Video size={13} />,
  document: <FileText size={13} />,
  audio: <Mic size={13} />,
  interactive_buttons: <LayoutList size={13} />,
  template: <Layers size={13} />,
}

const typeLabels: Record<string, string> = {
  text: 'Texto',
  image: 'Imagem',
  video: 'Vídeo',
  document: 'Documento',
  audio: 'Áudio',
  interactive_buttons: 'Botões',
  template: 'Template',
}

/*
  Minuto vira a menor unidade legível: 30min, 2h, 1,5d. A fração só aparece
  quando existe, então o caso comum (1h, 1d) fica limpo na cápsula da timeline.
*/
export function formatDelay(minutes: number): string {
  if (minutes < 60) return `${minutes}min`
  const value = minutes < 1440 ? minutes / 60 : minutes / 1440
  const unit = minutes < 1440 ? 'h' : 'd'
  const text = Number.isInteger(value) ? String(value) : value.toFixed(1).replace('.', ',')
  return `${text}${unit}`
}

export function MessageCard({ message, onEdit, onDelete, onToggle }: MessageCardProps) {
  const msgType = message.messageType ?? 'text'
  const isActive = message.isActive ?? true
  const delay = message.delayMinutes ?? 0

  let preview = 'Sem conteúdo'
  if (msgType === 'template' && message.templateName) {
    preview = `Template: ${message.templateName}`
  } else if (message.content) {
    preview = message.content.slice(0, 80) + (message.content.length > 80 ? '...' : '')
  } else if (message.mediaUrl) {
    preview = message.mediaUrl.slice(0, 60) + '...'
  }

  const buttons = Array.isArray(message.buttonsJson) ? (message.buttonsJson as ButtonOption[]) : []

  const actionButton =
    'focus-ring flex h-[var(--control-lg)] w-[var(--control-lg)] lg:h-[var(--control-md)] lg:w-[var(--control-md)] shrink-0 items-center justify-center rounded-[var(--r-md)] transition-colors cursor-pointer'

  return (
    <div className="relative pb-3">
      {/*
        Cada item desenha o próprio trecho do filete, de topo a base, incluindo o
        espaçamento inferior. Assim a linha do tempo não quebra entre um card e o
        seguinte sem precisar de um elemento absoluto no container da lista.
      */}
      <span aria-hidden className="absolute left-3 top-0 bottom-0 w-px bg-line-subtle" />

      {delay > 0 && (
        <div className="pb-2">
          <span className="num text-micro relative inline-flex items-center rounded-full border border-line-subtle bg-surface-inset px-2.5 py-0.5 text-fg-subtle">
            após {formatDelay(delay)}
          </span>
        </div>
      )}

      <div className="flex gap-3">
        {/*
          Template literal em vez de cn: o tailwind-merge trataria text-micro e
          text-fg-muted como o mesmo grupo e apagaria o tamanho do número.
        */}
        <span
          className={`num text-micro relative mt-3.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line-default bg-surface-overlay ${
            isActive ? 'text-fg-muted' : 'text-fg-faint'
          }`}
        >
          {message.order}
        </span>

        <div
          className={cn(
            'card flex min-w-0 flex-1 flex-col gap-3 p-4 md:flex-row md:items-start md:gap-4',
            !isActive && 'opacity-55'
          )}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-micro inline-flex items-center gap-1.5 rounded-[var(--r-sm)] border border-line-subtle bg-surface-inset px-2 py-0.5 text-fg-muted">
                {typeIcons[msgType]}
                {typeLabels[msgType] ?? msgType}
              </span>
              {!isActive && <span className="text-micro text-fg-faint">Inativa</span>}
            </div>

            <p className="mt-2 text-body text-fg-muted">{preview}</p>

            {msgType === 'interactive_buttons' && buttons.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {buttons.map((btn, i) => (
                  <span
                    key={i}
                    className="text-micro rounded-[var(--r-sm)] border border-line-subtle bg-surface-inset px-2 py-0.5 text-fg-subtle"
                  >
                    {btn.label}
                  </span>
                ))}
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-end gap-1 md:gap-1.5">
            <Switch
              checked={isActive}
              onCheckedChange={(checked) => onToggle(message.id, checked)}
            />
            <button
              onClick={() => onEdit(message)}
              title="Editar mensagem"
              className={cn(actionButton, 'text-fg-subtle hover:bg-surface-inset hover:text-fg')}
            >
              <Pencil size={15} />
            </button>
            <button
              onClick={() => {
                if (confirm('Deletar esta mensagem?')) onDelete(message.id)
              }}
              title="Excluir mensagem"
              className={cn(actionButton, 'text-fg-subtle hover:bg-surface-inset hover:text-st-negativo')}
            >
              <Trash2 size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
