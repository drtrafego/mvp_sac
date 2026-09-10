"""Contrato offline do preparo do banco do SAC v2. Nenhum teste abre conexao."""
import os
import subprocess
import sys
import unittest
from pathlib import Path

from backend.preparo_banco import (
    COLUNAS_MINIMAS, FUNCOES_CONTROLE, GRANTS_DEPLOYER, TABELAS_CONTROLE,
    VERSAO_MINIMA_NUM, DadosConexao, ExecutorPostgres, FatosDoBanco, PreparoError,
    Verificacao, analisar_dsn, avaliar_prerequisitos, colunas_divergentes,
    decidir_destino, descobrir_destino, montar_ordem, montar_relatorio,
    problemas_da_verificacao, resumir,
)

ROOT = Path(__file__).resolve().parents[1]

SENHA = "S3nh4-que-nao-pode-vazar"
DSN_SUPABASE_DIRETO = f"postgresql://postgres:{SENHA}@db.abcdefgh.supabase.co:5432/postgres?sslmode=require"
DSN_SUPABASE_POOLER = f"postgresql://postgres.abcdefgh:{SENHA}@aws-0-sa-east-1.pooler.supabase.com:6543/postgres"
DSN_NEON_DIRETO = f"postgresql://sac_owner:{SENHA}@ep-cool-sun-123456.sa-east-1.aws.neon.tech/sacdb?sslmode=require"
DSN_NEON_POOLER = f"postgresql://sac_owner:{SENHA}@ep-cool-sun-123456-pooler.sa-east-1.aws.neon.tech/sacdb"


def fatos_saudaveis(**mudancas):
    base = dict(
        versao_num=160004, versao_texto="16.4", usuario="postgres", banco="sacdb",
        superusuario=False, pode_criar_role=True, pode_criar_schema=True,
        tabelas_controle=(), tabelas_sem_dono_acessivel=(),
        colunas_por_tabela={}, funcoes={}, funcoes_sem_dono_acessivel=(),
        roles_existentes=(), schemas_sac=(),
    )
    base.update(mudancas)
    return FatosDoBanco(**base)


def codigos(recusas):
    return sorted(recusa.codigo for recusa in recusas)


# --------------------------------------------------------------------------- #
# Conexao falsa
# --------------------------------------------------------------------------- #

class CursorFalso:
    def __init__(self, conexao):
        self.conexao = conexao
        self.resultado = []

    def execute(self, query, params=None):
        normal = " ".join(query.split())
        self.conexao.executadas.append((normal, params))
        if self.conexao.falhar_em and self.conexao.falhar_em in normal:
            raise RuntimeError("falha simulada do driver")
        self.resultado = self.conexao.responder(normal, params)

    def fetchall(self):
        return list(self.resultado)

    def fetchone(self):
        return self.resultado[0] if self.resultado else None

    def close(self):
        self.conexao.cursores_fechados += 1


class ConexaoFalsa:
    """DB-API mínima. Casa a consulta pelo trecho mais específico informado."""

    def __init__(self, respostas=None, falhar_em=None):
        self.respostas = dict(respostas or {})
        self.falhar_em = falhar_em
        self.executadas = []
        self.commits = 0
        self.rollbacks = 0
        self.cursores_fechados = 0

    def cursor(self):
        return CursorFalso(self)

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def responder(self, normal, params):
        casadas = [chave for chave in self.respostas if chave in normal]
        if not casadas:
            return []
        escolhida = max(casadas, key=len)
        valor = self.respostas[escolhida]
        return valor(params) if callable(valor) else valor


RESPOSTAS_PRONTAS = {
    "server_version_num": [(160004, "16.4", "postgres", "sacdb", True, False, True)],
    "c.relkind IN ('r','p')": [(tabela, True) for tabela in TABELAS_CONTROLE],
    "pg_catalog.pg_attribute": [
        (tabela, coluna) for tabela, colunas in COLUNAS_MINIMAS.items() for coluna in colunas
    ],
    "pg_get_function_identity_arguments": [
        (nome, assinatura, True) for nome, assinatura in FUNCOES_CONTROLE.items()
    ],
    "pg_roles WHERE rolname IN": [],
    "nspname LIKE": [],
    "role_table_grants": [],
    "r.oid = a.grantee": [],
    "a.grantee = 0": [],
    "has_function_privilege(%s::name, %s::text, 'EXECUTE')": [(True,)],
    "has_table_privilege": [(True,)],
}


