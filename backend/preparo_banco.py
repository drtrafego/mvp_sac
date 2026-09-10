"""Preparo do banco novo do SAC v2 (Neon ou segundo projeto Supabase).

Este módulo carrega toda a decisão: análise da connection string, escolha do
destino, ordem de aplicação, recusas de pré-requisito e leitura do relatório.
O CLI fino fica em ``scripts/preparar-banco-sac.py``.

Invariantes que o módulo preserva:

* a URL do banco nunca aparece em log, relatório ou exceção; só host, porta,
  banco e usuário, e a senha nem é guardada;
* nada é aplicado enquanto houver uma recusa de pré-requisito (falha fechada);
* o endurecimento específico do Supabase **não** é aplicado aqui: mora em
  ``scripts/supabase-endurecer.sql`` e é decisão humana.
"""
from __future__ import annotations

import shlex
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping, Sequence
from urllib.parse import parse_qsl, unquote, urlsplit

from .runtime_v2 import usa_pooler_transacional


class PreparoError(RuntimeError):
    """Erro operacional seguro para exibir no CLI (nunca carrega DSN)."""


# --------------------------------------------------------------------------- #
# Contrato da migration
# --------------------------------------------------------------------------- #

VERSAO_MINIMA_NUM = 150000
VERSAO_MINIMA_TEXTO = "15"

ARQUIVO_MIGRATION = "002_sac_multiagent_v2.sql"
ARQUIVO_ROLES = "002_sac_roles.psql"
ARQUIVO_ENDURECIMENTO = "scripts/supabase-endurecer.sql"

TABELAS_CONTROLE: tuple[str, ...] = (
    "sac_agents", "sac_channel_accounts", "sac_schema_migrations", "sac_tenants",
)

# Colunas mínimas que provam que a tabela é a desta migration, e não uma
# homônima de outro sistema. Divergência aqui é motivo de recusa.
COLUNAS_MINIMAS: Mapping[str, tuple[str, ...]] = {
    "sac_tenants": ("id", "display_name", "status"),
    "sac_agents": ("tenant_id", "id", "schema_name", "runtime_config",
                   "hermes_api_key_secret_ref", "status"),
    "sac_channel_accounts": ("tenant_id", "agent_id", "public_endpoint_id",
                             "config", "status"),
    "sac_schema_migrations": ("tenant_id", "agent_id", "version"),
}

# Nome -> assinatura de identidade como o PostgreSQL a devolve em
# pg_get_function_identity_arguments(). Serve para achar a função certa quando
# houver sobrecarga.
FUNCOES_CONTROLE: Mapping[str, str] = {
    "sac_secret_ref_valid": "p_ref text",
    "sac_json_contains_secret_key": "p_value jsonb",
    "sac_install_agent_schema": (
        "p_tenant_id text, p_agent_id text, p_schema_name name, "
        "p_owner_role name, p_app_role name, p_worker_role name"
    ),
    "sac_provision_agent": (
        "p_tenant_id text, p_tenant_name text, p_agent_id text, p_agent_name text, "
        "p_schema_name name, p_owner_role name, p_app_role name, p_worker_role name, "
        "p_runtime_config jsonb, p_hermes_api_key_secret_ref text"
    ),
    "sac_activate_agent": "p_tenant_id text, p_agent_id text",
    # Indices de analytics: DDL aditiva com fonte unica e aplicacao por agente.
    "sac_analytics_index_ddl": "p_schema name",
    "sac_apply_analytics_indexes": "p_tenant_id text, p_agent_id text",
}

# Funções que a chave anon do PostgREST jamais pode executar. Usada tanto na
# verificação pós-aplicação quanto pelo arquivo de endurecimento.
FUNCOES_SENSIVEIS: tuple[str, ...] = tuple(sorted(FUNCOES_CONTROLE))

# Réplica fiel de 002_sac_roles.psql. O arquivo .psql usa \gexec, que psycopg
# não entende; aqui a mesma citação por format('%I') é feita no servidor.
# tests/test_preparo_banco.py garante que os dois não divirjam.
GRANTS_DEPLOYER: tuple[str, ...] = (
    "GRANT EXECUTE ON FUNCTION public.sac_provision_agent(text,text,text,text,name,name,name,name,jsonb,text) TO %I",
    "GRANT EXECUTE ON FUNCTION public.sac_install_agent_schema(text,text,name,name,name,name) TO %I",
    "GRANT EXECUTE ON FUNCTION public.sac_activate_agent(text,text) TO %I",
    "GRANT EXECUTE ON FUNCTION public.sac_apply_analytics_indexes(text,text) TO %I",
    "GRANT SELECT ON public.sac_tenants, public.sac_agents, public.sac_schema_migrations TO %I",
    "GRANT SELECT, INSERT, UPDATE ON public.sac_channel_accounts TO %I",
)

