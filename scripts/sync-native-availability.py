#!/usr/bin/env python3
"""Publica no SAC um espelho somente leitura do horário nativo do bot.

O script nunca escreve na fonte operacional. Dr. Lucas é lido de
/opt/data/agenda_config.json dentro do container; Gramado consulta a API real
através do reservas_tools.py que a Gabi já usa. O cursor é o SHA-256 do
snapshot normalizado, tornando os passes periódicos idempotentes.
"""

import argparse
import datetime as dt
import hashlib
import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

DAYS = ("segunda", "terca", "quarta", "quinta", "sexta", "sabado", "domingo")
TZ_BR = dt.timezone(dt.timedelta(hours=-3))


def run_json(command):
    result = subprocess.run(command, capture_output=True, text=True, timeout=45, check=False)
    if result.returncode != 0:
        raise RuntimeError(f"comando falhou ({result.returncode}): {result.stderr.strip()[:300]}")
    return json.loads(result.stdout)


def drlucas_snapshot():
    raw = run_json(["docker", "exec", "hermes2_drlucas", "cat", "/opt/data/agenda_config.json"])
    hours = raw.get("hours")
    if not isinstance(hours, dict):
        raise ValueError("agenda_config.json sem hours")
    schedule = {day: None for day in DAYS}
    # agenda_config usa 0=domingo, 1=segunda, ..., 6=sábado.
    for source_day, target_day in enumerate(("domingo", *DAYS[:-1])):
        ranges = hours.get(str(source_day), [])
        if not ranges:
            schedule[target_day] = None
            continue
        if len(ranges) != 1 or len(ranges[0]) != 2:
            raise ValueError(f"{target_day} tem múltiplas faixas; o formato do SAC ainda não as representa")
        schedule[target_day] = {"inicio": str(ranges[0][0]), "fim": str(ranges[0][1])}
    schedule["timezone"] = str(raw.get("timezone") or "-03:00")
    schedule["duracaoSlotMinutos"] = int(raw.get("slot_minutes"))
    return schedule, "bot_file"


def gramado_snapshot():
    schedule = {day: None for day in DAYS}
    today = dt.datetime.now(TZ_BR).date()
    for offset in range(7):
        date = today + dt.timedelta(days=offset)
        out = run_json([
            "docker", "exec", "hermes_gramadoplazza",
            "/opt/hermes/.venv/bin/python3", "/opt/data/reservas_tools.py",
            "slots", "--data", date.isoformat(), "--pessoas", "2",
        ])
        if out.get("status") != 200:
            raise RuntimeError(f"API de reservas respondeu status {out.get('status')} em {date.isoformat()}")
        grade = out.get("grade")
        if not isinstance(grade, dict):
            raise ValueError(f"API de reservas não devolveu grade em {date.isoformat()}")
        start, end = grade.get("horarioInicio"), grade.get("horarioFim")
        interval = int(grade.get("intervaloSlotMin"))
        day = DAYS[date.weekday()]
        schedule[day] = {"inicio": str(start), "fim": str(end)}
        previous_interval = schedule.get("duracaoSlotMinutos")
        if previous_interval is not None and previous_interval != interval:
            raise ValueError("API devolveu duração de slot diferente entre os dias da semana")
        schedule["duracaoSlotMinutos"] = interval
    schedule["timezone"] = "America/Sao_Paulo"
    return schedule, "reservations_api"


def read_token(path):
    token = (os.environ.get("HERMES_WEBHOOK_SECRET") or "").strip()
    if token:
        return token
    with open(path, encoding="utf-8") as handle:
        token = handle.read().strip()
    if not token:
        raise ValueError("arquivo de token vazio")
    return token


def publish(base_url, slug, token, schedule, source):
    canonical = json.dumps(schedule, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    cursor = "sha256:" + hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    body = json.dumps({
        "schedule": schedule,
        "source": source,
        "cursor": cursor,
        "capturedAt": dt.datetime.now(dt.timezone.utc).isoformat().replace("+00:00", "Z"),
    }, ensure_ascii=False).encode("utf-8")
    url = base_url.rstrip("/") + f"/api/webhooks/hermes/{slug}/availability"
    request = urllib.request.Request(url, data=body, method="POST", headers={
        "Content-Type": "application/json",
        "x-webhook-token": token,
    })
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            result = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        response_body = error.read().decode("utf-8", errors="replace")[:500]
        raise RuntimeError(f"SAC respondeu HTTP {error.code}: {response_body}") from error
    if not result.get("ok"):
        raise RuntimeError(f"SAC recusou o snapshot: {result}")
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("source", choices=("drlucas", "gramado-plaza"))
    parser.add_argument("--sac-url", default=os.environ.get("SAC_BASE_URL", "https://sac.casaldotrafego.com"))
    parser.add_argument("--token-file", required=True)
    parser.add_argument("--print-only", action="store_true")
    args = parser.parse_args()

    schedule, source = drlucas_snapshot() if args.source == "drlucas" else gramado_snapshot()
    if args.print_only:
        print(json.dumps(schedule, ensure_ascii=False, sort_keys=True))
        return 0
    result = publish(args.sac_url, args.source, read_token(args.token_file), schedule, source)
    print(json.dumps({"ok": True, "source": args.source, "cursor": result.get("cursor"),
                      "syncedAt": result.get("syncedAt")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"ERRO: {type(exc).__name__}: {exc}", file=sys.stderr)
        raise SystemExit(1)