# --------------------------------------------------------------------------- #
# 1. Connection string
# --------------------------------------------------------------------------- #

class AnaliseDaConnectionStringTests(unittest.TestCase):
    def test_uri_do_supabase_direto(self):
        dados = analisar_dsn(DSN_SUPABASE_DIRETO)
        self.assertEqual(dados.host, "db.abcdefgh.supabase.co")
        self.assertEqual(dados.porta, 5432)
        self.assertEqual(dados.banco, "postgres")
        self.assertEqual(dados.usuario, "postgres")
        self.assertEqual(dados.sslmode, "require")
        self.assertTrue(dados.tem_senha)
        self.assertFalse(dados.pooler_transacional)

    def test_uri_do_pooler_transacional_e_reconhecida(self):
        dados = analisar_dsn(DSN_SUPABASE_POOLER)
        self.assertEqual(dados.porta, 6543)
        self.assertTrue(dados.pooler_transacional)

    def test_pooler_do_neon_tambem_e_reconhecido(self):
        self.assertTrue(analisar_dsn(DSN_NEON_POOLER).pooler_transacional)
        self.assertFalse(analisar_dsn(DSN_NEON_DIRETO).pooler_transacional)

    def test_forma_por_palavras_chave(self):
        dados = analisar_dsn("host=ep-x.sa-east-1.aws.neon.tech dbname=sacdb "
                             "user=sac_owner password=segredo sslmode=require")
        self.assertEqual(dados.host, "ep-x.sa-east-1.aws.neon.tech")
        self.assertEqual(dados.banco, "sacdb")
        self.assertEqual(dados.porta, 5432)
        self.assertTrue(dados.tem_senha)

    def test_a_senha_nunca_aparece_na_descricao(self):
        for dsn in (DSN_SUPABASE_DIRETO, DSN_SUPABASE_POOLER, DSN_NEON_DIRETO):
            self.assertNotIn(SENHA, analisar_dsn(dsn).descrever())

    def test_usuario_percent_encoded_e_decodificado(self):
        dados = analisar_dsn("postgresql://sac%40owner:x@db.aaaaaaaa.supabase.co/postgres")
        self.assertEqual(dados.usuario, "sac@owner")

    def test_recusa_entrada_invalida(self):
        invalidas = {
            "vazia": "   ",
            "esquema": "mysql://u:p@host/banco",
            "sem host": "postgresql://usuario@/banco",
            "sem banco": "postgresql://usuario@host:5432/",
            "sem usuario": "postgresql://host:5432/banco",
            "porta": "host=x dbname=y user=z port=abc",
            "quebra de linha": "postgresql://u:p@host/banco\nDROP",
            "irreconhecivel": "so-um-texto",
        }
        for rotulo, valor in invalidas.items():
            with self.subTest(rotulo):
                with self.assertRaises(PreparoError):
                    analisar_dsn(valor)

    def test_erro_de_parsing_nao_repete_o_dsn(self):
        with self.assertRaises(PreparoError) as capturado:
            analisar_dsn(f"mysql://postgres:{SENHA}@db.abcdefgh.supabase.co/postgres")
        self.assertNotIn(SENHA, str(capturado.exception))


# --------------------------------------------------------------------------- #
# 2. Decisao neon vs supabase
# --------------------------------------------------------------------------- #