ROLES_EXPOSTAS_POSTGREST: tuple[str, ...] = ("anon", "authenticated")

DESTINOS = ("neon", "supabase")


# --------------------------------------------------------------------------- #
# Connection string
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class DadosConexao:
    """Descrição não sensível da connection string. Não guarda a senha."""

    host: str
    porta: int
    banco: str
    usuario: str
    sslmode: str | None
    tem_senha: bool
    pooler_transacional: bool

    def descrever(self) -> str:
        alvo = f"{self.usuario}@{self.host}:{self.porta}/{self.banco}"
        modo = "pooler transacional" if self.pooler_transacional else "conexao direta"
        tls = self.sslmode or "sslmode nao declarado"
        return f"{alvo} ({modo}, {tls})"


def _dsn_por_palavras_chave(dsn: str) -> dict[str, str]:
    pares: dict[str, str] = {}
    try:
        pedacos = shlex.split(dsn)
    except ValueError as exc:
        raise PreparoError("connection string mal formada") from exc
    for pedaco in pedacos:
        if "=" not in pedaco:
            raise PreparoError("connection string mal formada")
        chave, _, valor = pedaco.partition("=")
        pares[chave.strip().lower()] = valor
    return pares


def analisar_dsn(dsn: str) -> DadosConexao:
    """Analisa URI ``postgresql://`` ou forma ``host=... dbname=...``.

    Levanta ``PreparoError`` com mensagem curta; a exceção nunca inclui o DSN,
    porque ele carrega a senha.
    """
    if not isinstance(dsn, str) or not dsn.strip():
        raise PreparoError("connection string vazia")
    dsn = dsn.strip()
    if "\n" in dsn or "\r" in dsn:
        raise PreparoError("connection string contem quebra de linha")

    if "://" in dsn:
        partes = urlsplit(dsn)
        if partes.scheme not in ("postgres", "postgresql"):
            raise PreparoError("esquema invalido: use postgresql://")
        try:
            porta = partes.port or 5432
        except ValueError as exc:
            raise PreparoError("porta invalida na connection string") from exc
        host = (partes.hostname or "").lower()
        banco = unquote(partes.path.lstrip("/"))
        usuario = unquote(partes.username or "")
        opcoes = {chave.lower(): valor for chave, valor in parse_qsl(partes.query)}
        tem_senha = bool(partes.password)
    else:
        if "=" not in dsn:
            raise PreparoError("connection string irreconhecivel")
        opcoes = _dsn_por_palavras_chave(dsn)
        host = opcoes.get("host", "").lower()
        banco = opcoes.get("dbname", opcoes.get("database", ""))
        usuario = opcoes.get("user", "")
        tem_senha = bool(opcoes.get("password"))
        bruto = opcoes.get("port", "5432")
        if not bruto.isdigit():
            raise PreparoError("porta invalida na connection string")
        porta = int(bruto)

    if not host:
        raise PreparoError("connection string sem host")
    if not banco:
        raise PreparoError("connection string sem nome de banco")
    if not usuario:
        raise PreparoError("connection string sem usuario")
    if not 1 <= porta <= 65535:
        raise PreparoError("porta invalida na connection string")

    return DadosConexao(
        host=host, porta=porta, banco=banco, usuario=usuario,
        sslmode=opcoes.get("sslmode"), tem_senha=tem_senha,
        pooler_transacional=usa_pooler_transacional(dsn),
    )


def descobrir_destino(dados: DadosConexao) -> str:
    """Deduz o destino pelo host. Devolve 'neon', 'supabase' ou 'desconhecido'."""
    host = dados.host
    if host.endswith(".neon.tech") or host.endswith(".neon.build") or ".neon." in host:
        return "neon"
    for sufixo in (".supabase.co", ".supabase.com", ".supabase.in", ".supabase.net"):
        if host.endswith(sufixo):
            return "supabase"
    return "desconhecido"


def decidir_destino(declarado: str, dados: DadosConexao, *,
                    permitir_divergencia: bool = False) -> str:
    """Confere o ``--destino`` contra o host. Divergência é recusa."""
    if declarado not in DESTINOS:
        raise PreparoError("destino deve ser 'neon' ou 'supabase'")
    detectado = descobrir_destino(dados)
    if detectado == "desconhecido" or detectado == declarado:
        return declarado
    if permitir_divergencia:
        return declarado
    raise PreparoError(
        f"destino declarado '{declarado}' nao combina com o host '{dados.host}', "
        f"que parece '{detectado}'; confira a credencial ou use "
        "--permitir-destino-divergente conscientemente"
    )


