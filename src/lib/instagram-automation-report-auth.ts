import { NextRequest, NextResponse } from 'next/server'
import { authenticateAgentRequest } from '@/lib/agent-auth'
import { ReportParameterError } from '@/lib/instagram-automation-reporting'

export async function authenticateReport(request: NextRequest, idOrSlug: string) {
  // Estas rotas de integração exigem chave mesmo quando há sessão no painel.
  const bearer = request.headers.get('authorization')
  if (!(bearer?.startsWith('Bearer ') && bearer.slice(7).trim()) && !request.headers.get('x-api-key')?.trim()) {
    return { error: NextResponse.json({ error: 'Informe uma chave de API.', code: 'UNAUTHORIZED' }, { status: 401 }) }
  }
  return authenticateAgentRequest(request, idOrSlug)
}

export function reportError(error: unknown) {
  if (error instanceof ReportParameterError) return NextResponse.json({ error: error.message }, { status: 400 })
  // Não registrar erro SQL bruto: pode incluir credenciais ou dados pessoais.
  console.error('[Instagram Automation Report] Falha ao consultar relatório.')
  return NextResponse.json({ error: 'Não foi possível consultar as automações do Instagram.' }, { status: 500 })
}
