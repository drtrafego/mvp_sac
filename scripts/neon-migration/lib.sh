#!/usr/bin/env bash

set -euo pipefail

readonly SOURCE_ENV=AGENTS_SOURCE_DATABASE_URL
readonly TARGET_ENV=AGENTS_TARGET_DATABASE_URL

require_database_urls() {
  : "${AGENTS_SOURCE_DATABASE_URL:?Defina AGENTS_SOURCE_DATABASE_URL no ambiente.}"
  : "${AGENTS_TARGET_DATABASE_URL:?Defina AGENTS_TARGET_DATABASE_URL no ambiente.}"
}

require_commands() {
  local command
  for command in "$@"; do
    command -v "$command" >/dev/null 2>&1 || {
      printf 'Comando obrigatório ausente: %s\n' "$command" >&2
      exit 1
    }
  done
}

readonly_psql() {
  local database_url="$1"
  shift
  PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' \
    psql "$database_url" -X -v ON_ERROR_STOP=1 "$@"
}

database_host() {
  python3 - "$1" <<'PY'
from sys import argv
from urllib.parse import urlparse

parsed = urlparse(argv[1])
if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname:
    raise SystemExit("URL PostgreSQL inválida")
print(parsed.hostname)
PY
}

assert_direct_neon_target() {
  local host
  host="$(database_host "$AGENTS_TARGET_DATABASE_URL")"
  case "$host" in
    *.neon.tech) ;;
    *) printf 'AGENTS_TARGET_DATABASE_URL deve apontar para um host Neon direto.\n' >&2; exit 1 ;;
  esac
  case "$host" in
    *-pooler.*)
      printf 'AGENTS_TARGET_DATABASE_URL aponta para pooler. Use a conexão direta do Neon para dump/restore.\n' >&2
      exit 1
      ;;
  esac
}