# --------------------------------------------------------------------------- #
# Ordem de aplicação
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Passo:
    nome: str
    descricao: str
    automatico: bool


def montar_ordem(destino: str, *, deployer_role: str | None = None) -> tuple[Passo, ...]:
    """Ordem fixa e auditável do preparo, com o que é humano marcado."""
    if destino not in DESTINOS:
        raise PreparoError("destino deve ser 'neon' ou 'supabase'")
    passos: list[Passo] = [
        Passo("criar-roles-sac",
              "criar owner/app/worker fora deste script, pela politica de senha do ambiente",
              False),
        Passo("prerequisitos",
              "versao do PostgreSQL, CREATEROLE, CREATE no banco e ausencia de conflito",
              True),
        Passo("migration", f"aplicar {ARQUIVO_MIGRATION} (control plane e funcoes)", True),
    ]
    if deployer_role:
        passos.append(Passo("grants-deployer",
                            f"aplicar os GRANT de {ARQUIVO_ROLES} para a role de deploy", True))
    passos.append(Passo("verificacao",
                        "4 tabelas de controle, 5 funcoes e ausencia de grant publico", True))
    if destino == "supabase":
        passos.append(Passo("endurecer-postgrest",
                            f"revisar e aplicar {ARQUIVO_ENDURECIMENTO} a mao", False))
        passos.append(Passo("remover-public-dos-exposed-schemas",
                            "tirar 'public' de Settings > API > Exposed schemas no painel", False))
    return tuple(passos)


# --------------------------------------------------------------------------- #
# Pré-requisitos e recusas
# --------------------------------------------------------------------------- #

@dataclass(frozen=True)
class Recusa:
    codigo: str
    motivo: str
    como_corrigir: str

    def __str__(self) -> str:
        return f"[{self.codigo}] {self.motivo} -> {self.como_corrigir}"


@dataclass(frozen=True)
class FatosDoBanco:
    """Tudo que o script lê antes de decidir. Coletado por ``ExecutorPostgres``."""

    versao_num: int = 0
    versao_texto: str = ""
    usuario: str = ""
    banco: str = ""
    superusuario: bool = False
    pode_criar_role: bool = False
    pode_criar_schema: bool = False
    tabelas_controle: tuple[str, ...] = ()
    tabelas_sem_dono_acessivel: tuple[str, ...] = ()
    colunas_por_tabela: Mapping[str, tuple[str, ...]] = field(default_factory=dict)
    funcoes: Mapping[str, str] = field(default_factory=dict)
    funcoes_sem_dono_acessivel: tuple[str, ...] = ()
    roles_existentes: tuple[str, ...] = ()
    schemas_sac: tuple[str, ...] = ()


def colunas_divergentes(fatos: FatosDoBanco) -> tuple[str, ...]:
    """Tabelas de controle já existentes às quais falta coluna obrigatória."""
    faltando: list[str] = []
    for tabela in fatos.tabelas_controle:
        esperadas = COLUNAS_MINIMAS.get(tabela, ())
        presentes = set(fatos.colunas_por_tabela.get(tabela, ()))
        for coluna in esperadas:
            if coluna not in presentes:
                faltando.append(f"{tabela}.{coluna}")
    return tuple(sorted(faltando))


