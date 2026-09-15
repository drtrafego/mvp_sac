import Link from 'next/link'
import { cn } from '@/lib/utils'

/**
 * Card usado no lugar das linhas de tabela abaixo de md.
 * Serve tanto em Server Component quanto em Client Component.
 */

interface MobileRowCardProps {
  title: React.ReactNode
  subtitle?: React.ReactNode
  meta?: React.ReactNode
  badges?: React.ReactNode
  href?: string
  className?: string
  children?: React.ReactNode
}

export function MobileRowCard({
  title,
  subtitle,
  meta,
  badges,
  href,
  className,
  children,
}: MobileRowCardProps) {
  const content = (
    <>
      <div className="min-w-0">
        <div className="text-h3 text-fg truncate">{title}</div>
        {subtitle ? (
          <div className="text-micro text-fg-subtle truncate mt-0.5">{subtitle}</div>
        ) : null}
      </div>
      {meta ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-micro text-fg-muted">
          {meta}
        </div>
      ) : null}
      {badges ? <div className="mt-2.5 flex flex-wrap gap-1.5">{badges}</div> : null}
      {children}
    </>
  )

  if (href) {
    return (
      <Link href={href} className={cn('card block p-4', className)}>
        {content}
      </Link>
    )
  }

  return <div className={cn('card p-4', className)}>{content}</div>
}
