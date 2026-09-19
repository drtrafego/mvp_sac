// Travas de segurança que sobraram do lado do SAC depois da mudança de
// arquitetura (19/09/2026): a geração de texto passou a vir da ponte da
// Luana (ai-bridge.ts), que já aplica as travas de vazamento/sinal interno
// do receiver.py antes de devolver a resposta. O que fica aqui é só a trava
// que depende de uma informação que SÓ o SAC tem, que é o resultado real da
// chamada à API de agenda: nunca deixar a fala anunciar "fechado!" quando a
// reunião não existe de verdade (ver src/lib/ai/agenda-actions.ts).
//
// Origem e histórico completo de cada regra em
// /opt/gastaomatos/luana/whatsapp_bridge/receiver.py (FECHAMENTO_RE,
// texto_pede_dados, texto_de_recusa).

const FECHAMENTO_RE =
  /(fechad[oa]|agendad[oa]|marcad[oa]|reservad[oa]|guardad[oa]|separad[oa]|garantid[oa]|confirmad[oa]|bloquei|reservei|agendei|marquei|deixei separ|(?:t[áa]|est[áa])\s+na\s+(?:minha\s+)?agenda|na\s+agenda\s+d[oe])/i

// A fala não pode anunciar fechamento quando o evento não existe de verdade
// (sem e-mail ainda, ou a API de agenda recusou).
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

// Substitui a fala inteira quando a agenda recusa ou falha: nunca deixa ir
// junto o "fechado!" de uma reserva que não nasceu.
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
