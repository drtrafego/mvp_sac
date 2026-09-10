#!/usr/bin/env python3
"""Servidor local de homologacao: painel estatico + proxy para o gateway v2.

Existe por um motivo: reproduzir, sem tocar em producao, exatamente a topologia
que o painel usa em `/sac/` — pagina estatica e API na MESMA origem, sob um
prefixo relativo. E o equivalente local do bloco nginx documentado no README.

Restricoes deliberadas:

* escuta somente no loopback e recusa qualquer outro endereco;
* encaminha apenas `/api/<caminho>` para `/api/v1/panel/<caminho>`; nenhum
  outro caminho do gateway (webhooks, livez, readyz) e alcancavel por aqui;
* nao adiciona, remove ou reescreve autenticacao: cookie de sessao e cabecalho
  CSRF passam intactos nos dois sentidos.

Uso:

    python3 scripts/painel-dev-proxy.py --port 8190 --gateway http://127.0.0.1:8188
"""
from __future__ import annotations

import argparse
import sys
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import Request, urlopen

API_PREFIX = "/api/"
GATEWAY_PREFIX = "/api/v1/panel/"
FORWARD_REQUEST = ("cookie", "content-type", "accept", "x-sac-panel-csrf")
FORWARD_RESPONSE = ("content-type", "set-cookie", "cache-control",
                    "x-content-type-options", "vary")
MAX_BODY = 1_048_576
LOOPBACK = {"127.0.0.1", "::1", "localhost"}


class PainelHandler(SimpleHTTPRequestHandler):
    gateway = "http://127.0.0.1:8188"

    def do_GET(self):  # noqa: N802
        if self.path.startswith(API_PREFIX):
            return self._proxy("GET")
        return super().do_GET()

    def do_POST(self):  # noqa: N802
        return self._proxy("POST") if self.path.startswith(API_PREFIX) else self._deny()

    def do_DELETE(self):  # noqa: N802
        return self._proxy("DELETE") if self.path.startswith(API_PREFIX) else self._deny()

    def _deny(self):
        self.send_response(405)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _proxy(self, method: str):
        parts = urlsplit(self.path)
        target = f"{self.gateway}{GATEWAY_PREFIX}{parts.path[len(API_PREFIX):]}"
        if parts.query:
            target += "?" + parts.query
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = -1
        if length < 0 or length > MAX_BODY:
            self.send_response(413)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        body = self.rfile.read(length) if length else None
        request = Request(target, data=body, method=method)
        for name in FORWARD_REQUEST:
            value = self.headers.get(name)
            if value:
                request.add_header(name, value)
        try:
            with urlopen(request, timeout=15) as response:
                self._relay(response.status, response.headers, response.read())
        except HTTPError as error:
            self._relay(error.code, error.headers, error.read())
        except (URLError, OSError):
            payload = b'{"error":"gateway_unreachable"}'
            self.send_response(503)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    def _relay(self, status, headers, payload: bytes):
        self.send_response(status)
        for name in FORWARD_RESPONSE:
            for value in headers.get_all(name) or []:
                self.send_header(name, value)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        if payload:
            self.wfile.write(payload)

    def log_message(self, formato, *args):  # silencio: nao logar cookie/URL
        return


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Painel + proxy local de homologacao")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8190)
    parser.add_argument("--gateway", default="http://127.0.0.1:8188")
    parser.add_argument("--root", default=str(Path(__file__).resolve().parents[1] / "painel"))
    args = parser.parse_args(argv)
    if args.host not in LOOPBACK:
        print("recusado: este servidor e de homologacao e so escuta no loopback",
              file=sys.stderr)
        return 2
    PainelHandler.gateway = args.gateway.rstrip("/")
    handler = partial(PainelHandler, directory=args.root)
    with ThreadingHTTPServer((args.host, args.port), handler) as server:
        print(f"painel em http://{args.host}:{args.port}/ (api -> {PainelHandler.gateway}{GATEWAY_PREFIX})")
        server.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
