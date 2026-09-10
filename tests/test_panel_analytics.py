"""Analytics do painel: janela, fuso, isolamento, agregacao e zero vazamento.

O que estes testes provam, em ordem: a janela tem teto e recusa entrada
absurda; a agregacao diaria acontece no fuso configurado e nao em UTC; toda
consulta carrega tenant/agente do construtor da loja; nenhum relatorio escreve
no banco; nenhuma resposta carrega segredo, telefone, e-mail ou texto de
mensagem; e um cliente sem dado nenhum recebe zero, nunca erro nem divisao por
zero.
"""

import io
import json
import unittest
from collections import deque
from datetime import date, datetime, timezone

from backend.panel_analytics import (AnalyticsCache, AnalyticsWindow, ComputationBudget,
                                     DEFAULT_TIMEZONE, MAX_WINDOW_DAYS, delta, mask_pii,
                                     percentage, resolve_window)
from backend.panel_api import PanelAgent, PanelApplication, SESSION_COOKIE
from backend.panel_auth import (LoginThrottle, MIN_ITERATIONS, OperatorDirectory, SessionStore,
                                hash_password)
from backend.postgres_store import PostgresStore

TENANT, AGENT, SCHEMA = "dr-lucas", "atendimento", "sac_dr_lucas"
SENHA = "senha-de-homologacao-1"
HASH = hash_password(SENHA, iterations=MIN_ITERATIONS)
AGORA = datetime(2026, 9, 10, 2, 0, tzinfo=timezone.utc)  # 09/09 23h em Brasilia

PROIBIDO = ("secret", "password", "passwordhash", "pbkdf2", "access_token", "api_key",
            "last_error", "payload", "body", "external_user_id", "@exemplo.com",
            "5511987654321", "senha")

LUCAS = PanelAgent("dr-lucas", "atendimento", "sac_dr_lucas", "Dr. Lucas", "Atendimento",
                   "provisioned", ())
BELLA = PanelAgent("bella-franklin", "atendimento", "sac_bella_franklin", "Bella Franklin",
                   "Atendimento", "provisioned", ())

CADASTRO = json.dumps({"operators": [
    {"id": "gastao", "displayName": "Gastao", "passwordHash": HASH,
     "agents": [{"tenantId": "dr-lucas", "agentId": "atendimento"}]},
    {"id": "operadora-b", "displayName": "Operadora B", "passwordHash": HASH,
     "agents": [{"tenantId": "bella-franklin", "agentId": "atendimento"}]},
]})


# --------------------------------------------------------------------- fakes

class FakeCursor:
    def __init__(self, results=()):
        self.results = deque(results)
        self.executions = []
        self.rowcount = 1

    def execute(self, query, params=()):
        self.executions.append((" ".join(query.split()), tuple(params)))
        return self

    def fetchone(self):
        return None

    def fetchall(self):
        return self.results.popleft() if self.results else []

    def close(self):
        pass


class FakeConnection:
    def __init__(self, results=()):
        self.cur = FakeCursor(results)
        self.commits = 0
        self.rollbacks = 0
        self.closed = 0

    def cursor(self):
        return self.cur

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed += 1


def store(results=()):
    conexao = FakeConnection(results)
    return PostgresStore(lambda: conexao, tenant_id=TENANT, agent_id=AGENT,
                         schema=SCHEMA), conexao


def janela(period="7d", tz=DEFAULT_TIMEZONE):
    return resolve_window(period=period, timezone_name=tz, now=AGORA)


# ------------------------------------------------------------------- janela

class JanelaTests(unittest.TestCase):
    def test_periodo_padrao_e_de_trinta_dias_no_fuso_de_brasilia(self):
        w = resolve_window(now=AGORA)
        self.assertEqual((w.period, w.days, w.timezone_name), ("30d", 30, DEFAULT_TIMEZONE))
        self.assertEqual(w.last_day, date(2026, 9, 9))
        self.assertEqual(w.first_day, date(2026, 8, 11))

    def test_virada_do_dia_usa_o_fuso_pedido_e_nao_utc(self):
        # 2026-09-10T02:00Z ainda e 09/09 as 23h em Brasilia. Se a agregacao
        # fosse em UTC o grafico do cliente comecaria e terminaria um dia adiante.
        brasilia = resolve_window(period="1d", now=AGORA)
        utc = resolve_window(period="1d", timezone_name="UTC", now=AGORA)
        self.assertEqual(brasilia.first_day, date(2026, 9, 9))
        self.assertEqual(utc.first_day, date(2026, 9, 10))
        self.assertEqual(brasilia.public()["startsAt"], "2026-09-09T03:00:00Z")
        self.assertEqual(brasilia.public()["endsAt"], "2026-09-10T03:00:00Z")
        self.assertEqual(utc.public()["startsAt"], "2026-09-10T00:00:00Z")

    def test_de_e_ate_sao_dias_locais_inclusivos(self):
        w = resolve_window(since="2026-09-01", until="2026-09-03", now=AGORA)
        self.assertEqual((w.days, w.period), (3, None))
        self.assertEqual(w.day_keys(), ["2026-09-01", "2026-09-02", "2026-09-03"])
        self.assertEqual(w.public()["endsAt"], "2026-09-04T03:00:00Z")

    def test_periodo_anterior_tem_o_mesmo_tamanho_e_encosta_na_janela(self):
        w = resolve_window(since="2026-09-01", until="2026-09-10", now=AGORA)
        anterior = w.previous
        self.assertEqual(anterior.days, w.days)
        self.assertEqual(anterior.last_day, date(2026, 8, 31))
        self.assertEqual(anterior.first_day, date(2026, 8, 22))

    def test_janela_absurda_e_recusada(self):
        casos = [
            {"since": "2015-01-01", "until": "2026-09-10"},   # 11 anos
            {"period": "365d", "max_days": 90},               # acima do teto local
            {"since": "2026-09-10", "until": "2026-09-01"},   # invertida
            {"period": "tudo"},                               # periodo inexistente
            {"since": "ontem"},                               # data que nao e data
            {"until": "2026-13-45"},                          # data impossivel
            {"period": "7d", "since": "2026-09-01"},          # dois contratos juntos
            {"timezone_name": "Marte/Olimpo"},                # fuso inexistente
            {"timezone_name": "../../etc/passwd"},            # travessia de caminho
        ]
        for caso in casos:
            with self.subTest(caso=caso):
                with self.assertRaises(ValueError):
                    resolve_window(now=AGORA, **caso)

    def test_teto_absoluto_vale_mesmo_com_de_e_ate(self):
        with self.assertRaises(ValueError):
            resolve_window(since="2020-01-01", until="2021-12-31", now=AGORA)
        maxima = resolve_window(since="2026-01-01", until="2026-01-01", now=AGORA)
        self.assertEqual(maxima.days, 1)
        self.assertLessEqual(MAX_WINDOW_DAYS, 366)

    def test_construtor_da_janela_tambem_recusa_intervalo_grande(self):
        with self.assertRaises(ValueError):
            AnalyticsWindow(date(2020, 1, 1), date(2026, 1, 1), DEFAULT_TIMEZONE)

    def test_chave_de_cache_separa_fuso_e_intervalo(self):
        a = resolve_window(since="2026-09-01", until="2026-09-02", now=AGORA)
        b = resolve_window(since="2026-09-01", until="2026-09-02",
                           timezone_name="UTC", now=AGORA)
        self.assertNotEqual(a.cache_key(), b.cache_key())


