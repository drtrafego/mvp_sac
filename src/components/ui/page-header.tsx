import type { ReactNode } from 'react'
import { cn } from '@/lib/utils'

export interface PageHeaderProps {
  title: ReactNode
  description?: ReactNode
  eyebrow?: ReactNode
  actions?: ReactNode
  icon?: ReactNode
  children?: ReactNode
  className?: string
}

/** Shared heading for content pages; works in both server and client trees. */
export function PageHeader({
  title,
  description,
  eyebrow,
  actions,
  icon,
  children,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('page-heading', className)}>
      <div className="page-heading-copy">
        {icon ? <div className="page-heading-icon" aria-hidden="true">{icon}</div> : null}
        <div className="min-w-0 flex-1">
          <div className="studio-page-eyebrow">{eyebrow || "Central de operações"}</div>
          <h1 className="flex flex-wrap items-center gap-2 text-h1 font-semibold text-fg">{title}</h1>
          {description ? <p className="page-heading-description text-body text-fg-muted">{description}</p> : null}
          {children}
        </div>
      </div>
      {actions ? <div className="page-heading-actions">{actions}</div> : null}
    </header>
  )
}
