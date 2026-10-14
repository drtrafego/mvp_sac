#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export AGENTS_SOURCE_DATABASE_URL='postgresql://source_user:source_password@source.example.invalid/agents'
export AGENTS_TARGET_DATABASE_URL='postgresql://target_user:target_password@ep-test-123.sa-east-1.aws.neon.tech/agents?sslmode=require&channel_binding=require'

"$SCRIPT_DIR/generate-restore-plan.sh" "$TMP_DIR/plan" >/dev/null
test -x "$TMP_DIR/plan/restore-plan.sh"
test -x "$TMP_DIR/plan/prepare-libpq.py"
grep -Fq -- '--execute-approved' "$TMP_DIR/plan/restore-plan.sh"
grep -Fq 'PGPASSFILE=' "$TMP_DIR/plan/restore-plan.sh"
grep -Fq 'PGCHANNELBINDING=' "$TMP_DIR/plan/restore-plan.sh"
grep -Fq 'destino Neon não está vazio' "$TMP_DIR/plan/restore-plan.sh"
grep -Fq "n.nspname !~ '^pg_'" "$TMP_DIR/plan/restore-plan.sh"
grep -Fq 'pg_dump "$AGENTS_SOURCE_DATABASE_URL"' "$TMP_DIR/plan/restore-plan.sh" && exit 1 || true
grep -Fq 'pg_restore --clean' "$TMP_DIR/plan/restore-plan.sh" && exit 1 || true

if "$TMP_DIR/plan/restore-plan.sh" >/dev/null 2>&1; then
  printf 'O plano deveria exigir --execute-approved.\n' >&2
  exit 1
fi

FAKE_BIN="$TMP_DIR/bin"
mkdir "$FAKE_BIN"
cat >"$FAKE_BIN/psql" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${AGENTS_SOURCE_DATABASE_URL:-}" ] && [ -z "${AGENTS_TARGET_DATABASE_URL:-}" ]
if [ "${1:-}" != --list ]; then
  case "${PGHOST:-}" in ep-test-*) [ "${PGCHANNELBINDING:-}" = require ] ;; *) [ "${PGCHANNELBINDING:-}" = prefer ] ;; esac
fi
printf '%s\n' "psql:$*" >>"$TRACE_FILE"
printf '%s\n' "${FAKE_TARGET_EMPTY:-t}"
SH
cat >"$FAKE_BIN/pg_dump" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${AGENTS_SOURCE_DATABASE_URL:-}" ] && [ -z "${AGENTS_TARGET_DATABASE_URL:-}" ]
case "${PGHOST:-}" in ep-test-*) [ "${PGCHANNELBINDING:-}" = require ] ;; *) [ "${PGCHANNELBINDING:-}" = prefer ] ;; esac
printf '%s\n' "pg_dump:$*" >>"$TRACE_FILE"
while [ "$#" -gt 0 ]; do
  if [ "$1" = --file ]; then touch "$2"; exit 0; fi
  shift
done
exit 1
SH
cat >"$FAKE_BIN/pg_restore" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
[ -z "${AGENTS_SOURCE_DATABASE_URL:-}" ] && [ -z "${AGENTS_TARGET_DATABASE_URL:-}" ]
if [ "${1:-}" != --list ]; then
  case "${PGHOST:-}" in ep-test-*) [ "${PGCHANNELBINDING:-}" = require ] ;; *) [ "${PGCHANNELBINDING:-}" = prefer ] ;; esac
fi
printf '%s\n' "pg_restore:$*" >>"$TRACE_FILE"
exit 0
SH
chmod 700 "$FAKE_BIN"/*

export PATH="$FAKE_BIN:$PATH" TRACE_FILE="$TMP_DIR/trace"
export FAKE_TARGET_EMPTY=f
if "$TMP_DIR/plan/restore-plan.sh" --execute-approved blocked.dump >/dev/null 2>&1; then
  printf 'O destino não vazio deveria bloquear o restore.\n' >&2
  exit 1
fi
grep -Fq 'pg_dump:' "$TRACE_FILE" && { printf 'Dump não deveria iniciar antes do gate vazio.\n' >&2; exit 1; } || true

: >"$TRACE_FILE"
export FAKE_TARGET_EMPTY=t
"$TMP_DIR/plan/restore-plan.sh" --execute-approved approved.dump >/dev/null
grep -Fq 'pg_dump:' "$TRACE_FILE"
grep -Fq 'pg_restore:' "$TRACE_FILE"
grep -Fq 'postgresql://' "$TRACE_FILE" && { printf 'DSN apareceu no argv.\n' >&2; exit 1; } || true

touch "$TMP_DIR/plan/approved-dumps/existing.dump"
if "$TMP_DIR/plan/restore-plan.sh" --execute-approved existing.dump >/dev/null 2>&1; then
  printf 'DUMP_FILE existente deveria ser recusado.\n' >&2
  exit 1
fi

if "$TMP_DIR/plan/restore-plan.sh" --execute-approved ../escape.dump >/dev/null 2>&1; then
  printf 'Basename com ../ deveria ser recusado.\n' >&2
  exit 1
fi

export AGENTS_TARGET_DATABASE_URL='postgresql://target:password@target-pooler.example.neon.tech/agents?sslmode=require'
CONNECTION_TMP="$TMP_DIR/connection-tmp"
mkdir "$CONNECTION_TMP"
export TMPDIR="$CONNECTION_TMP"
if "$SCRIPT_DIR/generate-restore-plan.sh" "$TMP_DIR/pooler" >/dev/null 2>&1; then
  printf 'O pooler deveria ser rejeitado.\n' >&2
  exit 1
fi
[ -z "$(find "$CONNECTION_TMP" -mindepth 1 -print -quit)" ] || { printf 'Pooler deixou PGPASSFILE temporário.\n' >&2; exit 1; }

export AGENTS_TARGET_DATABASE_URL='postgresql://target:password@ep-test-123.sa-east-1.aws.neon.tech/agents?sslmode=prefer'
if "$SCRIPT_DIR/generate-restore-plan.sh" "$TMP_DIR/insecure-tls" >/dev/null 2>&1; then
  printf 'sslmode inseguro deveria ser rejeitado.\n' >&2
  exit 1
fi
[ -z "$(find "$CONNECTION_TMP" -mindepth 1 -print -quit)" ] || { printf 'TLS inseguro deixou PGPASSFILE temporário.\n' >&2; exit 1; }
unset TMPDIR

printf 'OK: plano exige aprovação, confirma alvo vazio e isola DSNs dos filhos.\n'