class DecisaoDeDestinoTests(unittest.TestCase):
    def test_descoberta_pelo_host(self):
        casos = {
            DSN_SUPABASE_DIRETO: "supabase",
            DSN_SUPABASE_POOLER: "supabase",
            DSN_NEON_DIRETO: "neon",
            DSN_NEON_POOLER: "neon",
            "postgresql://u:p@127.0.0.1:5432/sacdb": "desconhecido",
            "postgresql://u:p@postgres-homologacao:5432/sacdb": "desconhecido",
        }
        for dsn, esperado in casos.items():
            with self.subTest(esperado):
                self.assertEqual(descobrir_destino(analisar_dsn(dsn)), esperado)

    def test_destino_declarado_igual_ao_detectado_passa(self):
        self.assertEqual(decidir_destino("neon", analisar_dsn(DSN_NEON_DIRETO)), "neon")
        self.assertEqual(
            decidir_destino("supabase", analisar_dsn(DSN_SUPABASE_POOLER)), "supabase")

    def test_host_desconhecido_nao_impede_o_destino_declarado(self):
        dados = analisar_dsn("postgresql://u:p@127.0.0.1:5432/sacdb")
        self.assertEqual(decidir_destino("neon", dados), "neon")

    def test_destino_divergente_e_recusado(self):
        dados = analisar_dsn(DSN_NEON_DIRETO)
        with self.assertRaises(PreparoError) as capturado:
            decidir_destino("supabase", dados)
        mensagem = str(capturado.exception)
        self.assertIn("neon", mensagem)
        self.assertNotIn(SENHA, mensagem)

    def test_divergencia_pode_ser_liberada_conscientemente(self):
        dados = analisar_dsn(DSN_NEON_DIRETO)
        self.assertEqual(
            decidir_destino("supabase", dados, permitir_divergencia=True), "supabase")

    def test_destino_fora_da_lista_e_recusado(self):
        with self.assertRaises(PreparoError):
            decidir_destino("render", analisar_dsn(DSN_NEON_DIRETO))


# --------------------------------------------------------------------------- #
# 3. Ordem de aplicacao
# --------------------------------------------------------------------------- #

class OrdemDeAplicacaoTests(unittest.TestCase):
    def test_ordem_minima_no_neon(self):
        nomes = [passo.nome for passo in montar_ordem("neon")]
        self.assertEqual(
            nomes, ["criar-roles-sac", "prerequisitos", "migration", "verificacao"])

    def test_grants_do_deployer_entram_entre_migration_e_verificacao(self):
        nomes = [passo.nome for passo in montar_ordem("neon", deployer_role="sac_deployer")]
        self.assertEqual(nomes.index("grants-deployer"), nomes.index("migration") + 1)
        self.assertEqual(nomes.index("verificacao"), nomes.index("grants-deployer") + 1)

    def test_supabase_acrescenta_endurecimento_no_fim_e_como_passo_humano(self):
        ordem = montar_ordem("supabase")
        nomes = [passo.nome for passo in ordem]
        self.assertEqual(nomes[-2:],
                         ["endurecer-postgrest", "remover-public-dos-exposed-schemas"])
        for passo in ordem[-2:]:
            self.assertFalse(passo.automatico)

    def test_neon_nao_recebe_passo_de_postgrest(self):
        nomes = [passo.nome for passo in montar_ordem("neon", deployer_role="sac_deployer")]
        self.assertNotIn("endurecer-postgrest", nomes)
        self.assertNotIn("remover-public-dos-exposed-schemas", nomes)

    def test_criacao_de_role_e_sempre_passo_humano(self):
        for destino in ("neon", "supabase"):
            primeiro = montar_ordem(destino)[0]
            self.assertEqual(primeiro.nome, "criar-roles-sac")
            self.assertFalse(primeiro.automatico)

    def test_destino_invalido_na_ordem(self):
        with self.assertRaises(PreparoError):
            montar_ordem("render")


# --------------------------------------------------------------------------- #
# 4. Recusas antes de aplicar
# --------------------------------------------------------------------------- #

