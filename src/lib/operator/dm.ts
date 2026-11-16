// Gramática de entrada do admin. A extração ocorre antes da anonimização e
// não depende do plano, de nomes de entidades nem de uma escolha do modelo.
const ASPAS: Record<string, string> = { '"': '"', "'": "'", '“': '”', '‘': '’', '«': '»' }
const NOMES = 'mensagem|texto|dm|resposta|responder|responda|enviar|envie|mandar|mande'
const campo = /(?<![\p{L}\p{N}\p{M}\p{Cf}_-])([\p{L}\p{N}\p{M}\p{Cf}_-]+)[ \t]*:[ \t]*/uy
const legado = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}\\p{Cf}_-])(${NOMES})[ \\t]+`, 'iuy')
const nomeDM = new RegExp(`^(?:${NOMES})$`, 'i')
const outroRotulo = new RegExp(`(?<![\\p{L}\\p{N}\\p{M}\\p{Cf}_-])(?:${NOMES})[ \\t]*:`, 'iu')

function aspas(source: string, start: number) {
  const close = ASPAS[source[start]]
  if (!close) return null
  let value = ''
  let depth = 1
  for (let i = start + 1; i < source.length; i++) {
    if (source[i] === '\\' && [source[start], close, '\\'].includes(source[i + 1])) value += source[++i]
    else if (source[start] !== close && source[i] === source[start]) { depth++; value += source[i] }
    else if (source[i] === close) {
      if (--depth === 0) return { value, end: i + 1 }
      value += source[i]
    }
    else value += source[i]
  }
  return null
}

function fronteira(source: string, at: number) {
  const line = source.slice(source.lastIndexOf('\n', at - 1) + 1, at).trim()
  if (!line || /[;]$/.test(line)) return true
  // Compatibilidade com o comando legado: a DM segue um campo da regra.
  // Uma frase livre que apenas menciona a palavra "mensagem" não é campo.
  if (!/^(?:crie|criar|edite|editar|mova|altere|alterar)\b/i.test(line)) return false
  return /(?:\b(?:palavra(?:-chave)?|regra|etapa|produto)\s*:?\s*(?:"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|«[^»]*»|[^\s]+)|#\d+)$/iu.test(line)
    || /["'”’»]$/.test(line)
}

export function extrairDM(source: string): { text: string; mensagem?: string } {
  const blocos: Array<{ start: number; end: number; value?: string }> = []
  let malformed = false
  let lastFieldEnd = -1
  for (let i = 0; i < source.length;) {
    if (ASPAS[source[i]] && !/[\p{L}\p{N}]/u.test(source[i - 1] ?? '')) {
      const quoted = aspas(source, i)
      if (!quoted) {
        malformed = true
        blocos.push({ start: i, end: source.length })
        break
      }
      i = quoted.end
      continue
    }
    campo.lastIndex = legado.lastIndex = i
    const explicit = campo.exec(source)
    const match = explicit ?? legado.exec(source)
    if (!match) { i++; continue }
    let start = i + match[0].length
    const quotedNextLine = /^\r?\n[ \t]*(?=["'“‘«])/u.exec(source.slice(start))
    if (quotedNextLine) start += quotedNextLine[0].length
    const isDM = nomeDM.test(match[1]) && (fronteira(source, i)
      || (lastFieldEnd >= 0 && /^[ \t]*(?:e[ \t]+)?$/.test(source.slice(lastFieldEnd, i))))
    const quoted = aspas(source, start)
    let end: number
    let value: string | undefined
    if (quoted) {
      end = quoted.end; value = quoted.value
      if (source[end] && !/[\s;,!.?]/u.test(source[end])) { malformed = true; end = source.length }
    }
    else if (ASPAS[source[start]]) { end = source.length; malformed = true }
    else if (/^\r?\n/.test(source.slice(start))) {
      const from = start + (source[start] === '\r' ? 2 : 1)
      const boundary = /\r?\n[ \t]*\r?\n|\r?\n(?=[\p{L}\p{N}\p{M}\p{Cf}_-]+[ \t]*:)/u.exec(source.slice(from))
      end = boundary ? from + boundary.index : source.length
      value = /^\r?\n[ \t]*(?:\r?\n|$)/.test(source.slice(start)) ? '' : source.slice(from, end).trim()
    } else {
      const newline = source.indexOf('\n', start)
      end = newline < 0 ? source.length : newline
      value = source.slice(start, end).trim()
    }
    if (isDM) {
      // Dois campos na mesma linha sem aspas também são ambíguos. Rótulos
      // dentro de aspas pertencem ao conteúdo literal da mensagem.
      if (!quoted && value && outroRotulo.test(value)) malformed = true
      blocos.push({ start, end, value })
    }
    // Um campo alheio consome seu valor inteiro: "nota: mensagem: ..."
    // não pode reinterpretar a anotação como uma DM.
    lastFieldEnd = end
    i = end > i ? end : i + 1
  }
  const value = blocos[0]?.value
  const valid = !malformed && blocos.length === 1 && value !== undefined
    && value.trim().length > 0 && value.length <= 1500
    && !/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)
  let text = source
  for (const block of [...blocos].reverse()) text = text.slice(0, block.start) + (valid ? '[DM_1]' : '[DM_AUSENTE]') + text.slice(block.end)
  return { text, ...(valid ? { mensagem: value } : {}) }
}
