#!/usr/bin/env python3
"""Sonda HTTP minima usada pelo HEALTHCHECK dos containers.

Motivo de existir: a imagem oficial ``python:slim`` nao traz bytecode
pre-compilado e os containers rodam com ``read_only`` mais
``PYTHONDONTWRITEBYTECODE``, entao nenhum ``.pyc`` chega a ser gravado em
tempo de execucao. Nessas condicoes ``import urllib.request`` recompila ~84
modulos da stdlib a partir do fonte a cada processo novo -- custo que o
healthcheck pagava a cada intervalo, para sempre.

Esta sonda importa apenas ``socket`` e mantem exatamente o mesmo criterio do
comando que substituiu: codigo de saida 0 somente quando a resposta e 200.
Qualquer outro status, recusa de conexao ou timeout resulta em saida 1.
"""
from __future__ import annotations

import socket
import sys

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PATH = "/readyz"
DEFAULT_TIMEOUT = 10.0


def probe(host: str, port: int, path: str = DEFAULT_PATH,
          timeout: float = DEFAULT_TIMEOUT) -> int:
    """Faz um GET e devolve 0 apenas para 200. Nao le o corpo alem do status."""
    request = (f"GET {path} HTTP/1.1\r\n"
               f"Host: {host}\r\n"
               f"Connection: close\r\n\r\n").encode("ascii")
    with socket.create_connection((host, port), timeout) as sock:
        sock.settimeout(timeout)
        sock.sendall(request)
        with sock.makefile("rb") as stream:
            status_line = stream.readline(256)
    return 0 if status_line.split()[1:2] == [b"200"] else 1


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if not args:
        print("uso: readyz_probe.py <porta> [caminho] [timeout]", file=sys.stderr)
        return 2
    try:
        port = int(args[0])
        path = args[1] if len(args) > 1 else DEFAULT_PATH
        timeout = float(args[2]) if len(args) > 2 else DEFAULT_TIMEOUT
    except ValueError:
        print("porta ou timeout invalidos", file=sys.stderr)
        return 2
    try:
        return probe(DEFAULT_HOST, port, path, timeout)
    except OSError as exc:
        # Sem str(exc) completo em stdout: a saida vai para o log de saude.
        print(f"sonda falhou: {type(exc).__name__}", file=sys.stderr)
        return 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
