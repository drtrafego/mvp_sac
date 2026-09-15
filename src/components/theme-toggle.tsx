'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Sun, Moon, Monitor } from 'lucide-react'

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false)
  const { theme, resolvedTheme, setTheme } = useTheme()

  useEffect(() => setMounted(true), [])

  // Evita hydration mismatch, renderiza placeholder com mesmo tamanho
  if (!mounted) return <div className="h-11 lg:h-[34px]" />

  const isDark = resolvedTheme === 'dark'

  function cycle() {
    const root = document.documentElement
    root.style.transition = 'background-color 180ms ease, color 180ms ease'
    if (theme === 'light') {
      setTheme('dark')
    } else if (theme === 'dark') {
      setTheme('system')
    } else {
      setTheme('light')
    }
    window.setTimeout(() => {
      root.style.transition = ''
    }, 220)
  }

  const label =
    theme === 'system'
      ? `Tema: Sistema (${isDark ? 'Escuro' : 'Claro'})`
      : isDark
      ? 'Tema: Escuro'
      : 'Tema: Claro'

  const Icon = theme === 'system' ? Monitor : isDark ? Moon : Sun

  return (
    <button
      type="button"
      onClick={cycle}
      title={`Tema atual: ${label}. Clique para alternar (Claro → Escuro → Sistema).`}
      className="nav-item focus-ring flex items-center gap-2.5 px-3 py-3 lg:py-[7px] rounded-[var(--r-md)] text-[0.8125rem] text-fg-subtle hover:text-fg hover:bg-[var(--line-subtle)] transition-colors duration-150 w-full cursor-pointer"
    >
      <Icon size={16} className="shrink-0 text-brand-ink" />
      <span className="nav-label">{label}</span>
    </button>
  )
}
