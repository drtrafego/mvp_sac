/**
 * Cliente pra API de agenda da Nina (AutonomIA), exposta pelo servidor local
 * do Gastao (fora da Vercel). Espelha o padrao de auth ja documentado pra
 * SAC (Bearer + x-agent-id), so que chamando ESTE servico, nao a API do SAC.
 *
 * Variaveis de ambiente que a Vercel do mvp_sac precisa ter (Production e
 * Preview, ver `vercel env add`):
 *   AGENDA_AUTONOMIA_API_URL   -> https://hermes.casaldotrafego.com/autonomia/agenda
 *   AGENDA_AUTONOMIA_API_TOKEN -> o Bearer token gerado no servidor (NAO o
 *                                 mesmo token de outra integracao; um token
 *                                 por consumidor, pra poder revogar so este
 *                                 sem derrubar os outros)
 *
 * O servidor (nginx -> agenda_api.py, dentro do container hermes1_autonomia)
 * ainda depende de DOIS passos que exigem acesso root: (1) adicionar o
 * location block no nginx e dar reload, (2) registrar o servico
 * agenda_api.py de forma supervisionada (hoje ele so roda como processo de
 * teste dentro do container, sem restart automatico).
 */

const BASE_URL = process.env.AGENDA_AUTONOMIA_API_URL ?? "";
const TOKEN = process.env.AGENDA_AUTONOMIA_API_TOKEN ?? "";

type ResultadoBase = { ok: boolean; erro?: string; detalhe?: string };

export type Horario = { start: string; end: string };

export type SlotsResultado = ResultadoBase & {
  horarios?: Horario[];
  lido_em?: string;
  valida_ate?: string;
  aviso?: string;
};

export type BookResultado = ResultadoBase & { event_id?: string };

export type RescheduleResultado = ResultadoBase & {
  event_id?: string;
  start_confirmado?: string;
  confirmado_na_agenda?: boolean;
  motivo?: string;
  encaminhar?: boolean;
};

export type CancelResultado = ResultadoBase & {
  event_id?: string;
  cancelado_na_agenda?: boolean;
  prova?: string;
  motivo?: string;
  encaminhar?: boolean;
};

function checarConfig() {
  if (!BASE_URL || !TOKEN) {
    throw new Error(
      "AGENDA_AUTONOMIA_API_URL / AGENDA_AUTONOMIA_API_TOKEN nao configurados " +
        "nesta env da Vercel. Sem isso a integracao nao chama nada (fail-closed).",
    );
  }
}

async function chamar<T>(
  path: string,
  init: RequestInit,
  agentId: string,
): Promise<T> {
  checarConfig();
  const resp = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      Authorization: `Bearer ${TOKEN}`,
      "x-agent-id": agentId,
      "Content-Type": "application/json",
    },
    // A agenda real pode demorar (Google Calendar + releitura de confirmacao).
    signal: AbortSignal.timeout(30_000),
  });
  if (resp.status === 401) {
    throw new Error("agenda_autonomia: token invalido ou ausente (401)");
  }
  if (resp.status === 429) {
    throw new Error("agenda_autonomia: rate limit excedido (429), tente depois");
  }
  return (await resp.json()) as T;
}

/** Lista horarios livres. Espelha `agenda_tools.py slots`. */
export async function buscarSlots(
  opts: { days?: number; startDate?: string; turno?: "manha" | "tarde" } = {},
  agentId = "sac",
): Promise<SlotsResultado> {
  const qs = new URLSearchParams();
  if (opts.days) qs.set("days", String(opts.days));
  if (opts.startDate) qs.set("start_date", opts.startDate);
  if (opts.turno) qs.set("turno", opts.turno);
  return chamar<SlotsResultado>(`/slots?${qs.toString()}`, { method: "GET" }, agentId);
}

/** Cria uma reuniao real. Espelha `agenda_tools.py book`. */
export async function marcarReuniao(
  dados: {
    nome: string;
    telefone: string;
    email?: string;
    start: string;
    end: string;
    forcar?: boolean;
    semEmail?: boolean;
  },
  agentId = "sac",
): Promise<BookResultado> {
  return chamar<BookResultado>(
    "/book",
    {
      method: "POST",
      body: JSON.stringify({
        nome: dados.nome,
        telefone: dados.telefone,
        email: dados.email ?? "",
        start: dados.start,
        end: dados.end,
        forcar: dados.forcar ?? false,
        sem_email: dados.semEmail ?? false,
      }),
    },
    agentId,
  );
}

/**
 * Remarca uma reuniao existente. O `telefone` e OBRIGATORIO e e o que trava
 * a identidade do lado do servidor: se nao bater com o telefone gravado no
 * evento, a chamada e recusada (ok:false, identidade_nao_confere) e NADA
 * muda na agenda. Nao existe bypass -- e proposital.
 */
export async function remarcarReuniao(
  dados: { eventId: string; telefone: string; start: string; end: string; forcar?: boolean },
  agentId = "sac",
): Promise<RescheduleResultado> {
  return chamar<RescheduleResultado>(
    "/reschedule",
    {
      method: "POST",
      body: JSON.stringify({
        event_id: dados.eventId,
        telefone: dados.telefone,
        start: dados.start,
        end: dados.end,
        forcar: dados.forcar ?? false,
      }),
    },
    agentId,
  );
}

/** Cancela uma reuniao existente. Mesma trava de identidade do remarcar. */
export async function cancelarReuniao(
  dados: { eventId: string; telefone: string },
  agentId = "sac",
): Promise<CancelResultado> {
  return chamar<CancelResultado>(
    "/cancel",
    {
      method: "POST",
      body: JSON.stringify({ event_id: dados.eventId, telefone: dados.telefone }),
    },
    agentId,
  );
}