# ---------------------------------------------------------------- aritmetica

class AritmeticaTests(unittest.TestCase):
    def test_participacao_com_base_zero_nao_divide_por_zero(self):
        self.assertIsNone(percentage(0, 0))
        self.assertIsNone(percentage(5, 0))
        self.assertEqual(percentage(1, 4), 25.0)

    def test_delta_com_periodo_anterior_vazio_deixa_percentual_nulo(self):
        self.assertEqual(delta(10, 0),
                         {"current": 10, "previous": 0, "absolute": 10, "percent": None})
        self.assertEqual(delta(15, 10)["percent"], 50.0)
        self.assertEqual(delta(5, 10)["percent"], -50.0)
        self.assertEqual(delta(None, None)["current"], 0)

    def test_mascara_remove_email_e_telefone_e_preserva_data(self):
        self.assertEqual(mask_pii("cliente joao@exemplo.com.br"), "cliente ***")
        self.assertEqual(mask_pii("whatsapp +55 11 98765-4321"), "whatsapp ***")
        self.assertEqual(mask_pii("Kiwify · carrinho 2026-09-09"), "Kiwify · carrinho 2026-09-09")
        self.assertEqual(mask_pii("campanha bf2026"), "campanha bf2026")
        self.assertIsNone(mask_pii(None))


# --------------------------------------------------------------------- cache

class CacheTests(unittest.TestCase):
    def relogio(self):
        marcador = {"t": 0.0}
        return marcador, (lambda: marcador["t"])

    def test_cache_devolve_a_mesma_janela_e_expira_no_ttl(self):
        marcador, relogio = self.relogio()
        cache = AnalyticsCache(ttl_seconds=60, clock=relogio)
        cache.put(("dr-lucas", "atendimento", "overview"), {"totals": {"messages": 3}})
        self.assertEqual(cache.get(("dr-lucas", "atendimento", "overview"))["totals"]["messages"], 3)
        marcador["t"] = 61.0
        self.assertIsNone(cache.get(("dr-lucas", "atendimento", "overview")))

    def test_cache_nunca_cruza_tenant(self):
        cache = AnalyticsCache()
        cache.put(("dr-lucas", "atendimento", "overview"), {"totals": 1})
        self.assertIsNone(cache.get(("bella-franklin", "atendimento", "overview")))

    def test_cache_tem_teto_de_entradas(self):
        cache = AnalyticsCache(max_entries=2)
        for indice in range(5):
            cache.put(("t", "a", f"r{indice}"), {"n": indice})
        self.assertLessEqual(cache.size(), 2)

    def test_orcamento_limita_calculo_novo_por_agente_e_renova_na_janela(self):
        marcador, relogio = self.relogio()
        orcamento = ComputationBudget(max_computations=2, window_seconds=60, clock=relogio)
        self.assertTrue(orcamento.allow(("dr-lucas", "atendimento")))
        self.assertTrue(orcamento.allow(("dr-lucas", "atendimento")))
        self.assertFalse(orcamento.allow(("dr-lucas", "atendimento")))
        # Outro agente tem orcamento proprio.
        self.assertTrue(orcamento.allow(("bella-franklin", "atendimento")))
        marcador["t"] = 61.0
        self.assertTrue(orcamento.allow(("dr-lucas", "atendimento")))


# ---------------------------------------------------------- consultas na loja