class RecusasDePrerequisitoTests(unittest.TestCase):
    def test_banco_limpo_e_administrativo_libera(self):
        self.assertEqual(avaliar_prerequisitos(fatos_saudaveis()), ())

    def test_recusa_sem_createrole(self):
        recusas = avaliar_prerequisitos(fatos_saudaveis(pode_criar_role=False))
        self.assertEqual(codigos(recusas), ["sem-createrole"])
        self.assertIn("neon_superuser", recusas[0].como_corrigir)

    def test_superusuario_supre_a_falta_de_createrole(self):
        fatos = fatos_saudaveis(pode_criar_role=False, superusuario=True)
        self.assertEqual(avaliar_prerequisitos(fatos), ())

    def test_recusa_versao_anterior_a_15(self):
        recusas = avaliar_prerequisitos(
            fatos_saudaveis(versao_num=140012, versao_texto="14.12"))
        self.assertEqual(codigos(recusas), ["postgres-antigo"])
        self.assertIn("14.12", recusas[0].motivo)

    def test_versao_exatamente_no_minimo_passa(self):
        self.assertEqual(
            avaliar_prerequisitos(fatos_saudaveis(versao_num=VERSAO_MINIMA_NUM)), ())

    def test_recusa_sem_privilegio_de_create_no_banco(self):
        recusas = avaliar_prerequisitos(fatos_saudaveis(pode_criar_schema=False))
        self.assertEqual(codigos(recusas), ["sem-create-no-banco"])

    def test_recusa_control_plane_pela_metade(self):
        recusas = avaliar_prerequisitos(fatos_saudaveis(
            tabelas_controle=("sac_agents", "sac_tenants"),
            colunas_por_tabela={
                "sac_agents": COLUNAS_MINIMAS["sac_agents"],
                "sac_tenants": COLUNAS_MINIMAS["sac_tenants"],
            },
        ))
        self.assertEqual(codigos(recusas), ["control-plane-parcial"])
        self.assertIn("sac_channel_accounts", recusas[0].motivo)

    def test_control_plane_completo_e_intacto_nao_recusa(self):
        fatos = fatos_saudaveis(
            tabelas_controle=tuple(sorted(TABELAS_CONTROLE)),
            colunas_por_tabela={t: COLUNAS_MINIMAS[t] for t in TABELAS_CONTROLE},
        )
        self.assertEqual(avaliar_prerequisitos(fatos), ())

    def test_recusa_tabela_homonima_de_outro_sistema(self):
        fatos = fatos_saudaveis(
            tabelas_controle=tuple(sorted(TABELAS_CONTROLE)),
            colunas_por_tabela={
                **{t: COLUNAS_MINIMAS[t] for t in TABELAS_CONTROLE},
                "sac_agents": ("id", "nome"),
            },
        )
        recusas = avaliar_prerequisitos(fatos)
        self.assertIn("estrutura-conflitante", codigos(recusas))
        self.assertIn("sac_agents.schema_name", colunas_divergentes(fatos))

    def test_recusa_objeto_de_dono_inacessivel(self):
        fatos = fatos_saudaveis(
            tabelas_controle=tuple(sorted(TABELAS_CONTROLE)),
            colunas_por_tabela={t: COLUNAS_MINIMAS[t] for t in TABELAS_CONTROLE},
            tabelas_sem_dono_acessivel=("sac_agents",),
            funcoes_sem_dono_acessivel=("sac_provision_agent",),
        )
        recusas = avaliar_prerequisitos(fatos)
        self.assertEqual(codigos(recusas), ["dono-inacessivel"])
        self.assertIn("sac_provision_agent", recusas[0].motivo)

    def test_varias_recusas_saem_juntas(self):
        recusas = avaliar_prerequisitos(fatos_saudaveis(
            versao_num=130001, versao_texto="13.1",
            pode_criar_role=False, pode_criar_schema=False))
        self.assertEqual(codigos(recusas),
                         ["postgres-antigo", "sem-create-no-banco", "sem-createrole"])

    def test_fatos_vazios_recusam_tudo_em_vez_de_liberar(self):
        recusas = avaliar_prerequisitos(FatosDoBanco())
        self.assertIn("postgres-antigo", codigos(recusas))
        self.assertIn("sem-createrole", codigos(recusas))


# --------------------------------------------------------------------------- #
# 5. Verificacao pos-aplicacao
# --------------------------------------------------------------------------- #

