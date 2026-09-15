'use client'

import { useTheme } from 'next-themes'
import { useEffect, useState } from 'react'
import { Sun, Moon } from 'lucide-react'

export function ThemeToggle() {
  const [mounted, setMounted] = useState(false)
  const { theme, setTheme } = useTheme()

  useEffect(() => setMounted(true), [])

  // Evita hydration mismatch, renderiza placeholder com mesmo tamanho
  if (!mounted) return <div className="h-11 lg:h-[34px]" />

  const isDark = theme === 'dark'
  const label = isDark ? 'Tema Claro' : 'Tema Escuro'

  /*
    A transição de cor fica ligada só durante a troca. Permanente deixaria todo
    hover pastoso; sem nenhuma, a virada do tema fica agressiva em vídeo.
  */
  function toggle() {
    const root = document.documentElement
    root.style.transition = 'background-color 180ms ease, color 180ms ease'
    setTheme(isDark ? 'light' : 'dark')
    window.setTimeout(() => { root.style.transition = '' }, 220)
  }

  return (
    <button
      onClick={toggle}
      title={isDark ? 'Mudar para tema claro' : 'Mudar para tema escuro'}
      className="nav-item focus-ring flex items-center gap-2.5 px-3 py-3 lg:py-[7px] rounded-[var(--r-md)] text-[0.8125rem] text-fg-subtle hover:text-fg hover:bg-[var(--line-subtle)] transition-colors duration-150 w-full cursor-pointer"
    >
      {isDark ? <Sun size={16} className="shrink-0" /> : <Moon size={16} className="shrink-0" />}
      <span className="nav-label">{label}</span>
    </button>
  )
}