class ConsultaTests(unittest.TestCase):
    """Toda consulta e presa ao escopo do construtor e nunca faz commit."""

    RELATORIOS = ("analytics_overview", "analytics_channels", "analytics_origins",
                  "analytics_pipeline", "analytics_response_times", "analytics_health",
                  "analytics_operators")

    def test_todo_relatorio_leva_tenant_e_agente_do_construtor(self):
        for nome in self.RELATORIOS:
            with self.subTest(relatorio=nome):
                loja, conexao = store()
                getattr(loja, nome)(janela())
                self.assertTrue(conexao.cur.executions)
                for consulta, parametros in conexao.cur.executions:
                    self.assertIn(f'"{SCHEMA}".', consulta)
                    self.assertIn(TENANT, parametros)
                    self.assertIn(AGENT, parametros)

    def test_nenhum_relatorio_escreve_no_banco(self):
        for nome in self.RELATORIOS:
            with self.subTest(relatorio=nome):
                loja, conexao = store()
                getattr(loja, nome)(janela())
                self.assertEqual(conexao.commits, 0)
                self.assertGreaterEqual(conexao.rollbacks, 1)
                for consulta, _ in conexao.cur.executions:
                    alto = consulta.upper()
                    for verbo in ("INSERT ", "UPDATE ", "DELETE ", "TRUNCATE", "CREATE ",
                                  "ALTER ", "DROP ", "FOR UPDATE"):
                        self.assertNotIn(verbo, alto)

    def test_nenhuma_consulta_seleciona_conteudo_ou_segredo(self):
        for nome in self.RELATORIOS:
            with self.subTest(relatorio=nome):
                loja, conexao = store()
                getattr(loja, nome)(janela())
                consultas = " ".join(sql for sql, _ in conexao.cur.executions)
                for proibida in ("secret_ref", "m.body", "last_error", "o.payload",
                                 "external_user_id", "display_name", "normalized_value",
                                 "SELECT *"):
                    self.assertNotIn(proibida, consultas)

    def test_agregacao_diaria_passa_o_fuso_como_parametro(self):
        loja, conexao = store()
        loja.analytics_overview(janela(tz="UTC"))
        consultas = [(sql, params) for sql, params in conexao.cur.executions
                     if "AT TIME ZONE %s" in sql]
        self.assertTrue(consultas)
        for _, parametros in consultas:
            self.assertIn("UTC", parametros)

    def test_limites_da_janela_viram_intervalo_semiaberto_em_utc(self):
        loja, conexao = store()
        w = resolve_window(since="2026-09-01", until="2026-09-01", now=AGORA)
        loja.analytics_overview(w)
        _, parametros = conexao.cur.executions[0]
        self.assertIn(w.starts_at, parametros)
        self.assertIn(w.ends_at, parametros)
        self.assertEqual(w.ends_at.isoformat(), "2026-09-02T03:00:00+00:00")
        consulta = conexao.cur.executions[0][0]
        self.assertIn("m.occurred_at >= %s AND m.occurred_at < %s", consulta)

    def test_cliente_novo_sem_dado_nenhum_recebe_zero_e_nao_erro(self):
        for nome in self.RELATORIOS:
            with self.subTest(relatorio=nome):
                loja, _ = store()
                resposta = getattr(loja, nome)(janela())
                self.assertIn("window", resposta)
                self.assertIn("generatedAt", resposta)
                json.dumps(resposta)  # precisa ser serializavel como esta
        loja, _ = store()
        vazio = loja.analytics_overview(janela())
        self.assertEqual(vazio["totals"]["messages"], 0)
        self.assertEqual(vazio["totals"]["messagesPerConversation"], 0.0)
        self.assertEqual(vazio["delta"]["messages"]["percent"], None)
        self.assertEqual(len(vazio["series"]), 7)
        self.assertEqual({item["messages"] for item in vazio["series"]}, {0})


class OverviewTests(unittest.TestCase):
    TOTAIS = {"mensagens": 100, "entrada": 60, "saida": 40, "conversas": 8,
              "contatos": 5, "conversas_novas": 3, "contatos_novos": 2}
    ANTERIOR = {"mensagens": 50, "entrada": 30, "saida": 20, "conversas": 4,
                "contatos": 4, "conversas_novas": 4, "contatos_novos": 4}

    def montar(self, serie=(), novos=()):
        return store([[dict(self.TOTAIS)], [dict(self.ANTERIOR)], list(serie), list(novos)])

    def test_totais_separam_conversas_novas_de_recorrentes(self):
        loja, _ = self.montar()
        totais = loja.analytics_overview(janela())["totals"]
        self.assertEqual(totais["conversations"], 8)
        self.assertEqual(totais["newConversations"], 3)
        self.assertEqual(totais["returningConversations"], 5)
        self.assertEqual(totais["contacts"], 5)
        self.assertEqual(totais["newContacts"], 2)
        self.assertEqual(totais["returningContacts"], 3)
        self.assertEqual(totais["inboundMessages"], 60)
        self.assertEqual(totais["outboundMessages"], 40)
        self.assertEqual(totais["messagesPerConversation"], 12.5)

    def test_comparacao_com_periodo_anterior(self):
        loja, _ = self.montar()
        relatorio = loja.analytics_overview(janela())
        self.assertEqual(relatorio["previous"]["messages"], 50)
        self.assertEqual(relatorio["delta"]["messages"],
                         {"current": 100, "previous": 50, "absolute": 50, "percent": 100.0})
        self.assertEqual(relatorio["delta"]["contacts"]["percent"], 25.0)

    def test_serie_diaria_nao_tem_buraco_e_soma_novos_no_dia_certo(self):
        serie = [{"dia": date(2026, 9, 5), "mensagens": 10, "entrada": 6, "saida": 4,
                  "conversas": 2, "contatos": 2}]
        novos = [{"dia": date(2026, 9, 5), "conversas": 1, "contatos": 1}]
        loja, _ = self.montar(serie, novos)
        pontos = loja.analytics_overview(janela())["series"]
        self.assertEqual(len(pontos), 7)
        self.assertEqual([ponto["date"] for ponto in pontos][0], "2026-09-03")
        quinto = next(ponto for ponto in pontos if ponto["date"] == "2026-09-05")
        self.assertEqual(quinto["messages"], 10)
        self.assertEqual(quinto["newConversations"], 1)
        vazio = next(ponto for ponto in pontos if ponto["date"] == "2026-09-06")
        self.assertEqual((vazio["messages"], vazio["newConversations"]), (0, 0))

    def test_dia_local_vem_do_banco_ja_no_fuso_pedido(self):
        # A linha chega como data local: 09/09 23h de Brasilia entra em 09/09.
        serie = [{"dia": date(2026, 9, 9), "mensagens": 4, "entrada": 4, "saida": 0,
                  "conversas": 1, "contatos": 1}]
        loja, _ = self.montar(serie)
        pontos = loja.analytics_overview(janela())["series"]
        self.assertEqual(pontos[-1]["date"], "2026-09-09")
        self.assertEqual(pontos[-1]["messages"], 4)