def avaliar_prerequisitos(fatos: FatosDoBanco) -> tuple[Recusa, ...]:
    """Recusas que impedem a aplicação. Lista vazia significa liberado."""
    recusas: list[Recusa] = []

    if fatos.versao_num < VERSAO_MINIMA_NUM:
        recusas.append(Recusa(
            "postgres-antigo",
            f"servidor {fatos.versao_texto or 'desconhecido'} e a migration exige "
            f"PostgreSQL {VERSAO_MINIMA_TEXTO}+",
            "crie o banco numa versao 15 ou superior; nao ha caminho de contorno",
        ))

    if not (fatos.pode_criar_role or fatos.superusuario):
        recusas.append(Recusa(
            "sem-createrole",
            f"a role conectada ({fatos.usuario or 'desconhecida'}) nao tem CREATEROLE "
            "nem herda de quem tenha",
            "conecte com a role administrativa do provedor (postgres no Supabase, "
            "o owner membro de neon_superuser no Neon)",
        ))

    if not fatos.pode_criar_schema:
        recusas.append(Recusa(
            "sem-create-no-banco",
            f"a role conectada nao tem privilegio CREATE no banco {fatos.banco or '?'}",
            "GRANT CREATE ON DATABASE <banco> TO <role>, ou use a role administrativa",
        ))

    presentes = tuple(sorted(fatos.tabelas_controle))
    if presentes and len(presentes) < len(TABELAS_CONTROLE):
        ausentes = sorted(set(TABELAS_CONTROLE) - set(presentes))
        recusas.append(Recusa(
            "control-plane-parcial",
            "control plane pela metade: existe " + ", ".join(presentes)
            + " e falta " + ", ".join(ausentes),
            "investigue a aplicacao anterior; nao aplique por cima sem saber o que "
            "restou, porque pode haver dado de cliente nas tabelas presentes",
        ))

    divergentes = colunas_divergentes(fatos)
    if divergentes:
        recusas.append(Recusa(
            "estrutura-conflitante",
            "tabela homonima ja existe sem as colunas desta migration: "
            + ", ".join(divergentes),
            "este banco ja tem outro sistema em public; escolha outro banco ou "
            "renomeie a estrutura antiga antes de continuar",
        ))

    if fatos.tabelas_sem_dono_acessivel or fatos.funcoes_sem_dono_acessivel:
        objetos = ", ".join(sorted(fatos.tabelas_sem_dono_acessivel
                                   + fatos.funcoes_sem_dono_acessivel))
        recusas.append(Recusa(
            "dono-inacessivel",
            f"objetos de controle pertencem a role fora do seu alcance: {objetos}",
            "reaplicar com a role dona, ou tornar a role conectada membro dela; "
            "sem isso CREATE OR REPLACE e REVOKE falham no meio da migration",
        ))

    return tuple(recusas)


# --------------------------------------------------------------------------- #
# Verificação pós-aplicação
# --------------------------------------------------------------------------- #

# EXECUTE para PUBLIC nestas duas e o padrao do PostgreSQL para qualquer
# funcao, e elas sao IMMUTABLE e nao leem nada: sac_secret_ref_valid so casa uma
# regex e sac_json_contains_secret_key so varre um jsonb recebido. Num banco sem
# PostgREST isso nao expoe dado nenhum, entao vira observacao, nao reprovacao.
# Num Supabase, scripts/supabase-endurecer.sql fecha as duas junto com o resto.
FUNCOES_PURAS: tuple[str, ...] = ("sac_json_contains_secret_key", "sac_secret_ref_valid")


def _e_observacao(grant: str) -> bool:
    grantee, _, resto = grant.partition(":")
    return grantee == "PUBLIC" and any(
        resto.startswith(nome + "()") for nome in FUNCOES_PURAS)


@dataclass(frozen=True)
class Verificacao:
    tabelas: tuple[str, ...] = ()
    funcoes: tuple[str, ...] = ()
    grants_expostos: tuple[str, ...] = ()
    grants_deployer_ok: tuple[str, ...] = ()
    grants_deployer_faltando: tuple[str, ...] = ()
    roles_sac_ausentes: tuple[str, ...] = ()
    observacoes: tuple[str, ...] = ()

    @property
    def tabelas_faltando(self) -> tuple[str, ...]:
        return tuple(sorted(set(TABELAS_CONTROLE) - set(self.tabelas)))

    @property
    def funcoes_faltando(self) -> tuple[str, ...]:
        return tuple(sorted(set(FUNCOES_CONTROLE) - set(self.funcoes)))

    @property
    def ok(self) -> bool:
        return not (self.tabelas_faltando or self.funcoes_faltando
                    or self.grants_expostos or self.grants_deployer_faltando)


def resumir(itens: Sequence[str], limite: int = 10) -> str:
    """Encurta lista longa para caber num relatorio que alguem vai mesmo ler."""
    if not itens:
        return "nenhum"
    if len(itens) <= limite:
        return ", ".join(itens)
    return ", ".join(itens[:limite]) + f" ... (+{len(itens) - limite})"


def problemas_da_verificacao(verificacao: Verificacao) -> tuple[str, ...]:
    """Lista legível do que faltou. Vazia quando a verificação passou."""
    problemas: list[str] = []
    if verificacao.tabelas_faltando:
        problemas.append("tabelas de controle ausentes: "
                         + ", ".join(verificacao.tabelas_faltando))
    if verificacao.funcoes_faltando:
        problemas.append("funcoes ausentes: " + ", ".join(verificacao.funcoes_faltando))
    if verificacao.grants_expostos:
        problemas.append("control plane alcancavel por role exposta: "
                         + resumir(verificacao.grants_expostos))
    if verificacao.grants_deployer_faltando:
        problemas.append("grants da role de deploy ausentes: "
                         + ", ".join(verificacao.grants_deployer_faltando))
    return tuple(problemas)