class VerificacaoTests(unittest.TestCase):
    def test_verificacao_completa_passa(self):
        verificacao = Verificacao(tabelas=tuple(sorted(TABELAS_CONTROLE)),
                                  funcoes=tuple(sorted(FUNCOES_CONTROLE)))
        self.assertTrue(verificacao.ok)
        self.assertEqual(problemas_da_verificacao(verificacao), ())

    def test_tabela_ausente_reprova(self):
        verificacao = Verificacao(tabelas=("sac_agents",),
                                  funcoes=tuple(sorted(FUNCOES_CONTROLE)))
        self.assertFalse(verificacao.ok)
        self.assertIn("sac_tenants", problemas_da_verificacao(verificacao)[0])

    def test_grant_exposto_reprova_mesmo_com_tudo_instalado(self):
        verificacao = Verificacao(tabelas=tuple(sorted(TABELAS_CONTROLE)),
                                  funcoes=tuple(sorted(FUNCOES_CONTROLE)),
                                  grants_expostos=("anon:sac_agents:SELECT",))
        self.assertFalse(verificacao.ok)
        self.assertIn("anon:sac_agents:SELECT",
                      " ".join(problemas_da_verificacao(verificacao)))

    def test_execute_publico_em_funcao_pura_e_observacao_e_nao_reprovacao(self):
        verificacao = Verificacao(
            tabelas=tuple(sorted(TABELAS_CONTROLE)),
            funcoes=tuple(sorted(FUNCOES_CONTROLE)),
            observacoes=("PUBLIC:sac_secret_ref_valid():EXECUTE",))
        self.assertTrue(verificacao.ok)
        self.assertEqual(problemas_da_verificacao(verificacao), ())

    def test_resumir_encurta_lista_longa_sem_esconder_o_tamanho(self):
        self.assertEqual(resumir([]), "nenhum")
        self.assertEqual(resumir(["a", "b"]), "a, b")
        texto = resumir([str(numero) for numero in range(30)], limite=3)
        self.assertTrue(texto.startswith("0, 1, 2 ..."))
        self.assertIn("+27", texto)

    def test_grant_do_deployer_ausente_reprova(self):
        verificacao = Verificacao(tabelas=tuple(sorted(TABELAS_CONTROLE)),
                                  funcoes=tuple(sorted(FUNCOES_CONTROLE)),
                                  grants_deployer_faltando=("EXECUTE sac_provision_agent",))
        self.assertFalse(verificacao.ok)


# --------------------------------------------------------------------------- #
# 6. Fidelidade a 002_sac_roles.psql
# --------------------------------------------------------------------------- #

class GrantsDoDeployerTests(unittest.TestCase):
    def test_cada_grant_existe_identico_no_arquivo_psql(self):
        psql = (ROOT / "002_sac_roles.psql").read_text(encoding="utf-8")
        for gabarito in GRANTS_DEPLOYER:
            self.assertIn(gabarito, psql)

    def test_nenhum_grant_do_psql_ficou_de_fora(self):
        psql = (ROOT / "002_sac_roles.psql").read_text(encoding="utf-8")
        # Cada GRANT do arquivo abre com aspa simples dentro do format().
        self.assertEqual(psql.count("'GRANT "), len(GRANTS_DEPLOYER))


# --------------------------------------------------------------------------- #
# 7. Executor contra conexao falsa
# --------------------------------------------------------------------------- #

