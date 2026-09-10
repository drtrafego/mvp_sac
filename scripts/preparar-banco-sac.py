#!/usr/bin/env python3
"""Prepara um banco NOVO para o SAC v2, no Neon ou num segundo projeto Supabase.

Um comando faz tudo, na ordem: pré-requisitos, 002_sac_multiagent_v2.sql,
os GRANT de 002_sac_roles.psql, verificação pós-aplicação e relatório.

Falha fechada: se qualquer pré-requisito não bater, nada é escrito.

A connection string NUNCA vem na linha de comando — ela apareceria em `ps`, no
histórico do shell e no log do supervisor. Passe o NOME de uma variável de
ambiente com `--database-url-env` (padrão: SAC_DATABASE_URL).

Códigos de saída: 0 pronto, 1 falha operacional, 2 recusa de pré-requisito,
3 aplicou mas a verificação reprovou.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from backend.preparo_banco import (  # noqa: E402
    ARQUIVO_ENDURECIMENTO, ARQUIVO_MIGRATION, DESTINOS, ExecutorPostgres,
    PreparoError, analisar_dsn, avaliar_prerequisitos, decidir_destino,
    descobrir_destino, montar_ordem, montar_relatorio, problemas_da_verificacao,
)

NOME_ENV_RE = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_"


def parser() -> argparse.ArgumentParser:
    resultado = argparse.ArgumentParser(
        description="Prepara o banco do SAC v2 (Neon ou Supabase) sem revelar credencial",
        epilog=f"O endurecimento do Supabase fica em {ARQUIVO_ENDURECIMENTO} "
               "e nao e aplicado por este script.",
    )
    resultado.add_argument("--destino", required=True, choices=DESTINOS,
                           help="para onde o SAC v2 vai; e conferido contra o host")
    resultado.add_argument("--database-url-env", default="SAC_DATABASE_URL",
                           help="NOME da variavel com a connection string; nunca o DSN")
    resultado.add_argument("--aplicar", action="store_true",
                           help="escreve no banco; sem esta opcao apenas diagnostica")
    resultado.add_argument("--deployer-role",
                           help="role de deploy ja existente que recebe os GRANT de "
                                "002_sac_roles.psql")
    resultado.add_argument("--roles-sac", default="",
                           help="owner,app,worker separadas por virgula, so para conferir "
                                "se ja existem; este script nao cria role")
    resultado.add_argument("--permitir-destino-divergente", action="store_true",
                           help="segue mesmo se o host nao parecer o destino declarado")
    resultado.add_argument("--json", action="store_true",
                           help="alem do relatorio, emite um resumo estruturado em stderr")
    return resultado


def _dsn_do_ambiente(nome: str) -> str:
    if not nome or any(caractere not in NOME_ENV_RE for caractere in nome):
        raise PreparoError("nome de variavel de ambiente invalido")
    if "://" in nome or "=" in nome:
        raise PreparoError("passe o NOME da variavel, nunca a connection string")
    dsn = os.environ.get(nome)
    if not dsn:
        raise PreparoError(f"variavel {nome} nao definida no ambiente")
    return dsn


def _conectar(dsn: str, *, pooler_transacional: bool):
    """Abre a conexão sem deixar o DSN vazar por exceção do driver."""
    try:
        import psycopg  # type: ignore
    except ImportError:
        psycopg = None  # type: ignore
    try:
        if psycopg is not None:
            if pooler_transacional:
                # Pooler transacional derruba prepared statement entre transacoes.
                return psycopg.connect(dsn, prepare_threshold=None)
            return psycopg.connect(dsn)
        import psycopg2  # type: ignore
        return psycopg2.connect(dsn)
    except ImportError as exc:
        raise PreparoError("instale psycopg (ou psycopg2) no ambiente operacional") from exc
    except Exception:
        # A excecao do driver costuma repetir o DSN inteiro. Nao encadeamos.
        raise PreparoError("nao foi possivel conectar ao banco; confira host, "
                           "porta, sslmode e a credencial") from None


def main(argv=None) -> int:
    args = parser().parse_args(argv)
    dsn = _dsn_do_ambiente(args.database_url_env)
    dados = analisar_dsn(dsn)
    destino = decidir_destino(args.destino, dados,
                              permitir_divergencia=args.permitir_destino_divergente)
    roles_sac = tuple(parte.strip() for parte in args.roles_sac.split(",") if parte.strip())
    ordem = montar_ordem(destino, deployer_role=args.deployer_role)

    migration_sql = (ROOT / ARQUIVO_MIGRATION).read_text(encoding="utf-8")

    conexao = _conectar(dsn, pooler_transacional=dados.pooler_transacional)
    del dsn
    try:
        executor = ExecutorPostgres(conexao)
        fatos = executor.coletar_fatos(roles_procuradas=roles_sac)
        recusas = avaliar_prerequisitos(fatos)
        if recusas:
            print(montar_relatorio(destino=destino, dados=dados, ordem=ordem, fatos=fatos,
                                   recusas=recusas, aplicado=False, verificacao=None))
            return 2

        if not args.aplicar:
            print(montar_relatorio(destino=destino, dados=dados, ordem=ordem, fatos=fatos,
                                   recusas=(), aplicado=False, verificacao=None))
            return 0

        executor.aplicar_migration(migration_sql)
        emitidos = ()
        if args.deployer_role:
            emitidos = executor.aplicar_grants_deployer(args.deployer_role)
        verificacao = executor.verificar(deployer_role=args.deployer_role,
                                         roles_sac=roles_sac)
        print(montar_relatorio(destino=destino, dados=dados, ordem=ordem, fatos=fatos,
                               recusas=(), aplicado=True, verificacao=verificacao,
                               grants_emitidos=emitidos))
        if args.json:
            print(json.dumps({
                "destino": destino,
                "host_detectado": descobrir_destino(dados),
                "aplicado": True,
                "tabelas": list(verificacao.tabelas),
                "funcoes": list(verificacao.funcoes),
                "grants_expostos": list(verificacao.grants_expostos),
                "roles_sac_ausentes": list(verificacao.roles_sac_ausentes),
                "ok": verificacao.ok,
            }, sort_keys=True), file=sys.stderr)
        if not verificacao.ok:
            for problema in problemas_da_verificacao(verificacao):
                print(f"erro: {problema}", file=sys.stderr)
            return 3
        return 0
    finally:
        fechar = getattr(conexao, "close", None)
        if callable(fechar):
            fechar()


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PreparoError as exc:
        print(f"erro: {exc}", file=sys.stderr)
        raise SystemExit(2)
    except OSError as exc:
        print(f"erro: arquivo indisponivel ({exc.strerror})", file=sys.stderr)
        raise SystemExit(1)
    except Exception:
        # Falha de driver nunca imprime DSN, senha ou query com valores.
        print("erro: falha operacional; nada garantido sobre o estado do banco. "
              "Rode de novo sem --aplicar para ver o diagnostico.", file=sys.stderr)
        raise SystemExit(1)
