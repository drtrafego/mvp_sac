#!/usr/bin/env python3
"""Gera a entrada de um operador do painel para o cadastro no cofre.

A senha e lida de stdin ou por prompt e NUNCA e impressa, gravada em arquivo
nem passada por linha de comando (a lista de processos e publica). A saida e
somente o hash derivado, que e o que fica no cofre.

    python3 scripts/painel-operador.py --id gastao --nome "Gastao" \
      --agente dr-lucas/atendimento --agente gramado-plazza/atendimento:leitura

Depois, junte as entradas em `<SECRET_DIR>/painel/operadores.json` no formato
`{"operators": [...]}`, com dono igual ao UID do contêiner e modo 600. O
gateway recarrega o arquivo a cada login: revogar acesso nao exige reinicio.
"""
from __future__ import annotations

import argparse
import getpass
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from backend.panel_auth import DEFAULT_ITERATIONS, hash_password  # noqa: E402


def parse_agent(value: str) -> dict[str, object]:
    scope, _, mode = value.partition(":")
    tenant, separator, agent = scope.partition("/")
    if not separator or not tenant or not agent:
        raise argparse.ArgumentTypeError("use tenant/agente[:leitura]")
    if mode and mode not in {"leitura", "escrita"}:
        raise argparse.ArgumentTypeError("permissao deve ser leitura ou escrita")
    return {"tenantId": tenant, "agentId": agent, "write": mode != "leitura"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Entrada de operador do painel SAC v2")
    parser.add_argument("--id", required=True)
    parser.add_argument("--nome", default="")
    parser.add_argument("--agente", action="append", type=parse_agent, default=[],
                        help="tenant/agente[:leitura]; repita para varios agentes")
    parser.add_argument("--iteracoes", type=int, default=DEFAULT_ITERATIONS)
    args = parser.parse_args(argv)
    if not args.agente:
        print("recusado: informe ao menos um --agente", file=sys.stderr)
        return 2
    senha = sys.stdin.readline().rstrip("\n") if not sys.stdin.isatty() else getpass.getpass("senha: ")
    try:
        entrada = {"id": args.id, "displayName": args.nome or args.id,
                   "passwordHash": hash_password(senha, iterations=args.iteracoes),
                   "agents": args.agente}
    except ValueError as exc:
        print(f"recusado: {exc}", file=sys.stderr)
        return 2
    finally:
        senha = ""
    print(json.dumps(entrada, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
