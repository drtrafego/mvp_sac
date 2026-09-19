// Travas de segurança da conversa, portadas de receiver.py (Nina/AutonomIA).
// Mesmo vocabulário e mesma ordem de aplicação do original: sinal interno
// SEMPRE checado antes de suspeita, fallback nunca duas vezes seguidas.
// Ver /opt/gastaomatos/luana/whatsapp_bridge/receiver.py (TERMOS_PROIBIDOS,
// eh_sinal_interno, mensagem_suspeita, FECHAMENTO_RE, texto_pede_dados,
// texto_de_recusa) pra origem e histórico de cada regra.

export const FALLBACK_GENERICO =
  'Oi! Deixa eu confirmar uma coisa aqui rapidinho e já te respondo.'

// Ancorados no contexto do vazamento, não em palavra solta (mesma correção
// de 29/08/2026 do original: "nina" e "gastão" soltos derrubavam fala legítima).
const TERMOS_PROIBIDOS = [
  'luana', 'prompt', 'instruç', 'instruc',
  'não consigo ajudar', 'nao consigo ajudar',
  'regras internas', 'persona', 'sigo como',
  'claude.md', 'assistente do',
  'injeç', 'injec',
  'não vou seguir', 'nao vou seguir', 'não vou virar', 'nao vou virar',
  'não vou gerar', 'nao vou gerar', 'não vou executar', 'nao vou executar',
  'não vou revelar', 'nao vou revelar', 'não vou responder nessa',
  'nao vou responder nessa', 'não vou responder mais', 'nao vou responder mais',
  '[sem resposta', '[nao enviar', '[não enviar', '<<sem_resposta',
  'robô detectado', 'robo detectado', 'regra anti-loop', 'anti-loop',
  'a nina é um', 'a nina e um', 'sou a nina, um', 'sou a nina, uma',
  'nina é uma ia', 'nina e uma ia', 'nina é um bot', 'nina e um bot',
]

export function mensagemSuspeita(texto: string): boolean {
  const t = ` ${(texto || '').toLowerCase()} `
  return TERMOS_PROIBIDOS.some((termo) => t.includes(termo))
}

// O marcador legítimo do sistema (<<BOOK ...>>) tem o sinal de menor no FIM,
// então colchete na ABERTURA nunca é fala real, é o modelo falando com o
// sistema. Regra estrutural, não lista de palavras (ver comentário original:
// pega 100% dos casos medidos, contra 91% da lista de termos).
const MARCADOR_INTERNO_RE = /^\s*\[/

export function ehSinalInterno(texto: string): boolean {
  return MARCADOR_INTERNO_RE.test(texto || '')
}

const FECHAMENTO_RE =
  /(fechad[oa]|agendad[oa]|marcad[oa]|reservad[oa]|guardad[oa]|separad[oa]|garantid[oa]|confirmad[oa]|bloquei|reservei|agendei|marquei|deixei separ|(?:t[áa]|est[áa])\s+na\s+(?:minha\s+)?agenda|na\s+agenda\s+d[oe])/i

// A fala do modelo não pode anunciar fechamento quando o evento não existe
// de verdade (sem e-mail ainda, ou a API de agenda recusou).
export function pareceFechamento(texto: string): boolean {
  return FECHAMENTO_RE.test(texto || '')
}

export function textoPedeDados(nome?: string | null): string {
  const n = (nome || '').trim()
  if (n) {
    return `Ah, ${n}, tudo bem? 😊 Pra eu marcar e te enviar o convite do Google Meet, qual é o seu e-mail?`
  }
  return 'Por favor, preciso do seu nome e do seu e-mail pra eu marcar e te enviar o convite do Google Meet.'
}

// Substitui a fala inteira do modelo quando a agenda recusa ou falha: nunca
// deixa ir junto o "fechado!" de uma reserva que não nasceu.
export function textoDeRecusa(erro?: string | null): string {
  switch (erro) {
    case 'horario_no_passado':
      return 'Esse horário já passou 😅 Me escolhe outro dos que eu te mandei que eu registro agora mesmo pra você.'
    case 'antecedencia_insuficiente':
      return 'Esse já ficou em cima da hora pra eu garantir direito. Me escolhe outro dos que te mandei que eu registro na hora.'
    case 'horario_ocupado':
    case 'data_e_feriado':
    case 'data_bloqueada':
      return 'Opa, esse horário acabou de sair da agenda. Me fala outro dos que te passei que eu registro na hora pra você.'
    case 'email_obrigatorio':
      return 'Pra eu marcar e te enviar o convite do Google Meet, me passa por favor o seu e-mail.'
    default:
      return 'Deu um problema aqui pra gravar na agenda agora. Me confirma esse horário mais uma vez que eu registro e te aviso.'
  }
}

const ENCERRAR_RE = /\[\[ENCERRAR:?\s*([\s\S]*?)\]\]/i

// V1 só remove o marcador cru da fala visível (senão vaza "[[ENCERRAR: ...]]"
// pro WhatsApp de verdade). Não persiste o fechamento da conversa ainda: a
// próxima mensagem do lead volta a ser respondida normalmente. Fica registrado
// no motivo pra decidir depois se vale portar o `encerradas.json` do receiver.py.
export function removerMarcadorEncerrar(texto: string): { texto: string; motivo: string | null } {
  const m = ENCERRAR_RE.exec(texto || '')
  if (!m) return { texto, motivo: null }
  return { texto: texto.replace(m[0], '').trim(), motivo: (m[1] || '').trim() }
}
