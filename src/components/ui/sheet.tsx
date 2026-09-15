'use client'

/**
 * Sheet: painel deslizante para mobile (menu de navegação e filtros).
 * Implementação própria, sem dependência nova, para funcionar junto do Base UI
 * já usado no Dialog. Suporta side="right" (menu) e side="bottom" (filtros).
 */

import { useEffect, useId, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * Contador de painéis abertos. Sem ele, fechar um Sheet enquanto outro
 * continua aberto liberaria o scroll do body por baixo do painel visível.
 */
let openSheetCount = 0

interface SheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  side?: 'right' | 'bottom'
  title?: string
  className?: string
  /**
   * Por padrão o painel só existe abaixo de lg, porque nasceu para o menu do
   * celular. O painel de filtros do Analytics precisa dele em qualquer largura.
   */
  desktop?: boolean
  children: React.ReactNode
}

export function Sheet({
  open,
  onOpenChange,
  side = 'right',
  title,
  className,
  desktop = false,
  children,
}: SheetProps) {
  const [mounted, setMounted] = useState(false)
  // Mantém o painel no DOM durante a animação de saída
  const [visible, setVisible] = useState(open)
  const [entered, setEntered] = useState(false)
  const panelRef = useRef<HTMLDivElement>(null)
  const titleId = useId()

  useEffect(() => setMounted(true), [])

  useEffect(() => {
    if (open) {
      setVisible(true)
      const frame = requestAnimationFrame(() => setEntered(true))
      return () => cancelAnimationFrame(frame)
    }
    setEntered(false)
    const timer = setTimeout(() => setVisible(false), 200)
    return () => clearTimeout(timer)
  }, [open])

  // Fecha com ESC, trava o scroll do body e leva o foco para o painel
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false)
    }
    document.addEventListener('keydown', onKey)
    openSheetCount++
    document.body.style.overflow = 'hidden'
    panelRef.current?.focus()
    return () => {
      document.removeEventListener('keydown', onKey)
      openSheetCount--
      // Só libera o scroll quando o último painel aberto fecha
      if (openSheetCount === 0) document.body.style.overflow = ''
    }
  }, [open, onOpenChange])

  if (!mounted || !visible) return null

  const isRight = side === 'right'

  return createPortal(
    <div
      className={cn('fixed inset-0 z-50', !desktop && 'lg:hidden')}
      role="dialog"
      aria-modal="true"
      aria-labelledby={title ? titleId : undefined}
    >
      <div
        onClick={() => onOpenChange(false)}
        className={cn(
          'absolute inset-0 bg-black/60 transition-opacity duration-200',
          entered ? 'opacity-100' : 'opacity-0'
        )}
      />
      <div
        ref={panelRef}
        tabIndex={-1}
        className={cn(
          'absolute flex flex-col bg-surface-panel border-line-default outline-none transition-transform duration-200 ease-out',
          isRight
            ? 'top-0 right-0 h-full w-[85vw] max-w-xs border-l'
            : 'bottom-0 inset-x-0 max-h-[85vh] rounded-t-[var(--r-xl)] border-t',
          entered
            ? 'translate-x-0 translate-y-0'
            : isRight
              ? 'translate-x-full'
              : 'translate-y-full',
          className
        )}
      >
        {title && (
          <div className="flex items-center justify-between px-4 h-14 border-b border-line-subtle shrink-0">
            <span id={titleId} className="text-h3 text-fg">{title}</span>
            <button
              onClick={() => onOpenChange(false)}
              aria-label="Fechar"
              className="focus-ring flex h-11 w-11 -mr-3 items-center justify-center rounded-[var(--r-md)] text-fg-subtle hover:text-fg hover:bg-surface-inset transition-colors"
            >
              <X size={18} />
            </button>
          </div>
        )}
        {children}
        <div className="h-[env(safe-area-inset-bottom)] shrink-0" />
      </div>
    </div>,
    document.body
  )
}