class ExecutorTests(unittest.TestCase):
    def test_coleta_de_fatos_le_versao_privilegio_e_estrutura(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS)
        fatos = ExecutorPostgres(conexao).coletar_fatos()
        self.assertEqual(fatos.versao_num, 160004)
        self.assertEqual(fatos.usuario, "postgres")
        self.assertTrue(fatos.pode_criar_role)
        self.assertTrue(fatos.pode_criar_schema)
        self.assertFalse(fatos.superusuario)
        self.assertEqual(fatos.tabelas_controle, tuple(sorted(TABELAS_CONTROLE)))
        self.assertEqual(tuple(sorted(fatos.funcoes)), tuple(sorted(FUNCOES_CONTROLE)))
        self.assertEqual(fatos.tabelas_sem_dono_acessivel, ())

    def test_consulta_sem_parametro_nao_recebe_tupla_vazia(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS)
        ExecutorPostgres(conexao).coletar_fatos()
        for query, params in conexao.executadas:
            if params is not None:
                self.assertNotEqual(params, ())

    def test_migration_errada_e_recusada_antes_de_executar(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS)
        with self.assertRaises(PreparoError):
            ExecutorPostgres(conexao).aplicar_migration("SELECT 1;")
        self.assertEqual(conexao.executadas, [])
        self.assertEqual(conexao.commits, 0)

    def test_migration_correta_roda_em_transacao_unica(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS)
        sql = (ROOT / "002_sac_multiagent_v2.sql").read_text(encoding="utf-8")
        ExecutorPostgres(conexao).aplicar_migration(sql)
        self.assertEqual(len(conexao.executadas), 1)
        self.assertEqual(conexao.commits, 1)
        self.assertEqual(conexao.rollbacks, 0)

    def test_falha_na_migration_faz_rollback_e_propaga(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS, falhar_em="CREATE TABLE IF NOT EXISTS")
        sql = (ROOT / "002_sac_multiagent_v2.sql").read_text(encoding="utf-8")
        with self.assertRaises(RuntimeError):
            ExecutorPostgres(conexao).aplicar_migration(sql)
        self.assertEqual(conexao.rollbacks, 1)
        self.assertEqual(conexao.commits, 0)

    def test_grants_do_deployer_citam_a_role_no_servidor(self):
        respostas = dict(RESPOSTAS_PRONTAS)
        respostas["pg_catalog.format(%s::text, %s::text)"] = lambda params: [
            (params[0].replace("%I", '"' + params[1] + '"'),)
        ]
        conexao = ConexaoFalsa(respostas)
        emitidos = ExecutorPostgres(conexao).aplicar_grants_deployer("sac_deployer")
        self.assertEqual(len(emitidos), len(GRANTS_DEPLOYER))
        executadas = [query for query, _ in conexao.executadas]
        self.assertTrue(any('TO "sac_deployer"' in query for query in executadas))
        # O nome da role vai como PARAMETRO para format(), nunca concatenado.
        for query, params in conexao.executadas:
            if "pg_catalog.format" in query:
                self.assertIn("sac_deployer", params)
                self.assertNotIn("sac_deployer", query)
        self.assertEqual(conexao.commits, 1)

    def test_role_de_deploy_inexistente_nao_emite_grant(self):
        respostas = dict(RESPOSTAS_PRONTAS)
        respostas["pg_catalog.format(%s::text, %s::text)"] = []
        conexao = ConexaoFalsa(respostas)
        self.assertEqual(ExecutorPostgres(conexao).aplicar_grants_deployer("sac_deployer"), ())

    def test_nome_de_role_de_deploy_invalido_e_recusado(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS)
        for invalido in ("sac deployer", 'role"; DROP SCHEMA public CASCADE --', ""):
            with self.subTest(invalido):
                with self.assertRaises(PreparoError):
                    ExecutorPostgres(conexao).aplicar_grants_deployer(invalido)
        self.assertEqual(conexao.executadas, [])

    def test_verificacao_aprova_banco_recem_preparado(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS)
        verificacao = ExecutorPostgres(conexao).verificar()
        self.assertTrue(verificacao.ok)
        self.assertEqual(verificacao.grants_expostos, ())

    def test_verificacao_denuncia_grant_para_anon(self):
        respostas = dict(RESPOSTAS_PRONTAS)
        respostas["role_table_grants"] = [("anon", "sac_agents", "SELECT")]
        respostas["r.oid = a.grantee"] = [
            ("sac_provision_agent", "anon")]
        conexao = ConexaoFalsa(respostas)
        verificacao = ExecutorPostgres(conexao).verificar()
        self.assertFalse(verificacao.ok)
        self.assertIn("anon:sac_agents:SELECT", verificacao.grants_expostos)
        self.assertIn("anon:sac_provision_agent():EXECUTE", verificacao.grants_expostos)

    def test_verificacao_denuncia_execute_para_public(self):
        respostas = dict(RESPOSTAS_PRONTAS)
        respostas["a.grantee = 0"] = [("sac_activate_agent",)]
        verificacao = ExecutorPostgres(ConexaoFalsa(respostas)).verificar()
        self.assertIn("PUBLIC:sac_activate_agent():EXECUTE", verificacao.grants_expostos)
        self.assertFalse(verificacao.ok)

    def test_execute_publico_em_funcao_pura_nao_reprova_o_neon(self):
        # É o padrão do PostgreSQL para qualquer função; sem PostgREST na frente
        # não expõe dado nenhum. Vira observação, não reprovação.
        respostas = dict(RESPOSTAS_PRONTAS)
        respostas["a.grantee = 0"] = [("sac_secret_ref_valid",),
                                      ("sac_json_contains_secret_key",)]
        verificacao = ExecutorPostgres(ConexaoFalsa(respostas)).verificar()
        self.assertEqual(verificacao.grants_expostos, ())
        self.assertEqual(len(verificacao.observacoes), 2)
        self.assertTrue(verificacao.ok)

    def test_privilegios_da_mesma_tabela_saem_agrupados(self):
        respostas = dict(RESPOSTAS_PRONTAS)
        respostas["role_table_grants"] = [("anon", "sac_agents", p)
                                          for p in ("SELECT", "INSERT", "DELETE")]
        verificacao = ExecutorPostgres(ConexaoFalsa(respostas)).verificar()
        self.assertEqual(verificacao.grants_expostos,
                         ("anon:sac_agents:DELETE/INSERT/SELECT",))

    def test_verificacao_aponta_roles_do_sac_ainda_ausentes(self):
        conexao = ConexaoFalsa(RESPOSTAS_PRONTAS)
        verificacao = ExecutorPostgres(conexao).verificar(
            roles_sac=("sac_owner", "sac_app", "sac_worker"))
        self.assertEqual(verificacao.roles_sac_ausentes,
                         ("sac_app", "sac_owner", "sac_worker"))


