#!/usr/bin/env bash

# Gera comandos revisáveis. Não chama pg_dump, pg_restore ou psql.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

OUT_DIR="${1:-artifacts/neon-migration/restore-plan}"
umask 077
require_commands python3 mkdir cp
prepare_connections
assert_direct_neon_target
cleanup_connections
mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
mkdir -p "$OUT_DIR/approved-dumps"
chmod 700 "$OUT_DIR/approved-dumps"
cp "$SCRIPT_DIR/prepare-libpq.py" "$OUT_DIR/prepare-libpq.py"
chmod 700 "$OUT_DIR/prepare-libpq.py"

cat >"$OUT_DIR/restore-plan.sh" <<'PLAN'
#!/usr/bin/env bash
# Execute somente numa janela de manutenção aprovada.
set -euo pipefail

if [ "${1:-}" != '--execute-approved' ]; then
  printf 'Recusado: use --execute-approved <caminho-do-dump> depois da revisão humana.\n' >&2
  exit 64
fi
DUMP_BASENAME="${2:?Informe um nome novo para o dump.}"
[ "$#" -eq 2 ] || { printf 'Uso: %s --execute-approved <caminho-do-dump>\n' "$0" >&2; exit 64; }
: "${AGENTS_SOURCE_DATABASE_URL:?Defina a fonte operacional no ambiente.}"
: "${AGENTS_TARGET_DATABASE_URL:?Defina o Neon direto no ambiente.}"

PLAN_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
APPROVED_DUMP_DIR="$PLAN_DIR/approved-dumps"
case "$DUMP_BASENAME" in ''|.|..|*/*) printf 'Recusado: informe somente basename seguro para o dump.\n' >&2; exit 64;; esac
DUMP_FILE="$APPROVED_DUMP_DIR/$DUMP_BASENAME"
[ -d "$APPROVED_DUMP_DIR" ] || { printf 'Diretório aprovado ausente.\n' >&2; exit 64; }
[ ! -e "$DUMP_FILE" ] || { printf 'Recusado: DUMP_FILE já existe.\n' >&2; exit 64; }
umask 077
( set -o noclobber; : > "$DUMP_FILE" ) || { printf 'Recusado: não foi possível criar DUMP_FILE exclusivamente.\n' >&2; exit 64; }
DUMP_CREATED=true
trap 'rm -rf -- "$CONNECTION_DIR"; if [ "${DUMP_CREATED:-false}" = true ]; then rm -f -- "$DUMP_FILE"; fi' EXIT
umask 077
CONNECTION_DIR="$(mktemp -d)"
chmod 700 "$CONNECTION_DIR"
trap 'rm -rf -- "$CONNECTION_DIR"; if [ "${DUMP_CREATED:-false}" = true ]; then rm -f -- "$DUMP_FILE"; fi' EXIT
declare -A HOST PORT DATABASE USER SSLMODE CHANNELBINDING PGPASS

prepare_connection() {
  local role="$1" url="$2" fields
  fields="$(env -u AGENTS_SOURCE_DATABASE_URL -u AGENTS_TARGET_DATABASE_URL \
    python3 "$PLAN_DIR/prepare-libpq.py" "$CONNECTION_DIR/$role" <<<"$url")"
  IFS=$'\t' read -r "HOST[$role]" "PORT[$role]" "DATABASE[$role]" "USER[$role]" "SSLMODE[$role]" "CHANNELBINDING[$role]" <<<"$fields"
  PGPASS[$role]="$CONNECTION_DIR/$role.pgpass"
}

run_connection() {
  local role="$1"
  shift
  env -u AGENTS_SOURCE_DATABASE_URL -u AGENTS_TARGET_DATABASE_URL \
    PGPASSFILE="${PGPASS[$role]}" PGHOST="${HOST[$role]}" PGPORT="${PORT[$role]}" \
    PGDATABASE="${DATABASE[$role]}" PGUSER="${USER[$role]}" PGSSLMODE="${SSLMODE[$role]}" \
    PGCHANNELBINDING="${CHANNELBINDING[$role]}" "$@"
}

prepare_connection source "$AGENTS_SOURCE_DATABASE_URL"
prepare_connection target "$AGENTS_TARGET_DATABASE_URL"
unset AGENTS_SOURCE_DATABASE_URL AGENTS_TARGET_DATABASE_URL

case "${HOST[target]}" in
  *.neon.tech) ;;
  *) printf 'Recusado: o destino não é Neon.\n' >&2; exit 65 ;;
esac
case "${HOST[target]}" in
  *-pooler.*) printf 'Recusado: destino Neon precisa da conexão direta, sem pooler.\n' >&2; exit 65 ;;
esac
case "${SSLMODE[target]}" in
  require|verify-ca|verify-full) ;;
  *) printf 'Recusado: destino Neon exige sslmode=require ou verify-*.\n' >&2; exit 65 ;;
esac

# Gate read-only: o destino deve não ter tabelas de usuário antes do restore.
TARGET_EMPTY="$(run_connection target env PGOPTIONS='-c default_transaction_read_only=on -c statement_timeout=30000' \
  psql -X -At -v ON_ERROR_STOP=1 -c "
    SELECT NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relkind IN ('r', 'p')
        AND n.nspname !~ '^pg_'
        AND n.nspname <> 'information_schema'
    );")"
[ "$TARGET_EMPTY" = t ] || { printf 'Recusado: destino Neon não está vazio.\n' >&2; exit 66; }

# A URL não é passada em argv nem herdada pelos processos abaixo.
run_connection source pg_dump --format=custom --no-owner --no-privileges --file "$DUMP_FILE"
pg_restore --list "$DUMP_FILE" >/dev/null
run_connection target pg_restore --exit-on-error --no-owner --no-privileges --dbname="${DATABASE[target]}" "$DUMP_FILE"
DUMP_CREATED=false

printf 'Restore concluído. Execute inventory-compare.sh antes de qualquer cutover.\n'
PLAN

cat >"$OUT_DIR/VALIDATION.md" <<'PLAN'
# Checklist de dump e restore

O gerador não conecta, não cria dump e não restaura dados. O plano gerado:

1. Só executa com `--execute-approved`.
2. Revalida host Neon direto durante a execução e recusa `-pooler`.
3. Converte as URLs recebidas no ambiente em `PGPASSFILE` local com permissão 600, preserva apenas `sslmode` e `channel_binding`, remove as URLs antes de iniciar `psql`, `pg_dump` e `pg_restore` e nunca as passa em argv.
4. Confirma por consulta read-only que o banco alvo não contém tabelas de usuário fora de todos os schemas `pg_*` e `information_schema`.
5. Aceita somente basename seguro para um `DUMP_FILE` novo dentro de `approved-dumps`, criando-o com noclobber.
6. Não usa `--clean` nem `--create`.
7. Exige inventário compatível depois do restore e antes do contrato de cutover.
PLAN

chmod 700 "$OUT_DIR/restore-plan.sh"
printf 'Plano gerado em %s. Nenhum dump ou restore foi executado.\n' "$OUT_DIR"
