#!/bin/sh
set -eu

SOURCE_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../painel" && pwd)
PANEL_WEB=${PANEL_WEB:-/opt/gastaomatos/luana/painel_os/web}

for parent in "$PANEL_WEB/public" "$PANEL_WEB/dist"; do
  target="$parent/sac"
  if [ -L "$target" ] && [ "$(readlink -f "$target")" = "$SOURCE_DIR" ]; then
    continue
  fi
  if [ -e "$target" ] || [ -L "$target" ]; then
    echo "recusado: $target ja existe e nao aponta para $SOURCE_DIR" >&2
    exit 1
  fi
  ln -s "$SOURCE_DIR" "$target"
done

echo "painel publicado em /sac/ sem reiniciar o frontend principal"