# --------------------------------------------------------------------------- #
# 8. Relatorio
# --------------------------------------------------------------------------- #

class RelatorioTests(unittest.TestCase):
    def _relatorio(self, **mudancas):
        argumentos = dict(
            destino="neon", dados=analisar_dsn(DSN_NEON_DIRETO),
            ordem=montar_ordem("neon"), fatos=fatos_saudaveis(), recusas=(),
            aplicado=False, verificacao=None,
        )
        argumentos.update(mudancas)
        return montar_relatorio(**argumentos)

    def test_relatorio_nunca_carrega_a_senha(self):
        texto = self._relatorio(
            destino="supabase", dados=analisar_dsn(DSN_SUPABASE_POOLER),
            ordem=montar_ordem("supabase"), aplicado=True,
            verificacao=Verificacao(tabelas=tuple(sorted(TABELAS_CONTROLE)),
                                    funcoes=tuple(sorted(FUNCOES_CONTROLE))))
        self.assertNotIn(SENHA, texto)

    def test_recusa_deixa_claro_que_nada_foi_aplicado(self):
        recusas = avaliar_prerequisitos(fatos_saudaveis(pode_criar_role=False))
        texto = self._relatorio(fatos=fatos_saudaveis(pode_criar_role=False),
                                recusas=recusas)
        self.assertIn("RECUSADO", texto)
        self.assertIn("nada foi aplicado", texto)
        self.assertIn("sem-createrole", texto)
        self.assertNotIn("verificacao pos-aplicacao", texto)

    def test_diagnostico_avisa_que_falta_aplicar(self):
        self.assertIn("--aplicar", self._relatorio())

    def test_supabase_lembra_do_endurecimento_manual(self):
        texto = self._relatorio(
            destino="supabase", dados=analisar_dsn(DSN_SUPABASE_DIRETO),
            ordem=montar_ordem("supabase"), aplicado=True,
            verificacao=Verificacao(tabelas=tuple(sorted(TABELAS_CONTROLE)),
                                    funcoes=tuple(sorted(FUNCOES_CONTROLE))))
        self.assertIn("scripts/supabase-endurecer.sql", texto)
        self.assertIn("Exposed schemas", texto)

    def test_neon_nao_pede_endurecimento_de_postgrest(self):
        texto = self._relatorio(
            aplicado=True,
            verificacao=Verificacao(tabelas=tuple(sorted(TABELAS_CONTROLE)),
                                    funcoes=tuple(sorted(FUNCOES_CONTROLE))))
        self.assertNotIn("Exposed schemas", texto)
        self.assertIn("Nao ha PostgREST", texto)

    def test_relatorio_lista_a_ordem_marcando_o_passo_humano(self):
        texto = self._relatorio(ordem=montar_ordem("supabase"),
                                destino="supabase",
                                dados=analisar_dsn(DSN_SUPABASE_DIRETO))
        self.assertIn("[MAO HUMANA] criar-roles-sac", texto)
        self.assertIn("[auto] migration", texto)