# --------------------------------------------------------------------------- #
# Execução contra o banco
# --------------------------------------------------------------------------- #

def _lista(placeholders: Iterable[str]) -> str:
    return ",".join(placeholders)


class ExecutorPostgres:
    """Adaptador DB-API. Recebe a conexão pronta e nunca vê a URL do banco."""

    def __init__(self, connection: Any) -> None:
        self.connection = connection

    # -- leitura ---------------------------------------------------------- #

    def _consultar(self, query: str, params: Sequence[Any] = ()) -> list[tuple]:
        cur = self.connection.cursor()
        try:
            # Sem parametros, o driver nao pode tentar interpolar: a consulta de
            # schemas usa LIKE 'sac\_%' e o % seria lido como marcador.
            cur.execute(query, tuple(params) if params else None)
            return list(cur.fetchall() or [])
        finally:
            fechar = getattr(cur, "close", None)
            if callable(fechar):
                fechar()

    def coletar_fatos(self, *, roles_procuradas: Sequence[str] = ()) -> FatosDoBanco:
        identidade = self._consultar(
            "SELECT pg_catalog.current_setting('server_version_num')::int, "
            "pg_catalog.current_setting('server_version'), "
            "current_user::text, pg_catalog.current_database()::text, "
            "pg_catalog.has_database_privilege("
            "  current_user, pg_catalog.current_database(), 'CREATE'), "
            "(SELECT pg_catalog.bool_or(r.rolsuper) FROM pg_catalog.pg_roles r "
            "  WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER')), "
            "(SELECT pg_catalog.bool_or(r.rolcreaterole) FROM pg_catalog.pg_roles r "
            "  WHERE pg_catalog.pg_has_role(current_user, r.oid, 'MEMBER'))"
        )
        linha = identidade[0] if identidade else (0, "", "", "", False, False, False)

        marcas = _lista("%s" for _ in TABELAS_CONTROLE)
        tabelas = self._consultar(
            "SELECT c.relname::text, "
            "       pg_catalog.pg_has_role(current_user, c.relowner, 'MEMBER') "
            "  FROM pg_catalog.pg_class c "
            "  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
            f" WHERE n.nspname = 'public' AND c.relkind IN ('r','p') AND c.relname IN ({marcas})",
            TABELAS_CONTROLE,
        )
        nomes_tabelas = tuple(sorted(str(item[0]) for item in tabelas))
        sem_dono_tabela = tuple(sorted(str(item[0]) for item in tabelas if not item[1]))

        colunas: dict[str, list[str]] = {}
        if nomes_tabelas:
            marcas_t = _lista("%s" for _ in nomes_tabelas)
            # pg_attribute, e nao information_schema.columns: a view do
            # information_schema esconde coluna de tabela sobre a qual a role
            # nao tem privilegio, o que faria uma tabela integra parecer
            # divergente so porque quem conectou nao enxerga.
            for tabela, coluna in self._consultar(
                "SELECT c.relname::text, a.attname::text "
                "  FROM pg_catalog.pg_class c "
                "  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace "
                "  JOIN pg_catalog.pg_attribute a ON a.attrelid = c.oid "
                " WHERE n.nspname = 'public' AND a.attnum > 0 AND NOT a.attisdropped "
                f"   AND c.relname IN ({marcas_t})",
                nomes_tabelas,
            ):
                colunas.setdefault(str(tabela), []).append(str(coluna))

        marcas_f = _lista("%s" for _ in FUNCOES_CONTROLE)
        funcoes_linhas = self._consultar(
            "SELECT p.proname::text, "
            "       pg_catalog.pg_get_function_identity_arguments(p.oid), "
            "       pg_catalog.pg_has_role(current_user, p.proowner, 'MEMBER') "
            "  FROM pg_catalog.pg_proc p "
            "  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace "
            f" WHERE n.nspname = 'public' AND p.proname IN ({marcas_f})",
            tuple(sorted(FUNCOES_CONTROLE)),
        )
        funcoes = {str(item[0]): str(item[1] or "") for item in funcoes_linhas}
        sem_dono_funcao = tuple(sorted(str(item[0]) for item in funcoes_linhas if not item[2]))

        roles: tuple[str, ...] = ()
        procuradas = tuple(dict.fromkeys(
            list(roles_procuradas) + list(ROLES_EXPOSTAS_POSTGREST)
        ))
        if procuradas:
            marcas_r = _lista("%s" for _ in procuradas)
            roles = tuple(sorted(
                str(item[0]) for item in self._consultar(
                    f"SELECT rolname::text FROM pg_catalog.pg_roles WHERE rolname IN ({marcas_r})",
                    procuradas,
                )
            ))

        schemas = tuple(sorted(
            str(item[0]) for item in self._consultar(
                "SELECT nspname::text FROM pg_catalog.pg_namespace WHERE nspname LIKE 'sac\\_%'"
            )
        ))

        return FatosDoBanco(
            versao_num=int(linha[0] or 0), versao_texto=str(linha[1] or ""),
            usuario=str(linha[2] or ""), banco=str(linha[3] or ""),
            pode_criar_schema=bool(linha[4]), superusuario=bool(linha[5]),
            pode_criar_role=bool(linha[6]),
            tabelas_controle=nomes_tabelas,
            tabelas_sem_dono_acessivel=sem_dono_tabela,
            colunas_por_tabela={k: tuple(sorted(v)) for k, v in colunas.items()},
            funcoes=funcoes, funcoes_sem_dono_acessivel=sem_dono_funcao,
            roles_existentes=roles, schemas_sac=schemas,
        )

    # -- escrita ---------------------------------------------------------- #

    def _em_transacao(self, corpo) -> None:
        cur = self.connection.cursor()
        try:
            corpo(cur)
            self.connection.commit()
        except BaseException:
            reverter = getattr(self.connection, "rollback", None)
            if callable(reverter):
                reverter()
            raise
        finally:
            fechar = getattr(cur, "close", None)
            if callable(fechar):
                fechar()

    def aplicar_migration(self, sql: str) -> None:
        """Executa 002_sac_multiagent_v2.sql inteiro. O arquivo abre e fecha a
        própria transação; reexecutar é no-op por CREATE ... IF NOT EXISTS e
        CREATE OR REPLACE FUNCTION."""
        if "sac_provision_agent" not in sql:
            raise PreparoError("arquivo de migration nao parece o 002 do SAC v2")
        self._em_transacao(lambda cur: cur.execute(sql))

    def aplicar_grants_deployer(self, role: str) -> tuple[str, ...]:
        """Equivalente em psycopg ao \\gexec de 002_sac_roles.psql.

        O nome da role é citado por format('%I') no próprio servidor, então não
        há concatenação de identificador em Python. Se a role não existir,
        nenhum GRANT é emitido — igual ao arquivo psql.
        """
        if not role or not role.replace("_", "").replace("-", "").isalnum():
            raise PreparoError("nome de role de deploy invalido")
        emitidos: list[str] = []

        def corpo(cur):
            for gabarito in GRANTS_DEPLOYER:
                cur.execute(
                    "SELECT pg_catalog.format(%s::text, %s::text) "
                    "FROM pg_catalog.pg_roles WHERE rolname = %s::name",
                    (gabarito, role, role),
                )
                linha = cur.fetchone()
                if not linha:
                    continue
                cur.execute(str(linha[0]))
                emitidos.append(gabarito.replace("%I", role))

        self._em_transacao(corpo)
        return tuple(emitidos)

    # -- verificação ------------------------------------------------------ #

    def verificar(self, *, deployer_role: str | None = None,
                  roles_sac: Sequence[str] = ()) -> Verificacao:
        fatos = self.coletar_fatos(roles_procuradas=roles_sac)

        marcas = _lista("%s" for _ in TABELAS_CONTROLE)
        expostos: list[str] = []
        por_tabela: dict[str, set[str]] = {}
        for grantee, tabela, privilegio in self._consultar(
            "SELECT g.grantee::text, g.table_name::text, g.privilege_type::text "
            "  FROM information_schema.role_table_grants g "
            f" WHERE g.table_schema = 'public' AND g.table_name IN ({marcas}) "
            "   AND g.grantee IN ('PUBLIC', 'anon', 'authenticated')",
            TABELAS_CONTROLE,
        ):
            # Agrupado por objeto: 7 privilegios numa tabela sao um problema so.
            por_tabela.setdefault(f"{grantee}:{tabela}", set()).add(str(privilegio))

        marcas_f = _lista("%s" for _ in FUNCOES_CONTROLE)
        # A ACL, e nao has_function_privilege(): a role anon "tem" EXECUTE
        # sempre que PUBLIC tem, porque herda do pseudo-papel. Perguntar pela
        # ACL separa a concessao nominal do Supabase (problema) do EXECUTE
        # padrao que o PostgreSQL da a PUBLIC em qualquer funcao (observacao).
        for nome, grantee in self._consultar(
            "SELECT p.proname::text, r.rolname::text "
            "  FROM pg_catalog.pg_proc p "
            "  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace "
            "  CROSS JOIN LATERAL pg_catalog.aclexplode("
            "     COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a "
            "  JOIN pg_catalog.pg_roles r ON r.oid = a.grantee "
            f" WHERE n.nspname = 'public' AND p.proname IN ({marcas_f}) "
            "   AND r.rolname IN ('anon', 'authenticated') "
            "   AND a.privilege_type = 'EXECUTE'",
            tuple(sorted(FUNCOES_CONTROLE)),
        ):
            expostos.append(f"{grantee}:{nome}():EXECUTE")

        for nome, in self._consultar(
            "SELECT p.proname::text "
            "  FROM pg_catalog.pg_proc p "
            "  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace, "
            "  LATERAL pg_catalog.aclexplode("
            "     COALESCE(p.proacl, pg_catalog.acldefault('f', p.proowner))) a "
            f" WHERE n.nspname = 'public' AND p.proname IN ({marcas_f}) "
            "   AND a.grantee = 0 AND a.privilege_type = 'EXECUTE'",
            tuple(sorted(FUNCOES_CONTROLE)),
        ):
            expostos.append(f"PUBLIC:{nome}():EXECUTE")

        for alvo, privilegios in por_tabela.items():
            expostos.append(alvo + ":" + "/".join(sorted(privilegios)))

        ok_deployer: tuple[str, ...] = ()
        falta_deployer: tuple[str, ...] = ()
        if deployer_role:
            concedidos: list[str] = []
            faltando: list[str] = []
            checagens = (
                ("sac_provision_agent",
                 "public.sac_provision_agent(text,text,text,text,name,name,name,name,jsonb,text)"),
                ("sac_install_agent_schema",
                 "public.sac_install_agent_schema(text,text,name,name,name,name)"),
                ("sac_activate_agent", "public.sac_activate_agent(text,text)"),
            )
            for rotulo, assinatura in checagens:
                linha = self._consultar(
                    "SELECT pg_catalog.has_function_privilege(%s::name, %s::text, 'EXECUTE')",
                    (deployer_role, assinatura),
                )
                (concedidos if linha and linha[0][0] else faltando).append(f"EXECUTE {rotulo}")
            for tabela, privilegio in (
                ("public.sac_tenants", "SELECT"), ("public.sac_agents", "SELECT"),
                ("public.sac_schema_migrations", "SELECT"),
                ("public.sac_channel_accounts", "SELECT, INSERT, UPDATE"),
            ):
                linha = self._consultar(
                    "SELECT bool_and(pg_catalog.has_table_privilege(%s::name, %s::text, p)) "
                    "FROM unnest(string_to_array(%s::text, ', ')) AS p",
                    (deployer_role, tabela, privilegio),
                )
                rotulo = f"{privilegio} {tabela}"
                (concedidos if linha and linha[0][0] else faltando).append(rotulo)
            ok_deployer, falta_deployer = tuple(concedidos), tuple(faltando)

        ausentes = tuple(sorted(set(roles_sac) - set(fatos.roles_existentes)))
        unicos = sorted(set(expostos))
        return Verificacao(
            tabelas=fatos.tabelas_controle,
            funcoes=tuple(sorted(fatos.funcoes)),
            grants_expostos=tuple(g for g in unicos if not _e_observacao(g)),
            observacoes=tuple(g for g in unicos if _e_observacao(g)),
            grants_deployer_ok=ok_deployer,
            grants_deployer_faltando=falta_deployer,
            roles_sac_ausentes=ausentes,
        )