class CanalTests(unittest.TestCase):
    def montar(self, atual, anterior=(), serie=()):
        return store([list(atual), list(anterior), list(serie)])

    def linha(self, canal, **valores):
        base = {"canal": canal, "mensagens": 0, "entrada": 0, "saida": 0, "conversas": 0,
                "contatos": 0, "conversas_novas": 0}
        base.update(valores)
        return base

    def test_participacao_por_canal_usa_o_total_geral(self):
        loja, _ = self.montar([
            self.linha(None, mensagens=100, conversas=10, contatos=8),
            self.linha("whatsapp", mensagens=75, conversas=6, contatos=5, conversas_novas=2),
            self.linha("instagram", mensagens=25, conversas=4, contatos=4),
        ])
        canais = {item["channel"]: item for item in loja.analytics_channels(janela())["channels"]}
        self.assertEqual(canais["whatsapp"]["share"]["messages"], 75.0)
        self.assertEqual(canais["whatsapp"]["share"]["conversations"], 60.0)
        self.assertEqual(canais["whatsapp"]["returningConversations"], 4)
        self.assertEqual(canais["instagram"]["share"]["messages"], 25.0)

    def test_canal_sem_movimento_aparece_zerado_e_nao_some(self):
        loja, _ = self.montar([self.linha(None, mensagens=10, conversas=1),
                               self.linha("whatsapp", mensagens=10, conversas=1)])
        relatorio = loja.analytics_channels(janela())
        canais = {item["channel"]: item for item in relatorio["channels"]}
        self.assertEqual(sorted(canais), ["email", "instagram", "whatsapp"])
        self.assertEqual(canais["email"]["messages"], 0)
        self.assertEqual(canais["email"]["share"]["messages"], 0.0)
        self.assertEqual(len(canais["email"]["series"]), 7)

    def test_sem_dado_nenhum_a_participacao_fica_nula_sem_erro(self):
        loja, _ = self.montar([])
        relatorio = loja.analytics_channels(janela())
        self.assertEqual(relatorio["totals"]["messages"], 0)
        for item in relatorio["channels"]:
            self.assertIsNone(item["share"]["messages"])


class OrigemTests(unittest.TestCase):
    def test_origem_e_agregada_por_slug_e_nunca_vira_canal(self):
        totais = [{"data": {"platform": "Kiwify", "source": "carrinho abandonado",
                            "channel": "whatsapp", "campaign": "bf"},
                   "contatos": 3, "registros": 4,
                   "primeiro": datetime(2026, 9, 1, tzinfo=timezone.utc),
                   "ultimo": datetime(2026, 9, 8, tzinfo=timezone.utc)},
                  {"data": {"slug": "kiwify_carrinho_abandonado", "platform": "Kiwify",
                            "source": "carrinho abandonado"},
                   "contatos": 1, "registros": 1,
                   "primeiro": datetime(2026, 8, 30, tzinfo=timezone.utc),
                   "ultimo": datetime(2026, 9, 9, tzinfo=timezone.utc)},
                  {"data": {}, "contatos": 2, "registros": 2, "primeiro": None, "ultimo": None}]
        atividade = [{"data": {"platform": "Kiwify", "source": "carrinho abandonado"},
                      "conversas": 5, "mensagens": 40}]
        loja, _ = store([totais, atividade])
        relatorio = loja.analytics_origins(janela())
        origens = {item["slug"]: item for item in relatorio["origins"]}
        kiwify = origens["kiwify_carrinho_abandonado"]
        self.assertEqual(kiwify["contacts"], 4)
        self.assertEqual(kiwify["records"], 5)
        self.assertEqual(kiwify["conversations"], 5)
        self.assertEqual(kiwify["messages"], 40)
        self.assertEqual(kiwify["firstSeenAt"], "2026-08-30T00:00:00Z")
        self.assertEqual(kiwify["lastSeenAt"], "2026-09-09T00:00:00Z")
        # canal declarado pela origem, nao o canal da conversa
        self.assertEqual(kiwify["channel"], "whatsapp")
        self.assertEqual(origens["origem_nao_identificada"]["contacts"], 2)
        self.assertIsNone(origens["origem_nao_identificada"]["channel"])
        self.assertEqual(relatorio["totals"]["contacts"], 6)
        self.assertEqual(relatorio["totals"]["identifiedContacts"], 4)
        self.assertEqual(relatorio["totals"]["unidentifiedContacts"], 2)
        self.assertEqual(kiwify["share"]["contacts"], 66.67)

    def test_rotulo_de_origem_sai_mascarado(self):
        totais = [{"data": {"label": "lead joao@exemplo.com tel +55 11 98765-4321",
                            "platform": "Meta", "source": "ads"},
                   "contatos": 1, "registros": 1, "primeiro": None, "ultimo": None}]
        loja, _ = store([totais, []])
        origem = loja.analytics_origins(janela())["origins"][0]
        texto = json.dumps(origem)
        self.assertNotIn("joao@exemplo.com", texto)
        self.assertNotIn("98765-4321", texto)
        self.assertIn("***", origem["label"])

    def test_sem_origem_nenhuma_o_relatorio_vem_vazio_e_valido(self):
        loja, _ = store([[], []])
        relatorio = loja.analytics_origins(janela())
        self.assertEqual(relatorio["origins"], [])
        self.assertIsNone(relatorio["totals"]["identifiedShare"])
        self.assertFalse(relatorio["truncated"])


