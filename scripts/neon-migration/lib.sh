#!/usr/bin/env bash

set -euo pipefail

readonly SOURCE_ENV=AGENTS_SOURCE_DATABASE_URL
readonly TARGET_ENV=AGENTS_TARGET_DATABASE_URL
CONNECTION_DIR=''
declare -A CONNECTION_HOST CONNECTION_PORT CONNECTION_DATABASE CONNECTION_USER CONNECTION_SSLMODE CONNECTION_CHANNELBINDING CONNECTION_PGPASS

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

prepare_connections() {
  require_database_urls
  CONNECTION_DIR="$(mktemp -d)"
  chmod 700 "$CONNECTION_DIR"
  local role url fields
  for role in source target; do
    if [ "$role" = source ]; then url="$AGENTS_SOURCE_DATABASE_URL"; else url="$AGENTS_TARGET_DATABASE_URL"; fi
    fields="$(env -u AGENTS_SOURCE_DATABASE_URL -u AGENTS_TARGET_DATABASE_URL \
      python3 "$SCRIPT_DIR/prepare-libpq.py" "$CONNECTION_DIR/$role" <<<"$url")"
    IFS=$'\t' read -r "CONNECTION_HOST[$role]" "CONNECTION_PORT[$role]" "CONNECTION_DATABASE[$role]" "CONNECTION_USER[$role]" "CONNECTION_SSLMODE[$role]" "CONNECTION_CHANNELBINDING[$role]" <<<"$fields"
    CONNECTION_PGPASS[$role]="$CONNECTION_DIR/$role.pgpass"
  done
  unset AGENTS_SOURCE_DATABASE_URL AGENTS_TARGET_DATABASE_URL
}

cleanup_connections() {
  [ -n "$CONNECTION_DIR" ] && rm -rf -- "$CONNECTION_DIR"
}

with_connection() {
  local role="$1"
  shift
  env -u AGENTS_SOURCE_DATABASE_URL -u AGENTS_TARGET_DATABASE_URL \
    PGPASSFILE="${CONNECTION_PGPASS[$role]}" \
    PGHOST="${CONNECTION_HOST[$role]}" PGPORT="${CONNECTION_PORT[$role]}" \
    PGDATABASE="${CONNECTION_DATABASE[$role]}" PGUSER="${CONNECTION_USER[$role]}" \
    PGSSLMODE="${CONNECTION_SSLMODE[$role]}" PGCHANNELBINDING="${CONNECTION_CHANNELBINDING[$role]}" "$@"
}

readonly_psql() {
  local role="$1"
  shift
  with_connection "$role" env PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' \
    psql -X -v ON_ERROR_STOP=1 "$@"
}

assert_direct_neon_target() {
  local host="${CONNECTION_HOST[target]}"
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
