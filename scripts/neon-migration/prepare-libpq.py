#!/usr/bin/env python3
"""Converte uma URL recebida por stdin em credenciais libpq locais, sem imprimi-la."""

import os
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

if len(sys.argv) != 2:
    raise SystemExit("Uso: prepare-libpq.py <prefixo-arquivo>")

parsed = urlparse(sys.stdin.read().strip())
if parsed.scheme not in {"postgres", "postgresql"} or not parsed.hostname or not parsed.path:
    raise SystemExit("URL PostgreSQL inválida")

database = unquote(parsed.path.lstrip("/"))
user = unquote(parsed.username or "")
password = unquote(parsed.password or "")
if not database or not user or not password:
    raise SystemExit("URL PostgreSQL precisa de banco, usuário e senha")

port = str(parsed.port or 5432)
options = parse_qs(parsed.query, keep_blank_values=True)
allowed_options = {"sslmode", "channel_binding"}
unsupported = set(options) - allowed_options
if unsupported:
    raise SystemExit("Opções libpq não permitidas: " + ", ".join(sorted(unsupported)))
sslmode = options.get("sslmode", ["require"])[0]
channel_binding = options.get("channel_binding", ["prefer"])[0]
if sslmode not in {"disable", "allow", "prefer", "require", "verify-ca", "verify-full"}:
    raise SystemExit("sslmode inválido")
if channel_binding not in {"disable", "prefer", "require"}:
    raise SystemExit("channel_binding inválido")
prefix = Path(sys.argv[1])
pgpass = prefix.with_suffix(".pgpass")
pgpass.write_text(":".join(value.replace("\\", "\\\\").replace(":", "\\:") for value in (parsed.hostname, port, database, user, password)) + "\n")
os.chmod(pgpass, 0o600)
print("\t".join((parsed.hostname, port, database, user, sslmode, channel_binding)))