class PipelineTests(unittest.TestCase):
    def montar(self, atuais=(), movimentos=(), duracoes=()):
        return store([list(atuais), list(movimentos), list(duracoes)])

    def test_funil_conta_estoque_entrada_saida_e_conversao(self):
        atuais = [{"etapa": "novo_contato", "contatos": 10},
                  {"etapa": "em_atendimento", "contatos": 4}]
        movimentos = [{"de": "novo_contato", "para": "em_atendimento",
                       "movimentos": 6, "contatos": 6},
                      {"de": None, "para": "novo_contato", "movimentos": 12, "contatos": 12},
                      {"de": "em_atendimento", "para": "qualificado",
                       "movimentos": 2, "contatos": 2}]
        duracoes = [{"etapa": "novo_contato", "amostras": 6, "media": 3600.0,
                     "mediana": 1800.0, "p90": 7200.0}]
        loja, _ = self.montar(atuais, movimentos, duracoes)
        relatorio = loja.analytics_pipeline(janela())
        etapas = {item["id"]: item for item in relatorio["stages"]}
        self.assertEqual(etapas["novo_contato"]["contacts"], 10)
        self.assertEqual(etapas["novo_contato"]["entered"], 12)
        self.assertEqual(etapas["novo_contato"]["exited"], 6)
        self.assertEqual(etapas["novo_contato"]["conversionToNext"],
                         {"stage": "em_atendimento", "movements": 6, "rate": 50.0})
        self.assertEqual(etapas["novo_contato"]["timeInStage"]["medianSeconds"], 1800.0)
        self.assertEqual(etapas["novo_contato"]["timeInStage"]["p90Seconds"], 7200.0)
        self.assertEqual(etapas["em_atendimento"]["conversionToNext"]["rate"], 33.33)
        self.assertIsNone(relatorio["stages"][-1]["conversionToNext"])
        self.assertEqual(relatorio["totals"]["movements"], 20)

    def test_etapa_sem_entrada_na_janela_nao_divide_por_zero(self):
        movimentos = [{"de": "novo_contato", "para": "em_atendimento",
                       "movimentos": 3, "contatos": 3}]
        loja, _ = self.montar([], movimentos)
        etapas = {item["id"]: item for item in loja.analytics_pipeline(janela())["stages"]}
        self.assertEqual(etapas["novo_contato"]["entered"], 0)
        self.assertIsNone(etapas["novo_contato"]["conversionToNext"]["rate"])

    def test_etapa_fora_da_ordem_canonica_entra_no_fim(self):
        loja, _ = self.montar([{"etapa": "reembolso", "contatos": 2}])
        etapas = [item["id"] for item in loja.analytics_pipeline(janela())["stages"]]
        self.assertEqual(etapas[0], "novo_contato")
        self.assertEqual(etapas[-1], "reembolso")

    def test_permanencia_sem_amostra_devolve_nulo_e_nao_zero(self):
        loja, _ = self.montar([{"etapa": "novo_contato", "contatos": 1}])
        etapa = loja.analytics_pipeline(janela())["stages"][0]
        self.assertEqual(etapa["timeInStage"]["samples"], 0)
        self.assertIsNone(etapa["timeInStage"]["medianSeconds"])

    def test_calculo_de_permanencia_usa_intervalo_fechado_por_contato(self):
        loja, conexao = self.montar()
        loja.analytics_pipeline(janela())
        consulta = conexao.cur.executions[2][0]
        self.assertIn("lead(h.created_at) OVER ( PARTITION BY h.contact_id", consulta)
        self.assertIn("percentile_cont(0.5)", consulta)
        self.assertIn("percentile_cont(0.9)", consulta)
        self.assertIn("d.segundos IS NOT NULL", consulta)


class TempoRespostaTests(unittest.TestCase):
    def montar(self, primeira=(), resolucao=(), primeira_ant=(), resolucao_ant=()):
        return store([list(primeira), list(resolucao), list(primeira_ant), list(resolucao_ant)])

    def test_primeira_resposta_traz_mediana_p90_e_taxa(self):
        primeira = [{"canal": None, "conversas": 10, "respondidas": 8, "media": 900.0,
                     "mediana": 300.0, "p90": 3600.0},
                    {"canal": "whatsapp", "conversas": 6, "respondidas": 6, "media": 120.0,
                     "mediana": 90.0, "p90": 240.0}]
        resolucao = [{"canal": None, "conversas": 4, "media": 86400.0, "mediana": 43200.0,
                      "p90": 172800.0}]
        loja, _ = self.montar(primeira, resolucao)
        relatorio = loja.analytics_response_times(janela())
        self.assertEqual(relatorio["firstResponse"]["conversations"], 10)
        self.assertEqual(relatorio["firstResponse"]["answered"], 8)
        self.assertEqual(relatorio["firstResponse"]["pending"], 2)
        self.assertEqual(relatorio["firstResponse"]["responseRate"], 80.0)
        self.assertEqual(relatorio["firstResponse"]["medianSeconds"], 300.0)
        self.assertEqual(relatorio["firstResponse"]["p90Seconds"], 3600.0)
        self.assertEqual(relatorio["resolution"]["medianSeconds"], 43200.0)
        canais = {item["channel"]: item for item in relatorio["byChannel"]}
        self.assertEqual(canais["whatsapp"]["firstResponse"]["medianSeconds"], 90.0)
        self.assertEqual(canais["email"]["firstResponse"]["conversations"], 0)
        self.assertIsNone(canais["email"]["firstResponse"]["responseRate"])

    def test_sem_conversa_nenhuma_tudo_fica_nulo_sem_erro(self):
        loja, _ = self.montar()
        relatorio = loja.analytics_response_times(janela())
        self.assertEqual(relatorio["firstResponse"]["conversations"], 0)
        self.assertIsNone(relatorio["firstResponse"]["medianSeconds"])
        self.assertIsNone(relatorio["resolution"]["p90Seconds"])
        self.assertEqual(relatorio["previous"]["firstResponse"]["conversations"], 0)

    def test_consulta_mede_a_saida_posterior_a_entrada(self):
        loja, conexao = self.montar()
        loja.analytics_response_times(janela())
        consulta = conexao.cur.executions[0][0]
        self.assertIn("j.direction = 'outbound' AND j.occurred_at > e.entrada", consulta)
        self.assertIn("GROUPING SETS ((), (t.channel))", consulta)


