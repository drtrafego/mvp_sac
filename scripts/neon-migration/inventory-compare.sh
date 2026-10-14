#!/usr/bin/env bash

# Coleta somente leitura. Não contém URL, senha ou dados de linhas no resultado.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

OUT_DIR="${1:-artifacts/neon-migration/inventory-$(date -u +%Y%m%dT%H%M%SZ)}"
require_commands psql pg_dump diff sort mkdir mktemp
require_database_urls
mkdir -p "$OUT_DIR/source" "$OUT_DIR/target"

collect_inventory() {
  local role="$1"
  local database_url="$2"
  local role_dir="$OUT_DIR/$role"
  local tables_file="$role_dir/tables.tsv"
  local maxima_file="$role_dir/maxima.tsv"

  readonly_psql "$database_url" -AtF $'\t' -c "
    SELECT n.nspname, c.relname, c.reltuples::bigint
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p')
      AND n.nspname NOT IN ('pg_catalog', 'information_schema')
    ORDER BY n.nspname, c.relname;
  " >"$tables_file"

  : >"$role_dir/counts.tsv"
  : >"$maxima_file"
  while IFS=$'\t' read -r schema table _estimate; do
    local relation
    relation="$(readonly_psql "$database_url" -At -c "SELECT format('%I.%I', '$schema', '$table')")"
    printf '%s\t%s\t%s\n' "$schema" "$table" "$(readonly_psql "$database_url" -At -c "SELECT count(*) FROM $relation")" >>"$role_dir/counts.tsv"

    readonly_psql "$database_url" -AtF $'\t' -c "
      SELECT quote_ident(a.attname)
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_type t ON t.oid = a.atttypid
      WHERE n.nspname = '$schema' AND c.relname = '$table'
        AND a.attnum > 0 AND NOT a.attisdropped
        AND (a.attname IN ('id', 'created_at', 'updated_at', 'occurred_at', 'received_at', 'event_at')
             OR t.typcategory IN ('N', 'D'))
      ORDER BY a.attnum;
    " | while IFS= read -r column; do
      printf '%s\t%s\t%s\t%s\n' "$schema" "$table" "$column" \
        "$(readonly_psql "$database_url" -At -c "SELECT coalesce(max($column)::text, '') FROM $relation")" >>"$maxima_file"
    done
  done <"$tables_file"

  pg_dump "$database_url" --schema-only --no-owner --no-privileges --quote-all-identifiers \
    | sed '/^-- Dumped from database version/d;/^-- Dumped by pg_dump version/d;/^\\\\restrict /d;/^\\\\unrestrict /d' \
    >"$role_dir/schema.sql"
}

collect_inventory source "$AGENTS_SOURCE_DATABASE_URL"
collect_inventory target "$AGENTS_TARGET_DATABASE_URL"

for file in tables.tsv counts.tsv maxima.tsv schema.sql; do
  diff -u "$OUT_DIR/source/$file" "$OUT_DIR/target/$file" >"$OUT_DIR/$file.diff" || true
done

if [ -s "$OUT_DIR/tables.tsv.diff" ] || [ -s "$OUT_DIR/counts.tsv.diff" ] || [ -s "$OUT_DIR/maxima.tsv.diff" ] || [ -s "$OUT_DIR/schema.sql.diff" ]; then
  printf 'DIVERGENTE\n' >"$OUT_DIR/RESULT"
  printf 'Inventário concluído: DIVERGENTE. Artefatos em %s\n' "$OUT_DIR"
  exit 2
fi

printf 'COMPATÍVEL\n' >"$OUT_DIR/RESULT"
printf 'Inventário concluído: COMPATÍVEL. Artefatos em %s\n' "$OUT_DIR"
