#!/bin/sh
set -eu
if [ "$#" -ne 2 ]; then
  echo "uso: $0 CAMINHO_BANCO DIRETORIO_BACKUP" >&2
  exit 2
fi
db=$1
destination=$2
if [ ! -f "$db" ] || [ ! -d "$destination" ]; then
  echo "banco ou diretorio de destino inexistente" >&2
  exit 2
fi
stamp=$(date -u +%Y%m%dT%H%M%SZ)
target="$destination/multicanal-$stamp.sqlite3"
python3 - "$db" "$target" <<'PY'
import sqlite3, sys
source = sqlite3.connect(sys.argv[1])
target = sqlite3.connect(sys.argv[2])
with target:
    source.backup(target)
target.close()
source.close()
PY
chmod 600 "$target"
echo "$target"
