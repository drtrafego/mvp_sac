import { z } from 'zod'

const ref = z.string().trim().min(1).max(300)
const etapa = z.string().trim().min(1).max(120)
const msg = z.string().trim().min(1).max(1500)
const corr = z.enum(['contem', 'exata'])
export const acaoSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('buscar_lead'), query: z.string().min(1).max(200) }).strict(),
  z.object({ type: z.literal('listar_etapas') }).strict(),
  z.object({ type: z.literal('listar_regras_instagram') }).strict(),
  z.object({ type: z.literal('listar_regras_story') }).strict(),
  z.object({ type: z.literal('recusar'), motivo: z.enum(['controle_do_bot', 'enviar_mensagem', 'excluir', 'configuracao', 'fora_do_catalogo']) }).strict(),
  z.object({ type: z.literal('mover_etapa'), lead: ref, etapa }).strict(),
  z.object({ type: z.literal('mover_etapa_lote'), etapaOrigem: etapa, etapaDestino: etapa }).strict(),
  z.object({ type: z.literal('anotar_lead'), lead: ref, texto: z.string().trim().min(1).max(2000) }).strict(),
  z.object({ type: z.literal('criar_regra_instagram'), gatilho: z.enum(['comentario', 'direct', 'ambos']), palavra: ref, mensagem: msg, correspondencia: corr, ativar: z.boolean() }).strict(),
  z.object({ type: z.literal('editar_regra_instagram'), regra: ref, novaPalavra: ref.optional(), novaMensagem: msg.optional(), novaCorrespondencia: corr.optional() }).strict(),
  z.object({ type: z.literal('ativar_regra_instagram'), regra: ref }).strict(),
  z.object({ type: z.literal('desativar_regra_instagram'), regra: ref }).strict(),
  z.object({ type: z.literal('criar_regra_story'), palavra: ref, mensagem: msg, correspondencia: corr, ativar: z.enum(['nao', 'teste', 'envio']) }).strict(),
  z.object({ type: z.literal('editar_regra_story'), regra: ref, novaPalavra: ref.optional(), novaMensagem: msg.optional(), novaCorrespondencia: corr.optional() }).strict(),
  z.object({ type: z.literal('ativar_regra_story'), regra: ref, modo: z.enum(['teste', 'envio']) }).strict(),
  z.object({ type: z.literal('desativar_regra_story'), regra: ref }).strict(),
])
export const acoesPlanSchema = z.object({ actions: z.array(acaoSchema).min(1).max(3), response: z.string().min(1).max(800) }).strict()
  .superRefine((plan, ctx) => {
    plan.actions.forEach((a, i) => {
      if ((a.type === 'editar_regra_instagram' || a.type === 'editar_regra_story') && !a.novaPalavra && !a.novaMensagem && !a.novaCorrespondencia)
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['actions', i], message: 'Informe uma alteração.' })
    })
  })
export type AcoesPlan = z.infer<typeof acoesPlanSchema>
export const LEITURA_FASE0 = new Set(['buscar_lead', 'listar_etapas', 'listar_regras_instagram'])
export function precisaFluxoDeAcoes(plan: { actions: Array<{ type: string }> }) { return plan.actions.some(a => !LEITURA_FASE0.has(a.type)) }
export const PERMISSAO = Object.fromEntries(acaoSchema.options.map(s => [s.shape.type.value, s.shape.type.value === 'recusar' ? null : s.shape.type.value]))
export const RECUSA_TEXTO = {
  controle_do_bot: 'O botão do SAC é o único controle do bot. Eu não ligo, desligo nem pauso o bot.',
  enviar_mensagem: 'Eu não envio mensagens a leads ou clientes. Use a conversa no SAC.',
  excluir: 'Eu não excluo leads, conversas ou regras. Posso desativar uma regra.',
  configuracao: 'Eu não altero configurações da empresa, colunas do funil, integrações ou chaves.',
  fora_do_catalogo: 'Ainda não sei fazer isso. Posso mover etapa, anotar no lead e cuidar das regras de comentário, Direct e story.',
}