class SaudeTests(unittest.TestCase):
    def montar(self, outbox=(), dlq=(), inbound=(), mensagens=()):
        return store([list(outbox), list(dlq), list(inbound), list(mensagens)])

    def linha_outbox(self, estado, topico, itens, idade=10.0, tentativas=1, vencidos=0):
        return {"estado": estado, "topico": topico, "itens": itens,
                "mais_antigo": datetime(2026, 9, 9, 12, tzinfo=timezone.utc),
                "max_tentativas": tentativas, "idade_segundos": idade, "vencidos": vencidos}

    def test_fila_saudavel_reporta_ok(self):
        loja, _ = self.montar()
        saude = loja.analytics_health(janela())
        self.assertEqual(saude["status"], "ok")
        self.assertEqual(saude["reasons"], [])
        self.assertEqual(saude["outbox"]["backlog"], 0)
        self.assertIsNone(saude["outbox"]["oldestAgeSeconds"])
        self.assertEqual(saude["deadLetters"]["total"], 0)

    def test_pendencia_recente_e_atencao_e_fila_parada_e_critico(self):
        recente, _ = self.montar([self.linha_outbox("pending", "outbound.send", 3, idade=30.0)])
        self.assertEqual(recente.analytics_health(janela())["status"], "atencao")
        parada, _ = self.montar([self.linha_outbox("retry", "outbound.send", 3, idade=4000.0)])
        critico = parada.analytics_health(janela())
        self.assertEqual(critico["status"], "critico")
        self.assertIn("fila_parada", critico["reasons"])
        self.assertEqual(critico["outbox"]["oldestAgeSeconds"], 4000.0)

    def test_dead_letter_sempre_e_critico_e_traz_tentativas_e_idade(self):
        dlq = [{"topico": "outbound.send", "itens": 2, "na_janela": 1,
                "mais_antigo": datetime(2026, 9, 1, tzinfo=timezone.utc),
                "mais_recente": datetime(2026, 9, 8, tzinfo=timezone.utc),
                "max_tentativas": 6}]
        loja, _ = self.montar([], dlq)
        saude = loja.analytics_health(janela())
        self.assertEqual(saude["status"], "critico")
        self.assertIn("dead_letters", saude["reasons"])
        self.assertEqual(saude["deadLetters"]["total"], 2)
        self.assertEqual(saude["deadLetters"]["inWindow"], 1)
        self.assertEqual(saude["deadLetters"]["maxAttempts"], 6)
        self.assertEqual(saude["deadLetters"]["oldestFailedAt"], "2026-09-01T00:00:00Z")

    def test_contadores_separam_estado_e_topico_sem_contar_publicado(self):
        outbox = [self.linha_outbox("pending", "outbound.send", 2, vencidos=2, tentativas=1),
                  self.linha_outbox("retry", "outbound.send", 1, tentativas=3),
                  self.linha_outbox("dead", "crm.contact.updated", 1, tentativas=6)]
        loja, conexao = self.montar(outbox, [], [{"pendentes": 1, "mais_antigo": None,
                                                  "idade_segundos": 45.0}],
                                    [{"estado": "failed", "itens": 2}])
        saude = loja.analytics_health(janela())
        self.assertEqual(saude["outbox"]["pending"], 2)
        self.assertEqual(saude["outbox"]["retry"], 1)
        self.assertEqual(saude["outbox"]["dead"], 1)
        self.assertEqual(saude["outbox"]["backlog"], 3)
        self.assertEqual(saude["outbox"]["due"], 2)
        self.assertEqual(saude["outbox"]["maxAttempts"], 3)
        self.assertEqual(saude["inbound"]["unprocessed"], 1)
        self.assertEqual(saude["messages"]["failed"], 2)
        self.assertIn("mensagem_com_falha", saude["reasons"])
        topicos = {item["topic"]: item for item in saude["outbox"]["byTopic"]}
        self.assertEqual(topicos["outbound.send"]["backlog"], 3)
        self.assertEqual(topicos["crm.contact.updated"]["dead"], 1)
        self.assertIn("status <> 'published'", conexao.cur.executions[0][0])

    def test_saude_nao_devolve_mensagem_de_erro_do_worker(self):
        loja, conexao = self.montar()
        saude = loja.analytics_health(janela())
        self.assertNotIn("last_error", json.dumps(saude))
        self.assertNotIn("last_error", " ".join(sql for sql, _ in conexao.cur.executions))


class OperadorTests(unittest.TestCase):
    def montar(self, linhas=(), serie=()):
        return store([list(linhas), list(serie)])

    def test_acoes_por_operador_e_por_acao(self):
        linhas = [{"tipo": "user", "ator": "gastao", "acao": "panel.contact.stage", "acoes": 7,
                   "primeira": datetime(2026, 9, 3, tzinfo=timezone.utc),
                   "ultima": datetime(2026, 9, 9, tzinfo=timezone.utc)},
                  {"tipo": "user", "ator": "gastao", "acao": "panel.conversation.note",
                   "acoes": 3, "primeira": datetime(2026, 9, 1, tzinfo=timezone.utc),
                   "ultima": datetime(2026, 9, 5, tzinfo=timezone.utc)},
                  {"tipo": "worker", "ator": "worker-1", "acao": "outbox.dead_lettered",
                   "acoes": 2, "primeira": None, "ultima": None}]
        serie = [{"dia": date(2026, 9, 9), "acoes": 5}]
        loja, _ = self.montar(linhas, serie)
        relatorio = loja.analytics_operators(janela())
        operadores = {item["actorId"]: item for item in relatorio["operators"]}
        self.assertEqual(operadores["gastao"]["actions"], 10)
        self.assertEqual(operadores["gastao"]["share"], 83.33)
        self.assertEqual(operadores["gastao"]["byAction"][0],
                         {"action": "panel.contact.stage", "count": 7})
        self.assertEqual(operadores["gastao"]["firstActionAt"], "2026-09-01T00:00:00Z")
        self.assertEqual(operadores["gastao"]["lastActionAt"], "2026-09-09T00:00:00Z")
        self.assertEqual(operadores["worker-1"]["actorType"], "worker")
        self.assertEqual(relatorio["totals"], {"actions": 12, "operators": 2})
        self.assertEqual(relatorio["actions"][0]["count"], 7)
        self.assertEqual(len(relatorio["series"]), 7)
        self.assertEqual(relatorio["series"][-1], {"date": "2026-09-09", "actions": 5})

    def test_trilha_nao_devolve_o_conteudo_da_acao(self):
        # O ``data`` da trilha guarda antes/depois: texto de nota e nome de
        # contato. Analytics conta acao, nunca abre o conteudo dela.
        loja, conexao = self.montar()
        loja.analytics_operators(janela())
        selecao = conexao.cur.executions[0][0].split(" FROM ")[0]
        for coluna in ("data", "object_id", "object_type"):
            self.assertNotIn(coluna, selecao)

    def test_agente_sem_trilha_devolve_listas_vazias(self):
        loja, _ = self.montar()
        relatorio = loja.analytics_operators(janela())
        self.assertEqual(relatorio["operators"], [])
        self.assertEqual(relatorio["totals"], {"actions": 0, "operators": 0})


