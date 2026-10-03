// Status reais confirmados via query direta em producao (company_id=4,
// 02/10/2026): compareceu=928, cancelou=232, nao_compareceu=97, pendente=60.
// So "compareceu" representa atendimento real (cliente de fato esteve no
// restaurante) -- bate com os numeros do sistema nativo do Gastao (19 vs 21,
// 17 vs 18, 17 vs 19, 13 vs 15 nos 4 dias testados). "pendente" NAO conta:
// e reserva ainda sem desfecho, nao houve atendimento ainda.
export const GRAMADO_VALID_RESERVATION_STATUSES = ['compareceu']

type GramadoReservationMetricRow = {
  data: string | Date
  status: string | null
  pessoas: number | null
  activityAt?: string | Date | null
}

export type GramadoReservationMetrics = {
  totalReservas: number
  totalPessoas: number
}

export function isGramadoValidReservationStatus(status: string | null | undefined): boolean {
  return GRAMADO_VALID_RESERVATION_STATUSES.includes((status || '').trim().toLocaleLowerCase('pt-BR'))
}

function dateOnly(value: string | Date): string {
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  return value.slice(0, 10)
}

export function summarizeGramadoReservationMetrics(
  reservations: GramadoReservationMetricRow[],
  from: string,
  to: string,
): GramadoReservationMetrics {
  return reservations.reduce<GramadoReservationMetrics>(
    (acc, reservation) => {
      const reservationDate = dateOnly(reservation.data)
      if (reservationDate < from || reservationDate > to) return acc
      if (!isGramadoValidReservationStatus(reservation.status)) return acc

      acc.totalReservas += 1
      acc.totalPessoas += Number(reservation.pessoas ?? 0)
      return acc
    },
    { totalReservas: 0, totalPessoas: 0 },
  )
}
