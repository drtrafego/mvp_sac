#!/usr/bin/env bash

set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

export AGENTS_SOURCE_DATABASE_URL='postgresql://source.example.invalid/agents'
export AGENTS_TARGET_DATABASE_URL='postgresql://ep-test-123.sa-east-1.aws.neon.tech/agents?sslmode=require'

"$SCRIPT_DIR/generate-restore-plan.sh" "$TMP_DIR/plan" >/dev/null
test -x "$TMP_DIR/plan/restore-plan.sh"
grep -Fq 'pg_dump "$AGENTS_SOURCE_DATABASE_URL"' "$TMP_DIR/plan/restore-plan.sh"
grep -Fq -- '--dbname="$AGENTS_TARGET_DATABASE_URL"' "$TMP_DIR/plan/restore-plan.sh"
grep -Fq 'DUMP_FILE="${1:?' "$TMP_DIR/plan/restore-plan.sh"
grep -Fq -- 'pg_restore --clean' "$TMP_DIR/plan/restore-plan.sh" && exit 1 || true

export AGENTS_TARGET_DATABASE_URL='postgresql://target-pooler.example.neon.tech/agents?sslmode=require'
if "$SCRIPT_DIR/generate-restore-plan.sh" "$TMP_DIR/pooler" >/dev/null 2>&1; then
  printf 'O pooler deveria ser rejeitado.\n' >&2
  exit 1
fi

printf 'OK: plano gera somente comandos e rejeita host pooler.\n'