# --------------------------------------------------------------------------- #
# 9. CLI
# --------------------------------------------------------------------------- #

class CliTests(unittest.TestCase):
    CAMINHO = ROOT / "scripts" / "preparar-banco-sac.py"

    def _rodar(self, argumentos, ambiente=None):
        env = dict(os.environ)
        env.pop("SAC_DATABASE_URL", None)
        env.update(ambiente or {})
        return subprocess.run([sys.executable, str(self.CAMINHO), *argumentos],
                              capture_output=True, text=True, env=env, cwd=str(ROOT))

    def test_variavel_de_ambiente_ausente_falha_fechado(self):
        saida = self._rodar(["--destino", "neon"])
        self.assertEqual(saida.returncode, 2)
        self.assertIn("SAC_DATABASE_URL", saida.stderr)

    def test_dsn_na_linha_de_comando_e_recusado(self):
        saida = self._rodar(["--destino", "neon", "--database-url-env", DSN_NEON_DIRETO])
        self.assertEqual(saida.returncode, 2)
        self.assertNotIn(SENHA, saida.stdout + saida.stderr)

    def test_destino_divergente_para_antes_de_conectar(self):
        saida = self._rodar(["--destino", "supabase"],
                            ambiente={"SAC_DATABASE_URL": DSN_NEON_DIRETO})
        self.assertEqual(saida.returncode, 2)
        self.assertIn("neon", saida.stderr)
        self.assertNotIn(SENHA, saida.stdout + saida.stderr)

    def test_destino_e_obrigatorio(self):
        saida = self._rodar([])
        self.assertEqual(saida.returncode, 2)

    def test_ajuda_aponta_o_arquivo_de_endurecimento(self):
        saida = self._rodar(["--help"])
        self.assertEqual(saida.returncode, 0)
        self.assertIn("supabase-endurecer.sql", saida.stdout)


# --------------------------------------------------------------------------- #
# 10. Endurecimento do Supabase (leitura estatica do arquivo)
# --------------------------------------------------------------------------- #

class EndurecimentoSupabaseTests(unittest.TestCase):
    def setUp(self):
        self.sql = (ROOT / "scripts" / "supabase-endurecer.sql").read_text(encoding="utf-8")

    def test_cobre_as_quatro_tabelas_de_controle(self):
        for tabela in TABELAS_CONTROLE:
            self.assertIn(tabela, self.sql)

    def test_cobre_as_funcoes_sensiveis(self):
        for funcao in FUNCOES_CONTROLE:
            self.assertIn(funcao, self.sql)

    def test_revoga_das_roles_expostas_e_de_public(self):
        self.assertIn("'anon', 'authenticated'", self.sql)
        self.assertIn("FROM PUBLIC", self.sql)

    def test_nao_forca_rls_no_dono_porque_quebraria_o_provisionador(self):
        # FORCE ROW LEVEL SECURITY sem policy travaria sac_provision_agent.
        for linha in self.sql.splitlines():
            if "FORCE ROW LEVEL SECURITY" in linha:
                self.assertTrue(linha.strip().startswith("--"), linha)

    def test_secoes_agressivas_ficam_comentadas(self):
        for linha in self.sql.splitlines():
            if "REVOKE USAGE ON SCHEMA public" in linha:
                self.assertTrue(linha.strip().startswith("--"), linha)
            if "FROM service_role" in linha:
                self.assertTrue(linha.strip().startswith("--"), linha)

    def test_documenta_o_passo_que_nao_da_para_fazer_por_sql(self):
        self.assertIn("Exposed schemas", self.sql)
        self.assertIn("NOTIFY pgrst", self.sql)

    def test_nao_e_aplicado_pelo_script_de_preparo(self):
        script = (ROOT / "scripts" / "preparar-banco-sac.py").read_text(encoding="utf-8")
        self.assertNotIn("supabase-endurecer.sql", script.replace(
            "ARQUIVO_ENDURECIMENTO", ""))
        modulo = (ROOT / "backend" / "preparo_banco.py").read_text(encoding="utf-8")
        self.assertEqual(modulo.count('ARQUIVO_ENDURECIMENTO = "scripts/supabase-endurecer.sql"'), 1)


if __name__ == "__main__":
    unittest.main()
