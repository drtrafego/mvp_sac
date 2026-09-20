import { sql } from 'drizzle-orm'
import { recoveryLeads } from '@/lib/db/schema'

/**
 * Eventos de checkout que ficam PENDENTES antes de uma compra ser aprovada.
 * É a mesma lista usada pelos webhooks (hotmart/kiwify/greenn/zouti) para
 * decidir quais leads cancelar/marcar como convertidos quando chega uma
 * compra_aprovada.
 */
export const RECOVERY_EVENT_TYPES = ['boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado'] as const

/**
 * Uma linha de compra_aprovada é "venda recuperada" quando o MESMO telefone
 * já tinha um evento de checkout pendente (boleto, pix, carrinho abandonado
 * ou cartão recusado) criado antes dessa aprovação. Correlação por telefone,
 * não por transaction_id: é exatamente o critério que os webhooks já usam
 * (ver `leadsToCancel` em src/app/api/webhooks/*\/[slug]/route.ts) para
 * marcar o lead pendente como status='converted' quando a compra aprova,
 * porque a tentativa pendente pode ter um transaction_id diferente da
 * compra que de fato foi aprovada (boleto expira, cliente paga por pix numa
 * nova transação, etc).
 *
 * Toda linha de compra_aprovada cai em UM dos dois lados (recuperada ou
 * direta), nunca nos dois: por isso a soma das duas categorias sempre bate
 * com o total de compra_aprovada do período, sem precisar de outra query.
 */
export const isRecoveredSaleSql = sql<boolean>`exists (
  select 1 from recovery_leads rl2
  where rl2.company_id = ${recoveryLeads.companyId}
    and rl2.phone = ${recoveryLeads.phone}
    and rl2.event_type in ('boleto', 'pix', 'carrinho_abandonado', 'cartao_recusado')
    and rl2.created_at <= ${recoveryLeads.createdAt}
)`

export const isDirectSaleSql = sql<boolean>`not (${isRecoveredSaleSql})`
