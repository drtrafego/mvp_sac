const BRT_TZ = 'America/Sao_Paulo'

/** Retorna "YYYY-MM-DD" da data no horário de Brasília */
function brazilDateStr(date: Date): string {
  return date.toLocaleDateString('en-CA', { timeZone: BRT_TZ })
}

/** Converte "YYYY-MM-DD" para meia-noite no horário de Brasília (como UTC) */
function parseBrazilDate(dateStr: string): Date {
  return new Date(dateStr + 'T00:00:00-03:00')
}

/** Retorna meia-noite do dia atual no horário de Brasília (como UTC) */
function brazilTodayMidnight(now: Date): Date {
  return parseBrazilDate(brazilDateStr(now))
}

export function getDateRange(
  period: string,
  now: Date,
  fromStr?: string,
  toStr?: string,
): { fromDate: Date | null; toDate: Date } {
  const todayStart = brazilTodayMidnight(now)
  const DAY = 24 * 60 * 60 * 1000

  switch (period) {
    case 'today':
      return { fromDate: todayStart, toDate: now }

    case 'yesterday': {
      const yStart = new Date(todayStart.getTime() - DAY)
      return { fromDate: yStart, toDate: todayStart }
    }

    case '7d':
      return { fromDate: new Date(todayStart.getTime() - 6 * DAY), toDate: now }

    case '14d':
      return { fromDate: new Date(todayStart.getTime() - 13 * DAY), toDate: now }

    case 'month': {
      const monthStart = parseBrazilDate(brazilDateStr(now).slice(0, 7) + '-01')
      return { fromDate: monthStart, toDate: now }
    }

    case 'custom':
      if (fromStr) {
        return {
          fromDate: parseBrazilDate(fromStr),
          toDate: toStr ? new Date(parseBrazilDate(toStr).getTime() + DAY) : now,
        }
      }
      break

    case 'all':
      return { fromDate: null, toDate: now }
  }

  // default: 30d
  return { fromDate: new Date(todayStart.getTime() - 29 * DAY), toDate: now }
}
