"""Analytics do painel SAC v2: agregados somente leitura, presos ao tenant.

Este modulo tem tres partes independentes de proposito:

1. **Janela de tempo** (``AnalyticsWindow`` / ``resolve_window``). A agregacao
   diaria e feita no fuso do cliente (padrao America/Sao_Paulo), nunca em UTC:
   um atendimento das 22h de Brasilia pertence ao dia local, nao ao dia
   seguinte em UTC. A janela tem teto (``MAX_WINDOW_DAYS``) para o cliente nao
   conseguir pedir uma varredura completa da base.

2. **Protecao de custo** (``AnalyticsCache`` e ``ComputationBudget``). O cache
   evita recalcular a mesma janela; o orcamento limita quantos calculos novos
   um agente pode custar por minuto, porque variar ``de``/``ate`` derruba o
   cache de proposito.

3. **Consultas** (``AnalyticsQueries``). Mixin do ``PostgresStore``: herda o
   escopo tenant/agente fixado no construtor da loja, entao nenhuma consulta
   daqui pode escapar do escopo mesmo que a rota erre. Nenhum metodo escreve;
   o cursor de analytics termina sempre em ``rollback``.

Zero vazamento: nada aqui seleciona ``*_secret_ref``, corpo de mensagem,
``last_error`` de outbox/DLQ, telefone, e-mail ou identificador externo de
usuario. O que sai daqui e contagem, duracao e rotulo de origem ja mascarado
por :func:`mask_pii`.
"""
from __future__ import annotations

import json
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import date, datetime, time as clock_time, timedelta, timezone
from typing import Any, Callable, Iterator, Mapping, Optional, Sequence
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .origins import CHANNELS, normalize as normalize_origin

# ---------------------------------------------------------------- janela

DEFAULT_TIMEZONE = "America/Sao_Paulo"
DEFAULT_PERIOD = "30d"
MAX_WINDOW_DAYS = 366
MIN_WINDOW_DAYS = 1
PERIODS: dict[str, int] = {"1d": 1, "7d": 7, "14d": 14, "30d": 30, "60d": 60,
                           "90d": 90, "180d": 180, "365d": 365}
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
_MAX_PARAM_CHARS = 64


def _zone(name: str) -> ZoneInfo:
    clean = str(name or "").strip() or DEFAULT_TIMEZONE
    if len(clean) > _MAX_PARAM_CHARS or "\x00" in clean or clean.startswith("/") or ".." in clean:
        raise ValueError("fuso horario invalido")
    try:
        return ZoneInfo(clean)
    except (ZoneInfoNotFoundError, ValueError, KeyError) as exc:
        raise ValueError("fuso horario invalido") from exc


def _parse_day(value: Any, field: str) -> date:
    text = str(value or "").strip()
    if not _DATE.fullmatch(text):
        raise ValueError(f"{field} deve ser uma data YYYY-MM-DD")
    try:
        return date.fromisoformat(text)
    except ValueError as exc:
        raise ValueError(f"{field} deve ser uma data YYYY-MM-DD") from exc


def _instant(day: date, zone: ZoneInfo) -> datetime:
    """Meia-noite local convertida para UTC, respeitando horario de verao."""
    return datetime.combine(day, clock_time(0, 0), tzinfo=zone).astimezone(timezone.utc)


def iso_instant(value: Any) -> Optional[str]:
    if value is None:
        return None
    if isinstance(value, datetime):
        moment = value if value.tzinfo else value.replace(tzinfo=timezone.utc)
        return moment.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return str(value)


@dataclass(frozen=True)
class AnalyticsWindow:
    """Intervalo fechado em dias locais e semiaberto em instantes UTC.

    ``starts_at`` e inclusivo e ``ends_at`` exclusivo: toda consulta usa
    ``occurred_at >= starts_at AND occurred_at < ends_at``, o que evita contar
    duas vezes o instante da virada do dia.
    """

    first_day: date
    last_day: date
    timezone_name: str
    period: Optional[str] = None

    def __post_init__(self) -> None:
        if self.last_day < self.first_day:
            raise ValueError("janela invertida")
        if self.days > MAX_WINDOW_DAYS:
            raise ValueError("janela grande demais")
        _zone(self.timezone_name)

    @property
    def zone(self) -> ZoneInfo:
        return _zone(self.timezone_name)

    @property
    def days(self) -> int:
        return (self.last_day - self.first_day).days + 1

    @property
    def starts_at(self) -> datetime:
        return _instant(self.first_day, self.zone)

    @property
    def ends_at(self) -> datetime:
        return _instant(self.last_day + timedelta(days=1), self.zone)

    @property
    def previous(self) -> "AnalyticsWindow":
        shift = timedelta(days=self.days)
        return AnalyticsWindow(self.first_day - shift, self.last_day - shift,
                               self.timezone_name, None)

    def day_keys(self) -> list[str]:
        return [(self.first_day + timedelta(days=offset)).isoformat()
                for offset in range(self.days)]

    def cache_key(self) -> tuple[str, str, str]:
        return (self.first_day.isoformat(), self.last_day.isoformat(), self.timezone_name)

    def public(self) -> dict[str, Any]:
        anterior = self.previous
        return {"period": self.period, "from": self.first_day.isoformat(),
                "to": self.last_day.isoformat(), "days": self.days,
                "timezone": self.timezone_name,
                "startsAt": iso_instant(self.starts_at),
                "endsAt": iso_instant(self.ends_at),
                "previous": {"from": anterior.first_day.isoformat(),
                             "to": anterior.last_day.isoformat(),
                             "startsAt": iso_instant(anterior.starts_at),
                             "endsAt": iso_instant(anterior.ends_at)}}


def resolve_window(*, period: Optional[str] = None, since: Optional[str] = None,
                   until: Optional[str] = None, timezone_name: Optional[str] = None,
                   max_days: int = MAX_WINDOW_DAYS,
                   default_period: str = DEFAULT_PERIOD,
                   now: Optional[datetime] = None) -> AnalyticsWindow:
    """Traduz os parametros de consulta em uma janela validada e com teto.

    ``de``/``ate`` sao datas locais inclusivas. Sem nenhum parametro vale
    ``default_period``. Qualquer entrada fora do contrato levanta ``ValueError``
    e a rota devolve 400 -- nunca uma varredura silenciosa da base inteira.
    """
    if max_days < MIN_WINDOW_DAYS or max_days > MAX_WINDOW_DAYS:
        raise ValueError("teto de janela invalido")
    zone_name = str(timezone_name or DEFAULT_TIMEZONE).strip() or DEFAULT_TIMEZONE
    zone = _zone(zone_name)
    moment = (now or datetime.now(timezone.utc))
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    today = moment.astimezone(zone).date()

    if since or until:
        if period:
            raise ValueError("use periodo ou de/ate, nunca os dois")
        last = _parse_day(until, "ate") if until else today
        if since:
            first = _parse_day(since, "de")
        else:
            first = last - timedelta(days=PERIODS[default_period] - 1)
        if last < first:
            raise ValueError("ate deve ser maior ou igual a de")
        if (last - first).days + 1 > max_days:
            raise ValueError("janela grande demais")
        return AnalyticsWindow(first, last, zone_name, None)

    chave = str(period or default_period).strip().lower()
    if chave not in PERIODS:
        raise ValueError("periodo desconhecido")
    tamanho = PERIODS[chave]
    if tamanho > max_days:
        raise ValueError("janela grande demais")
    return AnalyticsWindow(today - timedelta(days=tamanho - 1), today, zone_name, chave)