# --------------------------------------------------------------------------- #
# Relatório
# --------------------------------------------------------------------------- #

def montar_relatorio(*, destino: str, dados: DadosConexao, ordem: Sequence[Passo],
                     fatos: FatosDoBanco, recusas: Sequence[Recusa],
                     aplicado: bool, verificacao: Verificacao | None,
                     grants_emitidos: Sequence[str] = ()) -> str:
    """Relatório legível. Nunca imprime a connection string nem a senha."""
    linhas: list[str] = []
    linhas.append("== Preparo do banco do SAC v2 ==")
    linhas.append(f"destino declarado : {destino}")
    linhas.append(f"host detectado    : {descobrir_destino(dados)}")
    linhas.append(f"conexao           : {dados.descrever()}")
    linhas.append(f"servidor          : PostgreSQL {fatos.versao_texto or '?'} "
                  f"(exigido {VERSAO_MINIMA_TEXTO}+)")
    linhas.append(f"role conectada    : {fatos.usuario or '?'} "
                  f"(createrole={'sim' if fatos.pode_criar_role else 'nao'}, "
                  f"superuser={'sim' if fatos.superusuario else 'nao'}, "
                  f"create-no-banco={'sim' if fatos.pode_criar_schema else 'nao'})")
    linhas.append("")

    linhas.append("-- ordem prevista --")
    for indice, passo in enumerate(ordem, start=1):
        marca = "auto" if passo.automatico else "MAO HUMANA"
        linhas.append(f" {indice}. [{marca}] {passo.nome}: {passo.descricao}")
    linhas.append("")

    if recusas:
        linhas.append("-- RECUSADO: nada foi aplicado --")
        for recusa in recusas:
            linhas.append(f" * {recusa}")
        linhas.append("")
        linhas.append("Corrija os itens acima e rode de novo. O script falha fechado "
                      "de proposito: aplicar metade da migration e pior.")
        return "\n".join(linhas)

    linhas.append("-- pre-requisitos --")
    linhas.append(" * todos atendidos")
    linhas.append("")

    if not aplicado:
        linhas.append("-- diagnostico apenas --")
        linhas.append(" Nada foi escrito. Repita o comando com --aplicar para valer.")
        if fatos.tabelas_controle:
            linhas.append(" Control plane ja presente: " + ", ".join(fatos.tabelas_controle))
        if fatos.schemas_sac:
            linhas.append(" Schemas de agente ja existentes: " + ", ".join(fatos.schemas_sac))
        return "\n".join(linhas)

    linhas.append("-- aplicacao --")
    linhas.append(f" * {ARQUIVO_MIGRATION} aplicado")
    if grants_emitidos:
        linhas.append(f" * {ARQUIVO_ROLES} aplicado ({len(grants_emitidos)} GRANT)")
        for grant in grants_emitidos:
            linhas.append(f"   - {grant}")
    else:
        linhas.append(f" * {ARQUIVO_ROLES} nao aplicado (nenhuma --deployer-role informada, "
                      "ou a role nao existe no servidor)")
    linhas.append("")

    if verificacao is not None:
        linhas.append("-- verificacao pos-aplicacao --")
        linhas.append(f" tabelas de controle : {len(verificacao.tabelas)}/"
                      f"{len(TABELAS_CONTROLE)} "
                      + (", ".join(verificacao.tabelas) or "nenhuma"))
        linhas.append(f" funcoes             : {len(verificacao.funcoes)}/"
                      f"{len(FUNCOES_CONTROLE)} "
                      + (", ".join(verificacao.funcoes) or "nenhuma"))
        linhas.append(" grants expostos     : " + resumir(verificacao.grants_expostos))
        if verificacao.observacoes:
            linhas.append(" observacoes         : " + resumir(verificacao.observacoes)
                          + " (padrao do PostgreSQL para funcao pura; so importa "
                            "se houver PostgREST)")
        if verificacao.grants_deployer_ok or verificacao.grants_deployer_faltando:
            linhas.append(" grants do deployer  : "
                          + (", ".join(verificacao.grants_deployer_ok) or "nenhum"))
        problemas = problemas_da_verificacao(verificacao)
        linhas.append("")
        if problemas:
            linhas.append("-- FALTOU --")
            for problema in problemas:
                linhas.append(f" * {problema}")
        else:
            linhas.append("-- OK: control plane instalado e fora do alcance publico --")
        if verificacao.roles_sac_ausentes:
            linhas.append("")
            linhas.append(" Atencao: roles do SAC ainda ausentes: "
                          + ", ".join(verificacao.roles_sac_ausentes)
                          + ". Sem elas sac_provision_agent recusa o agente.")

    if destino == "supabase":
        linhas.append("")
        linhas.append("-- pendencia do Supabase (nao automatizada) --")
        linhas.append(f" 1. revise e aplique {ARQUIVO_ENDURECIMENTO} a mao;")
        linhas.append(" 2. tire 'public' de Settings > API > Exposed schemas no painel;")
        linhas.append(" 3. so entao considere o control plane fora do alcance da chave anon.")
    else:
        linhas.append("")
        linhas.append("-- observacao do Neon --")
        linhas.append(" Nao ha PostgREST: o control plane so e alcancavel por conexao "
                      "PostgreSQL autenticada. O endurecimento do Supabase nao se aplica.")
    return "\n".join(linhas)
