export const dynamic = 'force-dynamic'

import { requireCompany } from '@/lib/auth'
import { db } from '@/lib/db'
import { settings, recoverySequences, sequenceMessages } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'
import { FileCheck, Sparkles, CheckCircle2, MessageSquare, Copy, Settings } from 'lucide-react'
import Link from 'next/link'

export default async function ApiModelosPage() {
  const company = await requireCompany()

  const [[companySettings], customTemplateMessages] = await Promise.all([
    db.select().from(settings).where(eq(settings.companyId, company.id)),
    db
      .select({
        id: sequenceMessages.id,
        templateName: sequenceMessages.templateName,
        templateLanguage: sequenceMessages.templateLanguage,
        templateVariablesMap: sequenceMessages.templateVariablesMap,
        content: sequenceMessages.content,
        sequenceName: recoverySequences.name,
        eventType: recoverySequences.eventType,
      })
      .from(sequenceMessages)
      .innerJoin(recoverySequences, eq(sequenceMessages.sequenceId, recoverySequences.id))
      .where(
        and(
          eq(recoverySequences.companyId, company.id),
          eq(sequenceMessages.messageType, 'template'),
        ),
      ),
  ])

  const hasMeta = !!(companySettings?.metaWabaId && companySettings?.metaAccessToken)

  const defaultModelos = [
    {
      nome: 'recuperacao_carrinho_v1',
      categoria: 'UTILITY',
      idioma: 'pt_BR',
      status: 'APPROVED',
      corpo: 'Olá {{1}}! Vimos que você iniciou a sua inscrição no {{2}}, mas não concluiu. Separamos uma condição especial para você finalizar agora pelo link: {{3}}',
      variaveis: ['nome_cliente', 'nome_produto', 'checkout_url'],
    },
    {
      nome: 'lembrete_pix_pendente',
      categoria: 'UTILITY',
      idioma: 'pt_BR',
      status: 'APPROVED',
      corpo: 'Oi {{1}}, seu código Pix para o {{2}} no valor de {{3}} foi gerado com sucesso. Use a chave Copia e Cola para pagar antes do vencimento: {{4}}',
      variaveis: ['nome_cliente', 'nome_produto', 'valor', 'pix_copia_cola'],
    },
    {
      nome: 'ajuda_cartao_recusado',
      categoria: 'UTILITY',
      idioma: 'pt_BR',
      status: 'APPROVED',
      corpo: 'Olá {{1}}! Notamos que a sua tentativa de pagamento para o {{2}} não foi autorizada pelo emissor do cartão. Deseja tentar outro cartão ou gerar um Pix com aprovação imediata? Acesse: {{3}}',
      variaveis: ['nome_cliente', 'nome_produto', 'checkout_url'],
    },
    {
      nome: 'boas_vindas_pos_venda',
      categoria: 'UTILITY',
      idioma: 'pt_BR',
      status: 'APPROVED',
      corpo: 'Parabéns {{1}}! 🎉 Sua compra do {{2}} foi aprovada com sucesso. Seu acesso já foi enviado para o e-mail cadastrado. Qualquer dúvida, conte com nosso suporte direto por aqui!',
      variaveis: ['nome_cliente', 'nome_produto'],
    },
  ]

  return (
    <div className="flex flex-col gap-[var(--space-section)]">
      <div className="rise rise-1">
        <div className="flex items-center gap-2 mb-1">
          <span className="inline-flex items-center gap-1.5 text-[11px] uppercase font-bold tracking-wider text-brand-ink bg-brand-glow px-2.5 py-0.5 rounded-full border border-brand-solid/30">
            <FileCheck size={12} />
            Empresa: {company.name} · Meta HSM Templates
          </span>
          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${
            hasMeta
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
              : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
          }`}>
            {hasMeta ? 'Meta WABA Conectada' : 'Pendente de WABA ID'}
          </span>
        </div>
        <h1 className="text-h1 text-fg">Mensagens Aprovadas (Meta Cloud API)</h1>
        <p className="text-body text-fg-muted mt-0.5">
          Templates de mensagens homologados pela Meta para disparo de notificações e recuperação via WhatsApp Oficial para a empresa <strong>{company.name}</strong>.
        </p>
      </div>

      <div className="rise rise-2 grid grid-cols-1 md:grid-cols-2 gap-[var(--space-gutter)]">
        {defaultModelos.map((m) => (
          <div key={m.nome} className="card bg-surface-raised border border-line-subtle p-5 rounded-2xl flex flex-col justify-between space-y-4">
            <div>
              <div className="flex items-center justify-between">
                <span className="text-micro font-mono font-bold text-brand-ink">{m.nome}</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                  {m.status}
                </span>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-fg-faint mt-1">
                <span>Categoria: {m.categoria}</span>
                <span>•</span>
                <span>Idioma: {m.idioma}</span>
              </div>
            </div>

            {/* Prévia do Balão WhatsApp */}
            <div className="bg-[#0b141a] border border-[#1f2c34] p-3.5 rounded-xl text-body text-[#e9edef] space-y-2">
              <p className="text-micro leading-relaxed">{m.corpo}</p>
              <div className="flex items-center justify-end text-[10px] text-[#8696a0] gap-1">
                <span>12:00</span>
                <span className="text-brand-ink">✓✓</span>
              </div>
            </div>

            <div className="pt-3 border-t border-line-subtle">
              <span className="text-[10px] uppercase font-bold text-fg-faint block mb-1.5">Variáveis do Template:</span>
              <div className="flex flex-wrap gap-1.5">
                {m.variaveis.map((v, i) => (
                  <span key={v} className="text-[11px] font-mono px-2 py-0.5 rounded bg-surface-inset text-fg-subtle border border-line-subtle">
                    {`{{${i + 1}}}`} = {v}
                  </span>
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
