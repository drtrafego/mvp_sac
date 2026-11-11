import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'

// Todas as 58 frases do anexo B do QA independente, sem depender do relatório local.
export const commercialPhrases: string[] = [
  "pode mandar",
  "quero ver o site",
  "vou sair para almoçar",
  "parar de pagar caro é o que eu quero",
  "dame de baja temporada",
  "me manda o orçamento",
  "quanto custa o site?",
  "vocês fazem parcelado?",
  "posso pagar no Pix?",
  "vou falar com meu sócio",
  "manda mais detalhes",
  "não quero receber visitas hoje",
  "não quero mais receber ligações, prefiro conversar aqui",
  "não receber mensagens no meu site seria um problema",
  "sair do plano atual custa quanto?",
  "parar a campanha no domingo é possível?",
  "cancelar mensagem agendada no meu site custa quanto?",
  "me tire da lista de espera, já quero comprar",
  "me tira da lista de devedores, já paguei",
  "remover meu número antigo do cadastro e cadastrar o novo",
  "não me mande mais exemplos de clínica, quero de restaurante",
  "não enviar mais fotos pesadas, pode mandar o link",
  "estou sem tempo agora, falo amanhã",
  "tem desconto no pagamento à vista?",
  "a proposta inclui domínio?",
  "quero um botão de WhatsApp",
  "preciso trocar as fotos",
  "o site funciona no celular?",
  "pode enviar o contrato",
  "quero receber novidades",
  "dale, mandame",
  "quiero ver el sitio",
  "pasame el precio",
  "che, ¿cuánto sale?",
  "¿lo puedo pagar en cuotas?",
  "me interesa, contame más",
  "voy a salir a almorzar",
  "baja temporada",
  "baja el precio y cerramos",
  "la baja temporada empieza en marzo",
  "no quiero recibir llamadas, escribime por acá",
  "no recibir mensajes en la web me complica",
  "no quiero más mensajes de error en mi página",
  "no recibir más errores sería buenísimo",
  "dame de baja el plan caro y pasame al económico",
  "bajame de la lista de espera, quiero contratar ahora",
  "sacame de la lista de morosos, ya pagué",
  "¿aceptás transferencia?",
  "mandame el presupuesto",
  "lo consulto con mi socio",
  "mañana te confirmo",
  "¿incluye el dominio?",
  "quiero agregar el WhatsApp al sitio",
  "el local abre de lunes a viernes",
  "stop-motion para la portada, ¿se puede?",
  "quiero un video stop motion",
  "bajamos el presupuesto a la mitad",
  "gracias, seguimos por acá"
]

export const reviewPhrases = [
  'por favor não quero mais receber mensagens de vocês',
  'não quero mais receber mensagens de vocês',
  'por favor não quero receber mensagens de vocês',
  'por favor no quiero recibir más mensajes de ustedes',
  'no quiero más recibir mensajes',
  'no quiero más mensajes de ustedes',
  'não receber mensagens',
  'no recibir mensajes',
  'não receber mais',
  'no recibir más',
  'dame de baja',
  'por favor dame de baja de sus mensajes',
  'sacame de la lista',
  'bajame de la lista',
  'me tira da lista',
  'me tire da lista',
  'remover meu número',
  // Ambiguidade intencional: somente revisão, sem opt-out automático.
  'não quero mais receber isso',
  'me tira da lista por favor',
  'me tire da lista de espera, e não quero mais receber mensagens de vocês',
  'no quiero recibir llamadas, y no quiero más mensajes de ustedes',
]

export function originalPolicy() {
  const source = execFileSync('git', ['show', 'origin/main:src/lib/recovery-sequence-policy.ts'], { encoding: 'utf8' })
  const exports: Record<string, (text: string) => boolean> = {}
  runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports })
  return exports
}
