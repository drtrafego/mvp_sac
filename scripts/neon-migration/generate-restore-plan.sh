#!/usr/bin/env bash

# Gera comandos revisáveis. Não chama pg_dump nem pg_restore.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

OUT_DIR="${1:-artifacts/neon-migration/restore-plan}"
require_commands python3 mkdir
require_database_urls
assert_direct_neon_target
mkdir -p "$OUT_DIR"

cat >"$OUT_DIR/restore-plan.sh" <<'PLAN'
#!/usr/bin/env bash
# Revisar este arquivo e executar manualmente numa janela de manutenção aprovada.
# Este arquivo nunca é chamado pelo gerador.
set -euo pipefail

: "${AGENTS_SOURCE_DATABASE_URL:?Defina a fonte operacional no ambiente.}"
: "${AGENTS_TARGET_DATABASE_URL:?Defina o Neon direto no ambiente.}"
DUMP_FILE="${1:?Informe um caminho novo e vazio para o dump como primeiro argumento.}"

# 1. Criar o dump consistente da fonte.
pg_dump "$AGENTS_SOURCE_DATABASE_URL" --format=custom --no-owner --no-privileges --file "$DUMP_FILE"

# 2. Validar o arquivo antes de tocar no destino.
pg_restore --list "$DUMP_FILE" >/dev/null

# 3. Restaurar em banco/branch Neon vazio e aprovado. Sem --clean ou --create.
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$AGENTS_TARGET_DATABASE_URL" "$DUMP_FILE"

# 4. Rodar inventory-compare.sh e guardar todos os artefatos antes do cutover.
PLAN

cat >"$OUT_DIR/VALIDATION.md" <<'PLAN'
# Checklist de dump e restore

O gerador não conecta, não cria dump e não restaura dados. A execução manual exige:

1. `AGENTS_TARGET_DATABASE_URL` com host Neon direto, sem `-pooler`.
2. Branch ou banco Neon vazio, criado e identificado antes da janela.
3. Backup do Supabase e artefato do `inventory-compare.sh` arquivados.
4. Revisão humana de `restore-plan.sh`; ele não usa `--clean` nem `--create`.
5. `pg_restore --list` aprovado antes do restore.
6. Comparação de schema, contagens e máximos compatível depois do restore.
7. Somente depois, seguir `docs/neon-agents-dual-write-cutover.md`.
PLAN

chmod 700 "$OUT_DIR/restore-plan.sh"
printf 'Plano gerado em %s. Nenhum dump ou restore foi executado.\n' "$OUT_DIR"
