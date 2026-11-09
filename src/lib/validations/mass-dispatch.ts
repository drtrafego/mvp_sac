import { z } from 'zod'

const templateVariablesMapSchema = z.record(z.string(), z.string().min(1).max(2_000)).superRefine((map, context) => {
  const keys = Object.keys(map)
  const indexes: number[] = []

  for (const key of keys) {
    if (!/^[1-9]\d*$/.test(key)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key],
        message: 'As posições das variáveis devem ser inteiros positivos.',
      })
      continue
    }
    indexes.push(Number(key))
  }

  indexes.sort((a, b) => a - b)
  for (let index = 0; index < indexes.length; index += 1) {
    if (indexes[index] !== index + 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'As posições das variáveis devem ser contíguas, começando em 1.',
      })
      return
    }
  }
})

export function isSafeHeaderDocumentLink(value: string): boolean {
  if (/[\u0000-\u001f\u007f\s]/.test(value)) return false
  try {
    const url = new URL(value)
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
    const privateV4 = ipv4 !== null && (() => {
      const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
      return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    })()
    const blockedName = host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal') || !host.includes('.')
    const ipv6 = host.includes(':')
    return url.protocol === 'https:' && !url.username && !url.password && Boolean(host) && !privateV4 && !blockedName && !ipv6
  } catch {
    return false
  }
}

export function isSafeHeaderDocumentFilename(value: string): boolean {
  return /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,119}$/u.test(value) && !value.includes('..')
}

const templateHeaderDocumentSchema = z.object({
  link: z.string().max(2_000).refine(isSafeHeaderDocumentLink, 'O link do documento deve ser https público, sem credenciais.'),
  filename: z.string().refine(isSafeHeaderDocumentFilename, 'Nome de arquivo inválido.'),
}).strict()

export const MassDispatchTemplateSelection = z.object({
  templateName: z.string().trim().min(1).max(512),
  templateLanguage: z.string().trim().min(1).max(64),
  templateVariablesMap: templateVariablesMapSchema,
  templateHeaderDocument: templateHeaderDocumentSchema.optional(),
}).strict()

export type MassDispatchTemplateSelectionInput = z.infer<typeof MassDispatchTemplateSelection>