# ----------------------------------------------------------------- rotas HTTP

class FakeAnalyticsStore:
    """Loja de painel que so responde analytics e proibe qualquer escrita."""

    def __init__(self, agent):
        self.agent = agent
        self.calls = []

    def _relatorio(self, nome, window):
        self.calls.append((nome, window.cache_key()))
        return {"window": window.public(), "generatedAt": "2026-09-10T02:00:00Z",
                "totals": {"messages": 1}, "schema": self.agent.schema_name}

    def analytics_overview(self, window):
        return self._relatorio("overview", window)

    def analytics_channels(self, window):
        return self._relatorio("channels", window)

    def analytics_origins(self, window):
        return self._relatorio("origins", window)

    def analytics_pipeline(self, window):
        return self._relatorio("pipeline", window)

    def analytics_response_times(self, window):
        return self._relatorio("response-times", window)

    def analytics_health(self, window):
        return self._relatorio("health", window)

    def analytics_operators(self, window):
        return self._relatorio("operators", window)

    def panel_conversations(self, **_):
        return {"conversations": [], "nextCursor": None}

    def enqueue_outbound(self, **_):
        raise AssertionError("analytics nao pode enfileirar envio externo")

    def panel_add_note(self, *_args, **_kwargs):
        raise AssertionError("analytics nao pode escrever")


class Catalog:
    def __init__(self, agents=(LUCAS, BELLA)):
        self.agents = tuple(agents)

    def list_all(self):
        return self.agents

    def describe(self, tenant_id, agent_id):
        return next((agent for agent in self.agents if agent.tenant_id == tenant_id
                     and agent.agent_id == agent_id), None)


