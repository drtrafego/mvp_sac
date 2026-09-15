import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/*
  Os tokens de tipografia do produto (text-display, text-body, text-label...) não
  existem no Tailwind de fábrica, então o tailwind-merge os classificava como cor
  de texto. Resultado: dentro de um mesmo cn(), `text-body text-fg` virava só
  `text-fg` e o tamanho da fonte sumia. Registrar o grupo font-size resolve na
  raiz, em vez de obrigar cada componente a separar as classes na mão.
*/
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        {
          text: [
            'display',
            'metric',
            'metric-sm',
            'h1',
            'h2',
            'h3',
            'body',
            'label',
            'micro',
          ],
        },
      ],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
