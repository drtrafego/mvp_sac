'use client'

import { Component, type ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
  fallback: ReactNode
}

interface ErrorBoundaryState {
  hasError: boolean
}

/**
 * Contém o blast radius de um crash de render num pedaço isolado da árvore
 * (ex: widget de usuário que depende de auth opcional configurada só em
 * produção), em vez de deixar o Next.js substituir a página inteira pelo
 * fallback genérico "This page couldn't load".
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) return this.props.fallback
    return this.props.children
  }
}
