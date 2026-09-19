/**
 * Cliente da ponte de geração de resposta da Nina/Amanda (Luana), o mesmo
 * cérebro DE VERDADE que já atende no WhatsApp de produção (claude -p / SOUL
 * do receiver.py). Este SAC NUNCA gera texto sozinho a partir daqui: só pede
 * o texto pronto pra ponte. Quem executa ação real de agenda continua sendo
 * este SAC, via agenda-autonomia.ts (ver src/lib/ai/agenda-actions.ts), nunca
 * a ponte sozinha.
 *
 * Processo do outro lado é single-thread e compartilha fila com o
 * atendimento REAL. Por isso:
 *  - timeout generoso por chamada (o outro lado pode levar até ~90s);
 *  - rate limit de 15 chamadas / 300s é do SERVIÇO INTEIRO (todas as
 *    empresas juntas), contado aqui em Postgres, mesmo padrão de rate limit
 *    já usado em instagram-comment-processor.ts;
 *  - estourou local ou o próprio serviço devolveu 429: trata como
 *    indisponível agora, nunca espera, nunca insiste na mesma rodada.
 *
 * Env vars que a Vercel deste projeto precisa ter (Production e Preview):
 *   AI_BRIDGE_URL   -> URL PÚBLICA completa até o endpoint (ex.:
 *                      https://hermes.casaldotrafego.com/interno/gerar-resposta),
 *                      atrás de um proxy nginx pro 127.0.0.1:8651 do servidor
 *                      da Luana. Mesmo padrão do AGENDA_AUTONOMIA_API_URL.
 *                      ⚠️ http://127.0.0.1:8651 sozinho NÃO é alcançável a
 *                      partir da Vercel: precisa existir essa rota pública
 *                      antes disso funcionar em produção (passo de infra,
 *                      fora do escopo deste código).
 *   AI_BRIDGE_TOKEN -> conteúdo de
 *                      /opt/gastaomatos/luana/whatsapp_bridge/.gerar_resposta_token
 */

import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
// A tabela é referenciada pelo nome direto no SQL cru abaixo (INSERT/UPDATE
// condicionais que o query builder do Drizzle não expressa numa única
// query atômica); o import de schema não é necessário aqui.

const BASE_URL = process.env.AI_BRIDGE_URL ?? ''
const TOKEN = process.env.AI_BRIDGE_TOKEN ?? ''

const JANELA_SEGUNDOS = 300
const LIMITE_JANELA = 15
const TIMEOUT_MS = 150_000

export type Bot = 'nina' | 'amanda'

export type HistoricoTurno = { role: 'lead' | 'bot'; text: string }

export type AcaoDetectada = {
  tipo: 'book' | 'reschedule' | 'cancel'
  nome?: string
  email?: string
  start?: string
  end?: string
  [chave: string]: unknown
}

export type RespostaBridge = {
  ok: boolean
  status: 'ok' | 'sem_resposta' | 'travado'
  resposta?: string | null
  acao_detectada?: AcaoDetectada | null
  encerrar?: { motivo?: string } | null
}

export type ResultadoBridge =
  | { ok: true; resposta: RespostaBridge }
  | {
      ok: false
      motivo: 'sem_config' | 'rate_limit_local' | 'auth' | 'payload_invalido' | 'rate_limit_remoto' | 'indisponivel' | 'erro'
      detalhe?: string
    }

/**
 * Reserva atomicamente um slot na janela de 300s (CTE + INSERT numa única
 * query, pra não abrir race entre invocações concorrentes da Vercel que
 * fariam duas checagens lerem o mesmo count antes de qualquer uma inserir).
 * Retorna o id da linha reservada, ou null se a janela já está cheia.
 */
async function reservarSlotDeChamada(): Promise<number | null> {
  const result = await db.execute<{ id: number }>(sql`
    WITH janela AS (
      SELECT count(*)::int AS c
      FROM ai_bridge_calls
      WHERE created_at >= now() - make_interval(secs => ${JANELA_SEGUNDOS})
    )
    INSERT INTO ai_bridge_calls (status)
    SELECT 'em_andamento' FROM janela WHERE janela.c < ${LIMITE_JANELA}
    RETURNING id
  `)
  return result.rows[0]?.id ?? null
}

async function atualizarStatusChamada(id: number, status: string): Promise<void> {
  try {
    await db.execute(sql`UPDATE ai_bridge_calls SET status = ${status} WHERE id = ${id}`)
  } catch (err) {
    console.error('[AI Bridge] falha ao atualizar status da chamada (rate limit local):', err)
  }
}

export async function gerarResposta(opts: {
  bot: Bot
  mensagem: string
  historico: HistoricoTurno[]
  nomeContato?: string
  waId?: string
  agendamentoAtual?: Record<string, unknown> | null
}): Promise<ResultadoBridge> {
  if (!BASE_URL || !TOKEN) {
    console.error('[AI Bridge] AI_BRIDGE_URL / AI_BRIDGE_TOKEN não configurados nesta env, abortando (fail-closed)')
    return { ok: false, motivo: 'sem_config' }
  }

  let slotId: number | null = null
  try {
    slotId = await reservarSlotDeChamada()
  } catch (err) {
    console.error('[AI Bridge] falha ao checar rate limit local, não vou arriscar chamar a ponte:', err)
    return { ok: false, motivo: 'erro' }
  }
  if (slotId === null) {
    console.error(`[AI Bridge] rate limit local (${LIMITE_JANELA}/${JANELA_SEGUNDOS}s) atingido, pulando esta rodada`)
    return { ok: false, motivo: 'rate_limit_local' }
  }

  try {
    const resp = await fetch(BASE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        bot: opts.bot,
        mensagem: opts.mensagem,
        historico: opts.historico,
        nome_contato: opts.nomeContato || undefined,
        wa_id: opts.waId || undefined,
        agendamento_atual: opts.agendamentoAtual ?? null,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    })

    await atualizarStatusChamada(slotId, String(resp.status))

    if (resp.status === 401) {
      console.error('[AI Bridge] 401: token inválido ou ausente')
      return { ok: false, motivo: 'auth' }
    }
    if (resp.status === 400) {
      const texto = await resp.text().catch(() => '')
      console.error(`[AI Bridge] 400: payload inválido: ${texto.slice(0, 500)}`)
      return { ok: false, motivo: 'payload_invalido', detalhe: texto.slice(0, 500) }
    }
    if (resp.status === 429) {
      console.error('[AI Bridge] 429: rate limit da própria ponte, tentaremos na próxima mensagem')
      return { ok: false, motivo: 'rate_limit_remoto' }
    }
    if (resp.status === 503) {
      console.error('[AI Bridge] 503: claude -p indisponível no servidor da ponte agora')
      return { ok: false, motivo: 'indisponivel' }
    }
    if (!resp.ok) {
      const texto = await resp.text().catch(() => '')
      console.error(`[AI Bridge] erro ${resp.status}: ${texto.slice(0, 500)}`)
      return { ok: false, motivo: 'erro', detalhe: texto.slice(0, 500) }
    }

    const data = (await resp.json()) as RespostaBridge
    if (!data || data.ok !== true) {
      console.error('[AI Bridge] resposta 200 sem ok:true, tratando como falha:', JSON.stringify(data).slice(0, 500))
      return { ok: false, motivo: 'erro' }
    }
    return { ok: true, resposta: data }
  } catch (err) {
    await atualizarStatusChamada(slotId, 'excecao')
    console.error('[AI Bridge] exceção chamando a ponte (timeout ou rede):', err)
    return { ok: false, motivo: 'indisponivel' }
  }
}