# ------------------------------------------------------------------ PII

_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_NUMBER_RUN = re.compile(r"\+?\d[\d\s().\-]{6,}\d")
MIN_MASKED_DIGITS = 10
MASK = "***"


def mask_pii(value: Any) -> Optional[str]:
    """Remove e-mail e sequencia telefonica de qualquer texto livre exportado.

    Rotulo de origem vem de JSON produzido por integracao externa, entao pode
    trazer contato dentro. Metrica e agregado: nada aqui precisa do valor
    original. Sequencias com menos de ``MIN_MASKED_DIGITS`` digitos ficam
    intactas para nao destruir datas e nomes de campanha.
    """
    if value is None:
        return None
    text = _EMAIL.sub(MASK, str(value))

    def _digits(match: re.Match[str]) -> str:
        trecho = match.group(0)
        return MASK if sum(c.isdigit() for c in trecho) >= MIN_MASKED_DIGITS else trecho

    return _NUMBER_RUN.sub(_digits, text)


# ---------------------------------------------------------------- cache

class AnalyticsCache:
    """Cache curto em memoria do processo, por (agente, relatorio, janela).

    A validade padrao e de 60 segundos: curta o bastante para o operador ver o
    efeito de uma acao, longa o bastante para absorver o painel recarregando o
    mesmo grafico. O cache morre com o processo e nunca vai para disco.
    """

    def __init__(self, *, ttl_seconds: float = 60.0, max_entries: int = 256,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if ttl_seconds <= 0 or max_entries < 1:
            raise ValueError("limites de cache invalidos")
        self.ttl_seconds = float(ttl_seconds)
        self.max_entries = int(max_entries)
        self._clock = clock
        self._entries: dict[tuple[Any, ...], tuple[float, Mapping[str, Any]]] = {}

    def _prune(self, now: float) -> None:
        for key in [key for key, (expira, _) in self._entries.items() if expira <= now]:
            self._entries.pop(key, None)

    def get(self, key: Sequence[Any]) -> Optional[dict[str, Any]]:
        now = self._clock()
        self._prune(now)
        found = self._entries.get(tuple(key))
        if found is None:
            return None
        return dict(found[1])

    def put(self, key: Sequence[Any], payload: Mapping[str, Any]) -> None:
        now = self._clock()
        self._prune(now)
        while len(self._entries) >= self.max_entries:
            oldest = min(self._entries.items(), key=lambda item: item[1][0])[0]
            self._entries.pop(oldest, None)
        self._entries[tuple(key)] = (now + self.ttl_seconds, dict(payload))

    def clear(self) -> None:
        self._entries.clear()

    def size(self) -> int:
        self._prune(self._clock())
        return len(self._entries)


class ComputationBudget:
    """Teto de agregacoes novas por agente numa janela deslizante.

    O cache sozinho nao protege: quem varia ``de``/``ate`` a cada pedido erra o
    cache de proposito e paga consulta pesada toda vez. Aqui o custo por agente
    fica limitado; estourar devolve 429, nunca uma consulta a mais.
    """

    def __init__(self, *, max_computations: int = 30, window_seconds: float = 60.0,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if max_computations < 1 or window_seconds <= 0:
            raise ValueError("limites de orcamento invalidos")
        self.max_computations = int(max_computations)
        self.window_seconds = float(window_seconds)
        self._clock = clock
        self._used: dict[tuple[Any, ...], tuple[int, float]] = {}

    def allow(self, key: Sequence[Any]) -> bool:
        now = self._clock()
        chave = tuple(key)
        usados, reinicia = self._used.get(chave, (0, 0.0))
        if reinicia <= now:
            usados, reinicia = 0, now + self.window_seconds
        if usados >= self.max_computations:
            self._used[chave] = (usados, reinicia)
            return False
        self._used[chave] = (usados + 1, reinicia)
        return True


# -------------------------------------------------------------- numeros

def to_int(value: Any) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def to_seconds(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return round(float(value), 3)
    except (TypeError, ValueError):
        return None


def percentage(part: Any, whole: Any) -> Optional[float]:
    """Participacao em porcento; base zero devolve ``None``, nunca erro."""
    total = to_int(whole)
    if total <= 0:
        return None
    return round(100.0 * to_int(part) / total, 2)


def delta(current: Any, previous: Any) -> dict[str, Any]:
    """Comparacao com o periodo anterior; base zero deixa ``percent`` nulo."""
    atual, anterior = to_int(current), to_int(previous)
    return {"current": atual, "previous": anterior, "absolute": atual - anterior,
            "percent": None if anterior == 0 else round(100.0 * (atual - anterior) / anterior, 2)}


def _day_key(value: Any) -> str:
    if isinstance(value, datetime):
        return value.date().isoformat()
    if isinstance(value, date):
        return value.isoformat()
    return str(value or "")[:10]


# -------------------------------------------------------------- consultas

class AnalyticsQueries:
    """Relatorios agregados do painel. Mixado em ``PostgresStore``.

    Depende de ``_table``, ``_scope``, ``_value``, ``_factory`` e ``pipeline``,
    todos definidos pela loja. O escopo tenant/agente ja vem fixado no
    construtor dela: nenhum parametro de rota chega ate aqui.
    """

    ANALYTICS_MAX_GROUPS = 500
    ANALYTICS_TOP_ORIGINS = 100
    ANALYTICS_TOP_OPERATORS = 100
    HEALTH_WARN_SECONDS = 300.0
    HEALTH_CRITICAL_SECONDS = 1800.0
    OUTBOX_BACKLOG_STATUS = ("pending", "retry", "processing")

    # ------------------------------------------------------------ suporte

    @contextmanager
    def _analytics_cursor(self) -> Iterator[Any]:
        """Cursor somente leitura: termina em rollback, jamais em commit."""
        connection = self._factory()  # type: ignore[attr-defined]
        cursor = connection.cursor()
        try:
            yield cursor
        finally:
            rollback = getattr(connection, "rollback", None)
            if callable(rollback):
                rollback()
            close = getattr(cursor, "close", None)
            if callable(close):
                close()
            if getattr(self, "_close_connections", True):
                connection.close()

    def _analytics_read(self, row: Any, key: str, position: int) -> Any:
        """Le a celula por nome e cai para a posicao; ausencia vira ``None``.

        Agregado sem linha nenhuma (cliente novo, agente recem-provisionado) e
        caso normal, nao erro: a metrica sai zerada e o painel abre vazio.
        """
        if row is None:
            return None
        try:
            return self._value(row, key, position)  # type: ignore[attr-defined]
        except (KeyError, IndexError, TypeError):
            return None

    @staticmethod
    def _analytics_json(value: Any) -> dict[str, Any]:
        if isinstance(value, str):
            try:
                value = json.loads(value)
            except ValueError:
                return {}
        return dict(value) if isinstance(value, Mapping) else {}

    def _analytics_rows(self, statements: Sequence[tuple[str, tuple[Any, ...]]]) -> list[list[Any]]:
        results: list[list[Any]] = []
        with self._analytics_cursor() as cur:
            for sql, params in statements:
                cur.execute(sql, params)
                results.append(list(cur.fetchall() or []))
        return results

    def _analytics_tables(self, *names: str) -> dict[str, str]:
        """Alias curto para o texto das consultas: ``sac_messages`` -> ``messages``."""
        return {name.removeprefix("sac_"): self._table(name)  # type: ignore[attr-defined]
                for name in names}

    def _bounds(self, window: AnalyticsWindow) -> tuple[datetime, datetime]:
        return window.starts_at, window.ends_at

    def _envelope(self, window: AnalyticsWindow, payload: Mapping[str, Any]) -> dict[str, Any]:
        return {"window": window.public(),
                "generatedAt": iso_instant(datetime.now(timezone.utc)),
                **payload}

    @staticmethod
    def _dense(window: AnalyticsWindow, indexed: Mapping[str, Mapping[str, Any]],
               template: Mapping[str, Any]) -> list[dict[str, Any]]:
        """Serie diaria sem buraco: dia sem dado vira zero, nao some do grafico."""
        return [{"date": dia, **dict(template), **dict(indexed.get(dia, {}))}
                for dia in window.day_keys()]

    # ----------------------------------------------------------- overview

    OVERVIEW_TOTALS_SQL = """
        SELECT count(*) AS mensagens,
               count(*) FILTER (WHERE m.direction = 'inbound') AS entrada,
               count(*) FILTER (WHERE m.direction = 'outbound') AS saida,
               count(DISTINCT m.thread_id) AS conversas,
               count(DISTINCT i.contact_id) AS contatos,
               count(DISTINCT m.thread_id) FILTER (WHERE t.created_at >= %s) AS conversas_novas,
               count(DISTINCT i.contact_id) FILTER (WHERE c.created_at >= %s) AS contatos_novos
          FROM {messages} m
          JOIN {threads} t ON t.tenant_id = m.tenant_id AND t.agent_id = m.agent_id
           AND t.id = m.thread_id
          JOIN {identities} i ON i.tenant_id = t.tenant_id AND i.agent_id = t.agent_id
           AND i.id = t.identity_id
          JOIN {contacts} c ON c.tenant_id = i.tenant_id AND c.agent_id = i.agent_id
           AND c.id = i.contact_id
         WHERE m.tenant_id = %s AND m.agent_id = %s
           AND m.occurred_at >= %s AND m.occurred_at < %s
    """
    OVERVIEW_SERIES_SQL = """
        SELECT (m.occurred_at AT TIME ZONE %s)::date AS dia,
               count(*) AS mensagens,
               count(*) FILTER (WHERE m.direction = 'inbound') AS entrada,
               count(*) FILTER (WHERE m.direction = 'outbound') AS saida,
               count(DISTINCT m.thread_id) AS conversas,
               count(DISTINCT i.contact_id) AS contatos
          FROM {messages} m
          JOIN {threads} t ON t.tenant_id = m.tenant_id AND t.agent_id = m.agent_id
           AND t.id = m.thread_id
          JOIN {identities} i ON i.tenant_id = t.tenant_id AND i.agent_id = t.agent_id
           AND i.id = t.identity_id
         WHERE m.tenant_id = %s AND m.agent_id = %s
           AND m.occurred_at >= %s AND m.occurred_at < %s
         GROUP BY 1 ORDER BY 1
    """
    OVERVIEW_NEW_SQL = """
        SELECT dia, sum(conversas) AS conversas, sum(contatos) AS contatos
          FROM (
            SELECT (t.created_at AT TIME ZONE %s)::date AS dia, 1 AS conversas, 0 AS contatos
              FROM {threads} t
             WHERE t.tenant_id = %s AND t.agent_id = %s
               AND t.created_at >= %s AND t.created_at < %s
            UNION ALL
            SELECT (c.created_at AT TIME ZONE %s)::date AS dia, 0 AS conversas, 1 AS contatos
              FROM {contacts} c
             WHERE c.tenant_id = %s AND c.agent_id = %s AND c.merged_into IS NULL
               AND c.created_at >= %s AND c.created_at < %s
          ) AS novos
         GROUP BY dia ORDER BY dia
    """

    @staticmethod
    def _overview_totals(row: Any, reader: Callable[[Any, str, int], Any]) -> dict[str, Any]:
        conversas = to_int(reader(row, "conversas", 3))
        novas = to_int(reader(row, "conversas_novas", 5))
        contatos = to_int(reader(row, "contatos", 4))
        novos = to_int(reader(row, "contatos_novos", 6))
        mensagens = to_int(reader(row, "mensagens", 0))
        return {
            "conversations": conversas,
            "newConversations": novas,
            "returningConversations": max(conversas - novas, 0),
            "contacts": contatos,
            "newContacts": novos,
            "returningContacts": max(contatos - novos, 0),
            "messages": mensagens,
            "inboundMessages": to_int(reader(row, "entrada", 1)),
            "outboundMessages": to_int(reader(row, "saida", 2)),
            "messagesPerConversation": (round(mensagens / conversas, 2) if conversas else 0.0),
        }

    def analytics_overview(self, window: AnalyticsWindow) -> dict[str, Any]:
        """Volume, contatos unicos, novas x recorrentes, serie diaria e delta."""
        tabelas = self._analytics_tables("sac_messages", "sac_threads", "sac_identities",
                                         "sac_contacts")
        totals_sql = self.OVERVIEW_TOTALS_SQL.format(**tabelas)
        inicio, fim = self._bounds(window)
        anterior = window.previous
        inicio_anterior, fim_anterior = self._bounds(anterior)
        escopo = self._scope()  # type: ignore[attr-defined]
        fuso = window.timezone_name
        atual_rows, anterior_rows, serie_rows, novos_rows = self._analytics_rows((
            (totals_sql, (inicio, inicio, *escopo, inicio, fim)),
            (totals_sql, (inicio_anterior, inicio_anterior, *escopo, inicio_anterior, fim_anterior)),
            (self.OVERVIEW_SERIES_SQL.format(**tabelas), (fuso, *escopo, inicio, fim)),
            (self.OVERVIEW_NEW_SQL.format(**tabelas),
             (fuso, *escopo, inicio, fim, fuso, *escopo, inicio, fim)),
        ))
        reader = self._analytics_read
        vazio: dict[str, Any] = {}
        atual = self._overview_totals(atual_rows[0] if atual_rows else vazio, reader)
        passado = self._overview_totals(anterior_rows[0] if anterior_rows else vazio, reader)

        indexado: dict[str, dict[str, Any]] = {}
        for row in serie_rows:
            indexado[_day_key(reader(row, "dia", 0))] = {
                "messages": to_int(reader(row, "mensagens", 1)),
                "inboundMessages": to_int(reader(row, "entrada", 2)),
                "outboundMessages": to_int(reader(row, "saida", 3)),
                "conversations": to_int(reader(row, "conversas", 4)),
                "contacts": to_int(reader(row, "contatos", 5)),
            }
        for row in novos_rows:
            dia = _day_key(reader(row, "dia", 0))
            entrada = indexado.setdefault(dia, {})
            entrada["newConversations"] = to_int(reader(row, "conversas", 1))
            entrada["newContacts"] = to_int(reader(row, "contatos", 2))
        modelo = {"messages": 0, "inboundMessages": 0, "outboundMessages": 0,
                  "conversations": 0, "contacts": 0, "newConversations": 0, "newContacts": 0}
        return self._envelope(window, {
            "totals": atual,
            "previous": passado,
            "delta": {chave: delta(atual[chave], passado[chave])
                      for chave in ("conversations", "newConversations", "contacts",
                                    "newContacts", "messages", "inboundMessages",
                                    "outboundMessages")},
            "series": self._dense(window, indexado, modelo),
        })

    # ----------------------------------------------------------- canais

    CHANNEL_TOTALS_SQL = """
        SELECT t.channel AS canal,
               count(*) AS mensagens,
               count(*) FILTER (WHERE m.direction = 'inbound') AS entrada,
               count(*) FILTER (WHERE m.direction = 'outbound') AS saida,
               count(DISTINCT m.thread_id) AS conversas,
               count(DISTINCT i.contact_id) AS contatos,
               count(DISTINCT m.thread_id) FILTER (WHERE t.created_at >= %s) AS conversas_novas
          FROM {messages} m
          JOIN {threads} t ON t.tenant_id = m.tenant_id AND t.agent_id = m.agent_id
           AND t.id = m.thread_id
          JOIN {identities} i ON i.tenant_id = t.tenant_id AND i.agent_id = t.agent_id
           AND i.id = t.identity_id
         WHERE m.tenant_id = %s AND m.agent_id = %s
           AND m.occurred_at >= %s AND m.occurred_at < %s
         GROUP BY GROUPING SETS ((), (t.channel))
    """
    CHANNEL_SERIES_SQL = """
        SELECT t.channel AS canal, (m.occurred_at AT TIME ZONE %s)::date AS dia,
               count(*) AS mensagens,
               count(*) FILTER (WHERE m.direction = 'inbound') AS entrada,
               count(*) FILTER (WHERE m.direction = 'outbound') AS saida,
               count(DISTINCT m.thread_id) AS conversas
          FROM {messages} m
          JOIN {threads} t ON t.tenant_id = m.tenant_id AND t.agent_id = m.agent_id
           AND t.id = m.thread_id
         WHERE m.tenant_id = %s AND m.agent_id = %s
           AND m.occurred_at >= %s AND m.occurred_at < %s
         GROUP BY 1, 2 ORDER BY 1, 2
    """

    def _channel_totals(self, rows: Sequence[Any]) -> tuple[dict[str, dict[str, Any]],
                                                            dict[str, Any]]:
        reader = self._analytics_read
        por_canal: dict[str, dict[str, Any]] = {}
        geral: dict[str, Any] = {}
        for row in rows:
            canal = reader(row, "canal", 0)
            conversas = to_int(reader(row, "conversas", 4))
            novas = to_int(reader(row, "conversas_novas", 6))
            medido = {
                "conversations": conversas,
                "newConversations": novas,
                "returningConversations": max(conversas - novas, 0),
                "contacts": to_int(reader(row, "contatos", 5)),
                "messages": to_int(reader(row, "mensagens", 1)),
                "inboundMessages": to_int(reader(row, "entrada", 2)),
                "outboundMessages": to_int(reader(row, "saida", 3)),
            }
            if canal is None:
                geral = medido
            else:
                por_canal[str(canal)] = medido
        return por_canal, geral

    @staticmethod
    def _zero_channel() -> dict[str, Any]:
        return {"conversations": 0, "newConversations": 0, "returningConversations": 0,
                "contacts": 0, "messages": 0, "inboundMessages": 0, "outboundMessages": 0}

    def analytics_channels(self, window: AnalyticsWindow) -> dict[str, Any]:
        """As mesmas metricas por canal, com participacao e serie propria.

        Canal aqui e o meio da conversa (WhatsApp, Instagram, e-mail) e nao tem
        relacao com origem de aquisicao, que vive em ``analytics_origins``.
        """
        tabelas = self._analytics_tables("sac_messages", "sac_threads", "sac_identities")
        totals_sql = self.CHANNEL_TOTALS_SQL.format(**tabelas)
        inicio, fim = self._bounds(window)
        anterior = window.previous
        inicio_anterior, fim_anterior = self._bounds(anterior)
        escopo = self._scope()  # type: ignore[attr-defined]
        atual_rows, anterior_rows, serie_rows = self._analytics_rows((
            (totals_sql, (inicio, *escopo, inicio, fim)),
            (totals_sql, (inicio_anterior, *escopo, inicio_anterior, fim_anterior)),
            (self.CHANNEL_SERIES_SQL.format(**tabelas),
             (window.timezone_name, *escopo, inicio, fim)),
        ))
        atual, geral = self._channel_totals(atual_rows)
        passado, geral_anterior = self._channel_totals(anterior_rows)

        reader = self._analytics_read
        series: dict[str, dict[str, dict[str, Any]]] = {}
        for row in serie_rows:
            canal = str(reader(row, "canal", 0) or "")
            series.setdefault(canal, {})[_day_key(reader(row, "dia", 1))] = {
                "messages": to_int(reader(row, "mensagens", 2)),
                "inboundMessages": to_int(reader(row, "entrada", 3)),
                "outboundMessages": to_int(reader(row, "saida", 4)),
                "conversations": to_int(reader(row, "conversas", 5)),
            }
        modelo = {"messages": 0, "inboundMessages": 0, "outboundMessages": 0, "conversations": 0}
        conhecidos = sorted(CHANNELS)
        canais = conhecidos + sorted(set(atual) - set(conhecidos))
        totais = geral or self._zero_channel()
        itens = []
        for canal in canais:
            medido = atual.get(canal, self._zero_channel())
            base = passado.get(canal, self._zero_channel())
            itens.append({
                "channel": canal, **medido,
                "share": {"conversations": percentage(medido["conversations"],
                                                      totais["conversations"]),
                          "messages": percentage(medido["messages"], totais["messages"])},
                "previous": base,
                "delta": {chave: delta(medido[chave], base[chave])
                          for chave in ("conversations", "contacts", "messages")},
                "series": self._dense(window, series.get(canal, {}), modelo),
            })
        return self._envelope(window, {
            "channels": itens,
            "totals": totais,
            "previousTotals": geral_anterior or self._zero_channel(),
        })

    # ---------------------------------------------------------- origens

    ORIGIN_TOTALS_SQL = """
        SELECT o.data AS data, count(DISTINCT o.contact_id) AS contatos,
               count(*) AS registros, min(o.created_at) AS primeiro,
               max(o.created_at) AS ultimo
          FROM {origins} o
         WHERE o.tenant_id = %s AND o.agent_id = %s
           AND o.created_at >= %s AND o.created_at < %s
         GROUP BY o.data
         ORDER BY count(DISTINCT o.contact_id) DESC
         LIMIT %s
    """
    ORIGIN_ACTIVITY_SQL = """
        SELECT o.data AS data, count(DISTINCT t.id) AS conversas,
               count(m.id) AS mensagens
          FROM {origins} o
          JOIN {identities} i ON i.tenant_id = o.tenant_id AND i.agent_id = o.agent_id
           AND i.contact_id = o.contact_id
          JOIN {threads} t ON t.tenant_id = i.tenant_id AND t.agent_id = i.agent_id
           AND t.identity_id = i.id
          LEFT JOIN {messages} m ON m.tenant_id = t.tenant_id AND m.agent_id = t.agent_id
           AND m.thread_id = t.id AND m.occurred_at >= %s AND m.occurred_at < %s
         WHERE o.tenant_id = %s AND o.agent_id = %s
           AND o.created_at >= %s AND o.created_at < %s
         GROUP BY o.data
         LIMIT %s
    """

    def analytics_origins(self, window: AnalyticsWindow) -> dict[str, Any]:
        """Aquisicao por origem, agregada pelo slug estavel de ``origins.py``.

        A janela filtra ``sac_origins.created_at``: e a data em que o contato
        foi adquirido por aquela origem. Origem nunca vira canal e canal nunca
        vira origem -- ``channel`` aqui e o campo declarado pela propria origem.
        """
        tabelas = self._analytics_tables("sac_origins", "sac_identities", "sac_threads",
                                         "sac_messages")
        inicio, fim = self._bounds(window)
        escopo = self._scope()  # type: ignore[attr-defined]
        limite = self.ANALYTICS_MAX_GROUPS
        totals_rows, activity_rows = self._analytics_rows((
            (self.ORIGIN_TOTALS_SQL.format(**tabelas), (*escopo, inicio, fim, limite)),
            (self.ORIGIN_ACTIVITY_SQL.format(**tabelas),
             (inicio, fim, *escopo, inicio, fim, limite)),
        ))
        reader = self._analytics_read
        atividade: dict[str, dict[str, int]] = {}
        for row in activity_rows:
            origem = normalize_origin(self._analytics_json(reader(row, "data", 0)))
            alvo = atividade.setdefault(origem.slug, {"conversations": 0, "messages": 0})
            alvo["conversations"] += to_int(reader(row, "conversas", 1))
            alvo["messages"] += to_int(reader(row, "mensagens", 2))

        agrupado: dict[str, dict[str, Any]] = {}
        for row in totals_rows:
            origem = normalize_origin(self._analytics_json(reader(row, "data", 0)))
            entrada = agrupado.setdefault(origem.slug, {
                "slug": origem.slug, "label": mask_pii(origem.label),
                "channel": origem.channel, "platform": mask_pii(origem.platform),
                "campaign": mask_pii(origem.campaign), "identified": origem.identified,
                "contacts": 0, "records": 0, "firstSeenAt": None, "lastSeenAt": None})
            entrada["contacts"] += to_int(reader(row, "contatos", 1))
            entrada["records"] += to_int(reader(row, "registros", 2))
            primeiro = iso_instant(reader(row, "primeiro", 3))
            ultimo = iso_instant(reader(row, "ultimo", 4))
            if primeiro and (entrada["firstSeenAt"] is None or primeiro < entrada["firstSeenAt"]):
                entrada["firstSeenAt"] = primeiro
            if ultimo and (entrada["lastSeenAt"] is None or ultimo > entrada["lastSeenAt"]):
                entrada["lastSeenAt"] = ultimo
        total_contatos = sum(item["contacts"] for item in agrupado.values())
        identificados = sum(item["contacts"] for item in agrupado.values() if item["identified"])
        origens = sorted(agrupado.values(), key=lambda item: (-item["contacts"], item["slug"]))
        recortadas = origens[:self.ANALYTICS_TOP_ORIGINS]
        for item in recortadas:
            item.update(atividade.get(item["slug"], {"conversations": 0, "messages": 0}))
            item["share"] = {"contacts": percentage(item["contacts"], total_contatos)}
        return self._envelope(window, {
            "origins": recortadas,
            "totals": {"contacts": total_contatos, "origins": len(agrupado),
                       "identifiedContacts": identificados,
                       "unidentifiedContacts": max(total_contatos - identificados, 0),
                       "identifiedShare": percentage(identificados, total_contatos)},
            "truncated": len(origens) > len(recortadas) or len(totals_rows) >= limite,
        })

    # --------------------------------------------------------- pipeline

    PIPELINE_CURRENT_SQL = """
        SELECT pipeline_stage AS etapa, count(*) AS contatos
          FROM {contacts}
         WHERE tenant_id = %s AND agent_id = %s AND merged_into IS NULL
         GROUP BY pipeline_stage
    """
    PIPELINE_MOVES_SQL = """
        SELECT from_stage AS de, to_stage AS para, count(*) AS movimentos,
               count(DISTINCT contact_id) AS contatos
          FROM {history}
         WHERE tenant_id = %s AND agent_id = %s
           AND created_at >= %s AND created_at < %s
         GROUP BY from_stage, to_stage
    """
    PIPELINE_DURATION_SQL = """
        SELECT d.etapa AS etapa, count(*) AS amostras,
               avg(d.segundos) AS media,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY d.segundos) AS mediana,
               percentile_cont(0.9) WITHIN GROUP (ORDER BY d.segundos) AS p90
          FROM (
            SELECT h.to_stage AS etapa, h.created_at AS entrada,
                   EXTRACT(EPOCH FROM (
                     lead(h.created_at) OVER (
                       PARTITION BY h.contact_id ORDER BY h.created_at, h.id
                     ) - h.created_at)) AS segundos
              FROM {history} h
             WHERE h.tenant_id = %s AND h.agent_id = %s AND h.created_at >= %s
          ) AS d
         WHERE d.entrada < %s AND d.segundos IS NOT NULL
         GROUP BY d.etapa
    """

    def analytics_pipeline(self, window: AnalyticsWindow) -> dict[str, Any]:
        """Funil: estoque por etapa, entradas/saidas, conversao e permanencia.

        ``contacts`` e estoque atual (nao depende da janela). ``entered``,
        ``exited`` e as duracoes vem de ``sac_pipeline_history`` dentro da
        janela. A permanencia so conta intervalos fechados, isto e, etapas das
        quais o contato ja saiu; quem ainda esta parado na etapa nao entra na
        media para nao fabricar um numero que so cresce.
        """
        tabelas = {"contacts": self._table("sac_contacts"),  # type: ignore[attr-defined]
                   "history": self._table("sac_pipeline_history")}  # type: ignore[attr-defined]
        inicio, fim = self._bounds(window)
        escopo = self._scope()  # type: ignore[attr-defined]
        atuais, movimentos, duracoes = self._analytics_rows((
            (self.PIPELINE_CURRENT_SQL.format(**tabelas), escopo),
            (self.PIPELINE_MOVES_SQL.format(**tabelas), (*escopo, inicio, fim)),
            (self.PIPELINE_DURATION_SQL.format(**tabelas), (*escopo, inicio, fim)),
        ))
        reader = self._analytics_read
        estoque = {str(reader(row, "etapa", 0)): to_int(reader(row, "contatos", 1))
                   for row in atuais}
        transicoes: list[dict[str, Any]] = []
        entradas: dict[str, int] = {}
        saidas: dict[str, int] = {}
        para_proxima: dict[tuple[str, str], int] = {}
        for row in movimentos:
            de = reader(row, "de", 0)
            para = str(reader(row, "para", 1))
            quantidade = to_int(reader(row, "movimentos", 2))
            transicoes.append({"from": None if de is None else str(de), "to": para,
                               "movements": quantidade,
                               "contacts": to_int(reader(row, "contatos", 3))})
            entradas[para] = entradas.get(para, 0) + quantidade
            if de is not None:
                saidas[str(de)] = saidas.get(str(de), 0) + quantidade
                para_proxima[(str(de), para)] = para_proxima.get((str(de), para), 0) + quantidade
        permanencia = {str(reader(row, "etapa", 0)): {
            "samples": to_int(reader(row, "amostras", 1)),
            "averageSeconds": to_seconds(reader(row, "media", 2)),
            "medianSeconds": to_seconds(reader(row, "mediana", 3)),
            "p90Seconds": to_seconds(reader(row, "p90", 4))} for row in duracoes}

        canonicas = list(self.pipeline.stages)  # type: ignore[attr-defined]
        extras = sorted(set(estoque) | set(entradas) | set(saidas) | set(permanencia))
        ordenadas = canonicas + [etapa for etapa in extras if etapa not in canonicas]
        etapas = []
        for posicao, etapa in enumerate(ordenadas):
            proxima = ordenadas[posicao + 1] if posicao + 1 < len(ordenadas) else None
            entrou = entradas.get(etapa, 0)
            convertidos = para_proxima.get((etapa, proxima), 0) if proxima else 0
            etapas.append({
                "id": etapa, "order": posicao,
                "contacts": estoque.get(etapa, 0),
                "entered": entrou,
                "exited": saidas.get(etapa, 0),
                "timeInStage": permanencia.get(etapa, {"samples": 0, "averageSeconds": None,
                                                       "medianSeconds": None, "p90Seconds": None}),
                "conversionToNext": None if proxima is None else {
                    "stage": proxima, "movements": convertidos,
                    "rate": percentage(convertidos, entrou)},
            })
        return self._envelope(window, {
            "stages": etapas,
            "transitions": sorted(transicoes, key=lambda item: -item["movements"]),
            "totals": {"contacts": sum(estoque.values()),
                       "movements": sum(item["movements"] for item in transicoes),
                       "stages": len(etapas)},
        })

    # ---------------------------------------------------- tempo resposta

    RESPONSE_FIRST_SQL = """
        WITH janela AS (
          SELECT m.thread_id AS thread_id, m.direction AS direction,
                 m.occurred_at AS occurred_at
            FROM {messages} m
           WHERE m.tenant_id = %s AND m.agent_id = %s
             AND m.occurred_at >= %s AND m.occurred_at < %s
        ), entradas AS (
          SELECT thread_id, min(occurred_at) AS entrada
            FROM janela WHERE direction = 'inbound' GROUP BY thread_id
        ), respostas AS (
          SELECT e.thread_id AS thread_id, e.entrada AS entrada,
                 (SELECT min(j.occurred_at) FROM janela j
                   WHERE j.thread_id = e.thread_id AND j.direction = 'outbound'
                     AND j.occurred_at > e.entrada) AS saida
            FROM entradas e
        )
        SELECT t.channel AS canal, count(*) AS conversas,
               count(r.saida) AS respondidas,
               avg(EXTRACT(EPOCH FROM (r.saida - r.entrada))) AS media,
               percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (r.saida - r.entrada))) AS mediana,
               percentile_cont(0.9) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (r.saida - r.entrada))) AS p90
          FROM respostas r
          JOIN {threads} t ON t.tenant_id = %s AND t.agent_id = %s AND t.id = r.thread_id
         GROUP BY GROUPING SETS ((), (t.channel))
    """
    RESPONSE_RESOLUTION_SQL = """
        WITH fechadas AS (
          SELECT t.id AS thread_id, t.channel AS canal,
                 min(m.occurred_at) AS inicio, max(m.occurred_at) AS fim
            FROM {threads} t
            JOIN {messages} m ON m.tenant_id = t.tenant_id AND m.agent_id = t.agent_id
             AND m.thread_id = t.id
           WHERE t.tenant_id = %s AND t.agent_id = %s AND t.status = 'closed'
             AND t.updated_at >= %s AND t.updated_at < %s
           GROUP BY t.id, t.channel
        )
        SELECT canal, count(*) AS conversas,
               avg(EXTRACT(EPOCH FROM (fim - inicio))) AS media,
               percentile_cont(0.5) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (fim - inicio))) AS mediana,
               percentile_cont(0.9) WITHIN GROUP (
                 ORDER BY EXTRACT(EPOCH FROM (fim - inicio))) AS p90
          FROM fechadas
         GROUP BY GROUPING SETS ((), (canal))
    """

    def _first_response(self, rows: Sequence[Any]) -> dict[Optional[str], dict[str, Any]]:
        reader = self._analytics_read
        medido: dict[Optional[str], dict[str, Any]] = {}
        for row in rows:
            canal = reader(row, "canal", 0)
            conversas = to_int(reader(row, "conversas", 1))
            respondidas = to_int(reader(row, "respondidas", 2))
            medido[None if canal is None else str(canal)] = {
                "conversations": conversas, "answered": respondidas,
                "pending": max(conversas - respondidas, 0),
                "responseRate": percentage(respondidas, conversas),
                "averageSeconds": to_seconds(reader(row, "media", 3)),
                "medianSeconds": to_seconds(reader(row, "mediana", 4)),
                "p90Seconds": to_seconds(reader(row, "p90", 5))}
        return medido

    def _resolution(self, rows: Sequence[Any]) -> dict[Optional[str], dict[str, Any]]:
        reader = self._analytics_read
        medido: dict[Optional[str], dict[str, Any]] = {}
        for row in rows:
            canal = reader(row, "canal", 0)
            medido[None if canal is None else str(canal)] = {
                "conversations": to_int(reader(row, "conversas", 1)),
                "averageSeconds": to_seconds(reader(row, "media", 2)),
                "medianSeconds": to_seconds(reader(row, "mediana", 3)),
                "p90Seconds": to_seconds(reader(row, "p90", 4))}
        return medido

    @staticmethod
    def _zero_first_response() -> dict[str, Any]:
        return {"conversations": 0, "answered": 0, "pending": 0, "responseRate": None,
                "averageSeconds": None, "medianSeconds": None, "p90Seconds": None}

    @staticmethod
    def _zero_resolution() -> dict[str, Any]:
        return {"conversations": 0, "averageSeconds": None, "medianSeconds": None,
                "p90Seconds": None}

    def analytics_response_times(self, window: AnalyticsWindow) -> dict[str, Any]:
        """Tempo ate a primeira resposta e tempo de resolucao, com mediana e p90.

        Media entra junto porque o cliente pede, mas cauda longa distorce media:
        a leitura honesta e mediana + p90. Primeira resposta usa, por conversa,
        a primeira mensagem de entrada da janela e a primeira saida posterior a
        ela. Resolucao usa conversas fechadas cujo ``updated_at`` caiu na
        janela, medindo da primeira ate a ultima mensagem da conversa -- o
        schema nao tem coluna ``closed_at``, entao esse e o melhor proxy.
        """
        tabelas = self._analytics_tables("sac_messages", "sac_threads")
        primeira_sql = self.RESPONSE_FIRST_SQL.format(**tabelas)
        resolucao_sql = self.RESPONSE_RESOLUTION_SQL.format(**tabelas)
        inicio, fim = self._bounds(window)
        inicio_anterior, fim_anterior = self._bounds(window.previous)
        escopo = self._scope()  # type: ignore[attr-defined]
        primeira, resolucao, primeira_ant, resolucao_ant = self._analytics_rows((
            (primeira_sql, (*escopo, inicio, fim, *escopo)),
            (resolucao_sql, (*escopo, inicio, fim)),
            (primeira_sql, (*escopo, inicio_anterior, fim_anterior, *escopo)),
            (resolucao_sql, (*escopo, inicio_anterior, fim_anterior)),
        ))
        resposta = self._first_response(primeira)
        fechamento = self._resolution(resolucao)
        resposta_ant = self._first_response(primeira_ant)
        fechamento_ant = self._resolution(resolucao_ant)
        canais = sorted(CHANNELS) + sorted(
            (set(resposta) | set(fechamento)) - set(CHANNELS) - {None})
        return self._envelope(window, {
            "firstResponse": resposta.get(None) or self._zero_first_response(),
            "resolution": fechamento.get(None) or self._zero_resolution(),
            "previous": {"firstResponse": resposta_ant.get(None) or self._zero_first_response(),
                         "resolution": fechamento_ant.get(None) or self._zero_resolution()},
            "byChannel": [{"channel": canal,
                           "firstResponse": resposta.get(canal) or self._zero_first_response(),
                           "resolution": fechamento.get(canal) or self._zero_resolution()}
                          for canal in canais if canal is not None],
        })

    # ------------------------------------------------------------ saude

    HEALTH_OUTBOX_SQL = """
        SELECT status AS estado, topic AS topico, count(*) AS itens,
               min(created_at) AS mais_antigo,
               max(attempts) AS max_tentativas,
               EXTRACT(EPOCH FROM (now() - min(created_at))) AS idade_segundos,
               count(*) FILTER (WHERE available_at <= now()) AS vencidos
          FROM {outbox}
         WHERE tenant_id = %s AND agent_id = %s AND status <> 'published'
         GROUP BY status, topic
    """
    HEALTH_DEAD_SQL = """
        SELECT topic AS topico, count(*) AS itens,
               count(*) FILTER (WHERE failed_at >= %s AND failed_at < %s) AS na_janela,
               min(failed_at) AS mais_antigo, max(failed_at) AS mais_recente,
               max(attempts) AS max_tentativas
          FROM {dead}
         WHERE tenant_id = %s AND agent_id = %s
         GROUP BY topic
    """
    HEALTH_INBOUND_SQL = """
        SELECT count(*) AS pendentes, min(received_at) AS mais_antigo,
               EXTRACT(EPOCH FROM (now() - min(received_at))) AS idade_segundos
          FROM {inbound}
         WHERE tenant_id = %s AND agent_id = %s AND processed_at IS NULL
    """
    HEALTH_MESSAGES_SQL = """
        SELECT status AS estado, count(*) AS itens
          FROM {messages}
         WHERE tenant_id = %s AND agent_id = %s
           AND occurred_at >= %s AND occurred_at < %s
           AND status IN ('queued', 'failed')
         GROUP BY status
    """

    def analytics_health(self, window: AnalyticsWindow) -> dict[str, Any]:
        """Saude da entrega: fila, DLQ, tentativas e idade do item mais velho.

        Contadores de ``sac_outbox`` e ``sac_dead_letters`` sao estado do
        agora, nao da janela; a janela filtra apenas o que e serie (falhas na
        DLQ e mensagens com falha no periodo). Nada de ``last_error`` ou
        ``payload`` sai daqui: mensagem de erro de driver carrega dado do
        cliente.
        """
        tabelas = {"outbox": self._table("sac_outbox"),  # type: ignore[attr-defined]
                   "dead": self._table("sac_dead_letters"),  # type: ignore[attr-defined]
                   "inbound": self._table("sac_inbound_events"),  # type: ignore[attr-defined]
                   "messages": self._table("sac_messages")}  # type: ignore[attr-defined]
        inicio, fim = self._bounds(window)
        escopo = self._scope()  # type: ignore[attr-defined]
        outbox_rows, dead_rows, inbound_rows, message_rows = self._analytics_rows((
            (self.HEALTH_OUTBOX_SQL.format(**tabelas), escopo),
            (self.HEALTH_DEAD_SQL.format(**tabelas), (inicio, fim, *escopo)),
            (self.HEALTH_INBOUND_SQL.format(**tabelas), escopo),
            (self.HEALTH_MESSAGES_SQL.format(**tabelas), (*escopo, inicio, fim)),
        ))
        reader = self._analytics_read
        por_estado: dict[str, int] = {}
        por_topico: dict[str, dict[str, Any]] = {}
        idade_backlog: Optional[float] = None
        mais_antigo: Optional[str] = None
        vencidos = 0
        max_tentativas = 0
        for row in outbox_rows:
            estado = str(reader(row, "estado", 0))
            topico = str(reader(row, "topico", 1))
            itens = to_int(reader(row, "itens", 2))
            por_estado[estado] = por_estado.get(estado, 0) + itens
            alvo = por_topico.setdefault(topico, {"topic": topico, "backlog": 0, "dead": 0,
                                                  "maxAttempts": 0})
            if estado == "dead":
                alvo["dead"] += itens
            else:
                alvo["backlog"] += itens
            alvo["maxAttempts"] = max(alvo["maxAttempts"], to_int(reader(row, "max_tentativas", 4)))
            if estado in self.OUTBOX_BACKLOG_STATUS:
                vencidos += to_int(reader(row, "vencidos", 6))
                max_tentativas = max(max_tentativas, to_int(reader(row, "max_tentativas", 4)))
                idade = to_seconds(reader(row, "idade_segundos", 5))
                if idade is not None and (idade_backlog is None or idade > idade_backlog):
                    idade_backlog = idade
                criado = iso_instant(reader(row, "mais_antigo", 3))
                if criado and (mais_antigo is None or criado < mais_antigo):
                    mais_antigo = criado
        backlog = sum(por_estado.get(estado, 0) for estado in self.OUTBOX_BACKLOG_STATUS)

        dlq_total = 0
        dlq_janela = 0
        dlq_tentativas = 0
        dlq_primeiro: Optional[str] = None
        dlq_ultimo: Optional[str] = None
        dlq_topicos = []
        for row in dead_rows:
            itens = to_int(reader(row, "itens", 1))
            dlq_total += itens
            dlq_janela += to_int(reader(row, "na_janela", 2))
            dlq_tentativas = max(dlq_tentativas, to_int(reader(row, "max_tentativas", 5)))
            primeiro = iso_instant(reader(row, "mais_antigo", 3))
            ultimo = iso_instant(reader(row, "mais_recente", 4))
            if primeiro and (dlq_primeiro is None or primeiro < dlq_primeiro):
                dlq_primeiro = primeiro
            if ultimo and (dlq_ultimo is None or ultimo > dlq_ultimo):
                dlq_ultimo = ultimo
            dlq_topicos.append({"topic": str(reader(row, "topico", 0)), "items": itens,
                                "maxAttempts": to_int(reader(row, "max_tentativas", 5))})

        pendentes = to_int(reader(inbound_rows[0], "pendentes", 0)) if inbound_rows else 0
        idade_inbound = (to_seconds(reader(inbound_rows[0], "idade_segundos", 2))
                         if inbound_rows else None)
        mensagens = {str(reader(row, "estado", 0)): to_int(reader(row, "itens", 1))
                     for row in message_rows}

        motivos: list[str] = []
        if dlq_total:
            motivos.append("dead_letters")
        if backlog and (idade_backlog or 0) >= self.HEALTH_CRITICAL_SECONDS:
            motivos.append("fila_parada")
        elif backlog:
            motivos.append("fila_com_pendencia")
        if pendentes:
            motivos.append("webhook_nao_processado")
        if mensagens.get("failed"):
            motivos.append("mensagem_com_falha")
        critico = ("dead_letters" in motivos or "fila_parada" in motivos
                   or (idade_inbound or 0) >= self.HEALTH_CRITICAL_SECONDS)
        atencao = bool(motivos) or (idade_backlog or 0) >= self.HEALTH_WARN_SECONDS
        estado_geral = "critico" if critico else ("atencao" if atencao else "ok")

        return self._envelope(window, {
            "status": estado_geral,
            "reasons": motivos,
            "outbox": {"pending": por_estado.get("pending", 0),
                       "retry": por_estado.get("retry", 0),
                       "processing": por_estado.get("processing", 0),
                       "dead": por_estado.get("dead", 0),
                       "backlog": backlog, "due": vencidos,
                       "maxAttempts": max_tentativas,
                       "oldestCreatedAt": mais_antigo,
                       "oldestAgeSeconds": idade_backlog,
                       "byTopic": sorted(por_topico.values(),
                                         key=lambda item: (-item["backlog"], item["topic"]))},
            "deadLetters": {"total": dlq_total, "inWindow": dlq_janela,
                            "maxAttempts": dlq_tentativas,
                            "oldestFailedAt": dlq_primeiro, "newestFailedAt": dlq_ultimo,
                            "byTopic": sorted(dlq_topicos,
                                              key=lambda item: (-item["items"], item["topic"]))},
            "inbound": {"unprocessed": pendentes, "oldestAgeSeconds": idade_inbound},
            "messages": {"queued": mensagens.get("queued", 0),
                         "failed": mensagens.get("failed", 0)},
            "thresholds": {"warnSeconds": self.HEALTH_WARN_SECONDS,
                           "criticalSeconds": self.HEALTH_CRITICAL_SECONDS},
        })

    # ------------------------------------------------------- operadores

    OPERATORS_SQL = """
        SELECT actor_type AS tipo, actor_id AS ator, action AS acao,
               count(*) AS acoes, min(occurred_at) AS primeira, max(occurred_at) AS ultima
          FROM {audit}
         WHERE tenant_id = %s AND agent_id = %s
           AND occurred_at >= %s AND occurred_at < %s
         GROUP BY actor_type, actor_id, action
         ORDER BY count(*) DESC
         LIMIT %s
    """
    OPERATORS_SERIES_SQL = """
        SELECT (occurred_at AT TIME ZONE %s)::date AS dia, count(*) AS acoes
          FROM {audit}
         WHERE tenant_id = %s AND agent_id = %s
           AND occurred_at >= %s AND occurred_at < %s
         GROUP BY 1 ORDER BY 1
    """

    def analytics_operators(self, window: AnalyticsWindow) -> dict[str, Any]:
        """Atividade por operador a partir de ``sac_audit_log``.

        ``actorId`` e o identificador do cadastro de operadores, que por regex
        nunca e e-mail nem telefone. Nenhum ``data`` da trilha e devolvido: o
        antes/depois de uma acao carrega texto de nota e nome de contato.
        """
        tabelas = {"audit": self._table("sac_audit_log")}  # type: ignore[attr-defined]
        inicio, fim = self._bounds(window)
        escopo = self._scope()  # type: ignore[attr-defined]
        linhas, serie_rows = self._analytics_rows((
            (self.OPERATORS_SQL.format(**tabelas),
             (*escopo, inicio, fim, self.ANALYTICS_MAX_GROUPS)),
            (self.OPERATORS_SERIES_SQL.format(**tabelas),
             (window.timezone_name, *escopo, inicio, fim)),
        ))
        reader = self._analytics_read
        operadores: dict[tuple[str, str], dict[str, Any]] = {}
        acoes: dict[str, int] = {}
        total = 0
        for row in linhas:
            tipo = str(reader(row, "tipo", 0) or "")
            ator = reader(row, "ator", 1)
            ator = "" if ator is None else str(ator)
            acao = str(reader(row, "acao", 2))
            quantidade = to_int(reader(row, "acoes", 3))
            total += quantidade
            acoes[acao] = acoes.get(acao, 0) + quantidade
            entrada = operadores.setdefault((tipo, ator), {
                "actorType": tipo, "actorId": ator or None, "actions": 0,
                "byAction": {}, "firstActionAt": None, "lastActionAt": None})
            entrada["actions"] += quantidade
            entrada["byAction"][acao] = entrada["byAction"].get(acao, 0) + quantidade
            primeira = iso_instant(reader(row, "primeira", 4))
            ultima = iso_instant(reader(row, "ultima", 5))
            if primeira and (entrada["firstActionAt"] is None
                             or primeira < entrada["firstActionAt"]):
                entrada["firstActionAt"] = primeira
            if ultima and (entrada["lastActionAt"] is None or ultima > entrada["lastActionAt"]):
                entrada["lastActionAt"] = ultima
        listados = sorted(operadores.values(),
                          key=lambda item: (-item["actions"], str(item["actorId"] or "")))
        recortados = listados[:self.ANALYTICS_TOP_OPERATORS]
        for item in recortados:
            item["byAction"] = sorted(
                ({"action": acao, "count": quantidade}
                 for acao, quantidade in item["byAction"].items()),
                key=lambda entrada: (-entrada["count"], entrada["action"]))
            item["share"] = percentage(item["actions"], total)
        serie = {_day_key(reader(row, "dia", 0)): {"actions": to_int(reader(row, "acoes", 1))}
                 for row in serie_rows}
        return self._envelope(window, {
            "operators": recortados,
            "actions": sorted(({"action": acao, "count": quantidade}
                               for acao, quantidade in acoes.items()),
                              key=lambda item: (-item["count"], item["action"])),
            "totals": {"actions": total, "operators": len(operadores)},
            "series": self._dense(window, serie, {"actions": 0}),
            "truncated": len(linhas) >= self.ANALYTICS_MAX_GROUPS,
        })


ANALYTICS_REPORTS: dict[str, str] = {
    "overview": "analytics_overview",
    "channels": "analytics_channels",
    "origins": "analytics_origins",
    "pipeline": "analytics_pipeline",
    "response-times": "analytics_response_times",
    "health": "analytics_health",
    "operators": "analytics_operators",
}
