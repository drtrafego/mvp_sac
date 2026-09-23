import { redirect } from 'next/navigation'

/**
 * Rota antiga. A agenda (bloqueios + horário de atendimento) foi consolidada
 * na aba Agente junto com nome do bot e follow-up (23/09/2026). Mantida como
 * redirect pra não quebrar link salvo/favorito de quem já usava esta URL.
 */
export default function AgendaConfigRedirect() {
  redirect('/agente')
}
