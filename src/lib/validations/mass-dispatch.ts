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

const templateHeaderDocumentSchema = z.object({
  link: z.string().url().max(2_000),
  filename: z.string().trim().min(1).max(255),
}).strict()

export const MassDispatchTemplateSelection = z.object({
  templateName: z.string().trim().min(1).max(512),
  templateLanguage: z.string().trim().min(1).max(64),
  templateVariablesMap: templateVariablesMapSchema,
  templateHeaderDocument: templateHeaderDocumentSchema.optional(),
}).strict()

export type MassDispatchTemplateSelectionInput = z.infer<typeof MassDispatchTemplateSelection>