class RotaAnalyticsTests(unittest.TestCase):
    def setUp(self):
        self.stores = {}
        self.cache = AnalyticsCache(ttl_seconds=60)
        self.budget = ComputationBudget(max_computations=50)
        self.app = PanelApplication(
            directory=OperatorDirectory(lambda: CADASTRO), sessions=SessionStore(),
            catalog=Catalog(), store_factory=self._store,
            throttle=LoginThrottle(max_failures=5, window_seconds=60),
            analytics_cache=self.cache, analytics_budget=self.budget)

    def _store(self, agent):
        return self.stores.setdefault((agent.tenant_id, agent.agent_id),
                                      FakeAnalyticsStore(agent))

    def call(self, method, path, *, cookie=None, query=""):
        environ = {"REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": query,
                   "CONTENT_LENGTH": "0", "wsgi.input": io.BytesIO(b"")}
        if cookie:
            environ["HTTP_COOKIE"] = f"{SESSION_COOKIE}={cookie}"
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = headers

        corpo = b"".join(self.app(environ, start_response))
        return int(captured["status"].split()[0]), (json.loads(corpo) if corpo else {})

    def login(self, operator="gastao"):
        raw = json.dumps({"operator": operator, "password": SENHA}).encode()
        environ = {"REQUEST_METHOD": "POST", "PATH_INFO": "/api/v1/panel/session",
                   "QUERY_STRING": "", "CONTENT_LENGTH": str(len(raw)),
                   "wsgi.input": io.BytesIO(raw)}
        captured = {}
        self.app(environ, lambda status, headers: captured.update(headers=headers))
        cookie = next(value for name, value in captured["headers"] if name == "Set-Cookie")
        return cookie.split(";")[0].split("=", 1)[1]

    BASE = "/api/v1/panel/agents/dr-lucas/atendimento/analytics"
    RELATORIOS = ("overview", "channels", "origins", "pipeline", "response-times",
                  "health", "operators")

    def test_os_sete_relatorios_respondem_com_janela_e_cache(self):
        token = self.login()
        for relatorio in self.RELATORIOS:
            with self.subTest(relatorio=relatorio):
                status, corpo = self.call("GET", f"{self.BASE}/{relatorio}", cookie=token)
                self.assertEqual(status, 200)
                self.assertEqual(corpo["report"], relatorio)
                self.assertEqual(corpo["agent"]["tenantId"], "dr-lucas")
                self.assertEqual(corpo["window"]["timezone"], DEFAULT_TIMEZONE)
                self.assertEqual(corpo["window"]["days"], 30)
                self.assertEqual(corpo["cache"], {"hit": False, "ttlSeconds": 60})

    def test_indice_lista_os_relatorios_sem_tocar_o_banco(self):
        token = self.login()
        status, corpo = self.call("GET", self.BASE, cookie=token)
        self.assertEqual(status, 200)
        self.assertEqual(corpo["reports"], sorted(self.RELATORIOS))
        self.assertEqual(self.stores[("dr-lucas", "atendimento")].calls, [])

    def test_analytics_exige_sessao(self):
        status, corpo = self.call("GET", f"{self.BASE}/overview")
        self.assertEqual((status, corpo["error"]), (401, "unauthorized"))
        self.assertEqual(self.stores, {})

    def test_agente_de_outro_operador_responde_404_e_nao_abre_store(self):
        token = self.login()
        status, corpo = self.call(
            "GET", "/api/v1/panel/agents/bella-franklin/atendimento/analytics/overview",
            cookie=token)
        self.assertEqual((status, corpo["error"]), (404, "not_found"))
        self.assertEqual(self.stores, {})

    def test_cache_de_um_tenant_nao_serve_outro(self):
        gastao = self.login()
        self.call("GET", f"{self.BASE}/overview", cookie=gastao)
        outra = self.login(operator="operadora-b")
        status, corpo = self.call(
            "GET", "/api/v1/panel/agents/bella-franklin/atendimento/analytics/overview",
            cookie=outra)
        self.assertEqual(status, 200)
        self.assertEqual(corpo["agent"]["tenantId"], "bella-franklin")
        self.assertEqual(corpo["cache"]["hit"], False)
        self.assertEqual(corpo["schema"], "sac_bella_franklin")

    def test_segunda_chamada_na_mesma_janela_vem_do_cache(self):
        token = self.login()
        primeira = self.call("GET", f"{self.BASE}/overview", cookie=token)[1]
        segunda = self.call("GET", f"{self.BASE}/overview", cookie=token)[1]
        self.assertFalse(primeira["cache"]["hit"])
        self.assertTrue(segunda["cache"]["hit"])
        self.assertEqual(len(self.stores[("dr-lucas", "atendimento")].calls), 1)
        # Janela diferente e calculo diferente.
        self.call("GET", f"{self.BASE}/overview", cookie=token, query="periodo=7d")
        self.assertEqual(len(self.stores[("dr-lucas", "atendimento")].calls), 2)

    def test_janela_absurda_devolve_400_e_nao_consulta_o_banco(self):
        token = self.login()
        for query in ("de=2010-01-01&ate=2026-09-10", "periodo=tudo", "de=ontem",
                      "fuso=Marte/Olimpo", "periodo=7d&de=2026-09-01", "ate=2026-13-45"):
            with self.subTest(query=query):
                status, corpo = self.call("GET", f"{self.BASE}/overview", cookie=token,
                                          query=query)
                self.assertEqual((status, corpo["error"]), (400, "invalid_window"))
                self.assertEqual(corpo["maxDays"], MAX_WINDOW_DAYS)
        self.assertEqual(self.stores[("dr-lucas", "atendimento")].calls, [])

    def test_fuso_pedido_muda_a_janela_devolvida(self):
        token = self.login()
        corpo = self.call("GET", f"{self.BASE}/overview", cookie=token,
                          query="periodo=7d&fuso=UTC")[1]
        self.assertEqual(corpo["window"]["timezone"], "UTC")
        self.assertTrue(corpo["window"]["startsAt"].endswith("T00:00:00Z"))

    def test_de_e_ate_chegam_ate_a_loja(self):
        token = self.login()
        corpo = self.call("GET", f"{self.BASE}/overview", cookie=token,
                          query="de=2026-09-01&ate=2026-09-03")[1]
        self.assertEqual((corpo["window"]["from"], corpo["window"]["to"]),
                         ("2026-09-01", "2026-09-03"))
        self.assertEqual(self.stores[("dr-lucas", "atendimento")].calls[0][1],
                         ("2026-09-01", "2026-09-03", DEFAULT_TIMEZONE))

    def test_chamada_cara_repetida_estoura_o_orcamento_e_devolve_429(self):
        app = PanelApplication(
            directory=OperatorDirectory(lambda: CADASTRO), sessions=SessionStore(),
            catalog=Catalog(), store_factory=self._store,
            analytics_cache=AnalyticsCache(ttl_seconds=60),
            analytics_budget=ComputationBudget(max_computations=2))
        self.app = app
        token = self.login()
        # Cada janela distinta erra o cache de proposito e consome orcamento.
        self.call("GET", f"{self.BASE}/overview", cookie=token, query="de=2026-09-01")
        self.call("GET", f"{self.BASE}/overview", cookie=token, query="de=2026-09-02")
        status, corpo = self.call("GET", f"{self.BASE}/overview", cookie=token,
                                  query="de=2026-09-03")
        self.assertEqual((status, corpo["error"]), (429, "analytics_busy"))
        self.assertEqual(len(self.stores[("dr-lucas", "atendimento")].calls), 2)

    def test_relatorio_inexistente_e_metodo_errado(self):
        token = self.login()
        self.assertEqual(self.call("GET", f"{self.BASE}/inventado", cookie=token)[0], 404)
        self.assertEqual(self.call("GET", f"{self.BASE}/overview/extra", cookie=token)[0], 404)
        self.assertEqual(self.call("POST", f"{self.BASE}/overview", cookie=token)[0], 405)
        self.assertEqual(self.call("DELETE", f"{self.BASE}/health", cookie=token)[0], 405)

    def test_nenhuma_resposta_de_analytics_carrega_segredo_ou_pii(self):
        token = self.login()
        for relatorio in self.RELATORIOS:
            texto = json.dumps(self.call("GET", f"{self.BASE}/{relatorio}",
                                         cookie=token)[1]).lower()
            for termo in PROIBIDO:
                with self.subTest(relatorio=relatorio, termo=termo):
                    self.assertNotIn(termo, texto)
            self.assertNotIn(HASH.lower(), texto)

    def test_resposta_nao_e_cacheavel_pelo_navegador(self):
        token = self.login()
        environ = {"REQUEST_METHOD": "GET", "PATH_INFO": f"{self.BASE}/overview",
                   "QUERY_STRING": "", "CONTENT_LENGTH": "0", "wsgi.input": io.BytesIO(b""),
                   "HTTP_COOKIE": f"{SESSION_COOKIE}={token}"}
        captured = {}
        self.app(environ, lambda status, headers: captured.update(headers=dict(headers)))
        self.assertEqual(captured["headers"]["Cache-Control"], "private, no-store")

    def test_fuso_invalido_na_configuracao_falha_no_arranque(self):
        with self.assertRaises(ValueError):
            PanelApplication(directory=OperatorDirectory(lambda: CADASTRO),
                             sessions=SessionStore(), catalog=Catalog(),
                             store_factory=self._store,
                             analytics_timezone="Marte/Olimpo")


if __name__ == "__main__":
    unittest.main()
