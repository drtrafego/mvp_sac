"""Leitura e escrita do painel no PostgresStore: escopo, auditoria, sem envio."""

import json
import unittest
from collections import deque
from datetime import datetime, timezone

from backend.postgres_store import PostgresStore

TENANT, AGENT, SCHEMA = "dr-lucas", "atendimento", "sac_dr_lucas"
MOMENTO = datetime(2026, 9, 9, 12, 0, tzinfo=timezone.utc)


class FakeCursor:
    def __init__(self, results=()):
        self.results = deque(results)
        self.executions = []
        self.rowcount = 1

    def execute(self, query, params=()):
        self.executions.append((" ".join(query.split()), params))
        return self

    def fetchone(self):
        return self.results.popleft() if self.results else None

    def fetchall(self):
        return self.results.popleft() if self.results else []

    def close(self):
        pass


class FakeConnection:
    def __init__(self, results=()):
        self.cur = FakeCursor(results)
        self.commits = 0
        self.rollbacks = 0
        self.closed = False

    def cursor(self):
        return self.cur

    def commit(self):
        self.commits += 1

    def rollback(self):
        self.rollbacks += 1

    def close(self):
        self.closed = True


def store(results=()):
    connection = FakeConnection(results)
    return PostgresStore(lambda: connection, tenant_id=TENANT, agent_id=AGENT,
                         schema=SCHEMA), connection


def conversa(**alteracoes):
    linha = {"conversation_id": "cv_1", "channel": "whatsapp", "status": "open",
             "assigned_to": None, "bot_paused": False, "updated_at": MOMENTO,
             "contact_id": "ct_1", "contact_name": "Contato Um",
             "pipeline_stage": "novo_contato", "last_direction": "inbound",
             "last_occurred_at": MOMENTO, "last_body": {"text": "oi"},
             "last_status": "received", "message_count": 3,
             "origin_data": {"platform": "Kiwify", "source": "carrinho abandonado",
                             "channel": "whatsapp", "campaign": "bf"}}
    linha.update(alteracoes)
    return linha


class LeituraTests(unittest.TestCase):
    def test_conversas_ficam_presas_ao_escopo_do_construtor(self):
        loja, conexao = store([[conversa()]])
        pagina = loja.panel_conversations(limit=10)
        consulta, parametros = conexao.cur.executions[0]
        self.assertIn(f'"{SCHEMA}"."sac_threads"', consulta)
        self.assertEqual(parametros[:2], (TENANT, AGENT))
        self.assertEqual(pagina["conversations"][0]["id"], "cv_1")
        self.assertEqual(pagina["conversations"][0]["contact"]["id"], "ct_1")
        self.assertEqual(pagina["conversations"][0]["lastMessage"]["text"], "oi")
        self.assertIsNone(pagina["nextCursor"])

    def test_conversa_traz_origem_estruturada_separada_do_canal(self):
        loja, _ = store([[conversa()]])
        item = loja.panel_conversations()["conversations"][0]
        self.assertEqual(item["channel"], "whatsapp")
        self.assertEqual(item["origin"]["slug"], "kiwify_carrinho_abandonado")
        self.assertEqual(item["origin"]["campaign"], "bf")
        self.assertEqual(item["origin"]["channel"], "whatsapp")

    def test_conversa_sem_origem_nao_inventa_origem_a_partir_do_canal(self):
        loja, _ = store([[conversa(origin_data=None, channel="instagram")]])
        item = loja.panel_conversations()["conversations"][0]
        self.assertEqual(item["origin"]["slug"], "origem_nao_identificada")
        self.assertIsNone(item["origin"]["channel"])
        self.assertEqual(item["channel"], "instagram")

    def test_paginacao_por_keyset_devolve_cursor_reutilizavel(self):
        loja, conexao = store([[conversa(), conversa(conversation_id="cv_2")]])
        pagina = loja.panel_conversations(limit=1)
        self.assertEqual(len(pagina["conversations"]), 1)
        self.assertTrue(pagina["nextCursor"])
        seguinte, conexao2 = store([[conversa(conversation_id="cv_2")]])
        seguinte.panel_conversations(limit=1, cursor=pagina["nextCursor"])
        consulta, parametros = conexao2.cur.executions[0]
        self.assertIn("(t.updated_at,t.id) < (%s::timestamptz,%s)", consulta)
        self.assertEqual(parametros[2:4], ("2026-09-09T12:00:00Z", "cv_1"))

    def test_cursor_adulterado_e_recusado(self):
        loja, _ = store()
        for invalido in ("!!!", "YWJj", "eyJhIjoxfQ"):
            with self.subTest(invalido=invalido):
                with self.assertRaises(ValueError):
                    loja.panel_conversations(cursor=invalido)

    def test_limite_e_teto_e_valor_invalido_falha(self):
        loja, conexao = store([[]])
        loja.panel_conversations(limit=5000)
        self.assertEqual(conexao.cur.executions[0][1][-1], PostgresStore.PANEL_MAX_PAGE + 1)
        with self.assertRaises(ValueError):
            store()[0].panel_conversations(limit="abacaxi")

    def test_mensagens_exigem_conversa_do_escopo_e_trazem_notas(self):
        loja, conexao = store([
            {"contact_id": "ct_1", "assigned_to": None},
            [{"id": "msg_1", "direction": "inbound", "status": "received",
              "occurred_at": MOMENTO, "body": {"text": "bom dia"}}],
            [{"id": "crm_1", "actor": "gastao", "created_at": MOMENTO,
              "payload": {"conversation_id": "cv_1", "text": "cliente pediu retorno"}}],
        ])
        pagina = loja.panel_messages("cv_1")
        self.assertEqual(pagina["messages"][0]["text"], "bom dia")
        self.assertEqual(pagina["notes"][0]["text"], "cliente pediu retorno")
        self.assertEqual(conexao.cur.executions[0][1], (TENANT, AGENT, "cv_1"))

    def test_conversa_inexistente_no_escopo_levanta_keyerror(self):
        loja, _ = store([None])
        with self.assertRaises(KeyError):
            loja.panel_messages("cv_de_outro_agente")

    def test_pipeline_respeita_a_ordem_canonica_e_soma_etapas_desconhecidas(self):
        loja, conexao = store([[{"pipeline_stage": "qualificado", "contacts": 2},
                                {"pipeline_stage": "etapa_legada", "contacts": 1}]])
        pipeline = loja.panel_pipeline()
        etapas = [item["id"] for item in pipeline["stages"]]
        self.assertEqual(etapas[:5], list(loja.pipeline.stages))
        self.assertIn("etapa_legada", etapas)
        self.assertEqual(pipeline["total"], 3)
        self.assertEqual(conexao.cur.executions[0][1], (TENANT, AGENT))

    def test_origens_agregadas_por_slug_com_vinculo_do_agente(self):
        loja, _ = store([[
            {"data": {"platform": "Kiwify", "source": "carrinho"}, "contacts": 2,
             "last_seen_at": MOMENTO},
            {"data": {"platform": "kiwify", "source": "Carrinho"}, "contacts": 1,
             "last_seen_at": MOMENTO},
            {"data": None, "contacts": 4, "last_seen_at": None},
        ]])
        origens = {item["slug"]: item for item in loja.panel_origins()["origins"]}
        self.assertEqual(origens["kiwify_carrinho"]["contacts"], 3)
        self.assertEqual(origens["kiwify_carrinho"]["tenantId"], TENANT)
        self.assertEqual(origens["kiwify_carrinho"]["agentId"], AGENT)
        self.assertEqual(origens["origem_nao_identificada"]["contacts"], 4)

    def test_auditoria_pode_ser_lida_no_escopo(self):
        loja, conexao = store([[{"id": 7, "actor_type": "user", "actor_id": "gastao",
                                 "action": "panel.contact.stage", "object_type": "contact",
                                 "object_id": "ct_1",
                                 "data": {"before": {"pipeline_stage": "novo_contato"}},
                                 "occurred_at": MOMENTO}]])
        trilha = loja.panel_audit(limit=10)
        self.assertEqual(trilha["entries"][0]["actorId"], "gastao")
        self.assertEqual(trilha["entries"][0]["data"]["before"]["pipeline_stage"], "novo_contato")
        self.assertEqual(conexao.cur.executions[0][1], (TENANT, AGENT, 10))


class EscritaTests(unittest.TestCase):
    @staticmethod
    def sql(conexao):
        return "\n".join(consulta for consulta, _ in conexao.cur.executions)

    def test_mover_card_grava_historico_e_auditoria_com_antes_e_depois(self):
        loja, conexao = store([{"pipeline_stage": "novo_contato"}, {"id": 12}])
        resultado = loja.panel_set_stage("ct_1", stage="qualificado", actor_id="gastao",
                                         reason="cliente respondeu")
        sql = self.sql(conexao)
        self.assertIn("sac_pipeline_history", sql)
        self.assertIn("sac_audit_log", sql)
        self.assertEqual((resultado["before"], resultado["after"]), ("novo_contato", "qualificado"))
        self.assertTrue(resultado["changed"])
        self.assertEqual(resultado["auditId"], "12")
        auditoria = conexao.cur.executions[-1][1]
        self.assertEqual(auditoria[:5], (TENANT, AGENT, "user", "gastao", "panel.contact.stage"))
        dados = json.loads(auditoria[-1])
        self.assertEqual(dados["before"], {"pipeline_stage": "novo_contato"})
        self.assertEqual(dados["after"], {"pipeline_stage": "qualificado"})
        self.assertEqual(dados["reason"], "cliente respondeu")
        self.assertEqual(conexao.commits, 1)

    def test_mover_card_para_a_mesma_etapa_nao_reescreve_mas_audita(self):
        loja, conexao = store([{"pipeline_stage": "qualificado"}, {"id": 13}])
        resultado = loja.panel_set_stage("ct_1", stage="qualificado", actor_id="gastao")
        self.assertFalse(resultado["changed"])
        self.assertNotIn("sac_pipeline_history", self.sql(conexao))
        self.assertIn("sac_audit_log", self.sql(conexao))

    def test_atribuir_conversa_audita_o_responsavel_anterior(self):
        loja, conexao = store([{"contact_id": "ct_1", "assigned_to": "operadora-b"}, {"id": 14}])
        resultado = loja.panel_assign_conversation("cv_1", assignee="gastao", actor_id="gastao")
        self.assertEqual((resultado["before"], resultado["after"]), ("operadora-b", "gastao"))
        dados = json.loads(conexao.cur.executions[-1][1][-1])
        self.assertEqual(dados["before"], {"assigned_to": "operadora-b"})
        self.assertEqual(dados["after"], {"assigned_to": "gastao"})
        self.assertIn("sac_threads", self.sql(conexao))

    def test_liberar_conversa_aceita_responsavel_nulo(self):
        loja, conexao = store([{"contact_id": "ct_1", "assigned_to": "gastao"}, {"id": 15}])
        resultado = loja.panel_assign_conversation("cv_1", assignee=None, actor_id="gastao")
        self.assertIsNone(resultado["after"])
        self.assertTrue(resultado["changed"])

    def test_nota_interna_grava_em_crm_actions_e_audita(self):
        loja, conexao = store([{"contact_id": "ct_1", "assigned_to": None},
                               {"id": "crm_1"}, {"id": 16}])
        resultado = loja.panel_add_note("cv_1", text="cliente pediu retorno", actor_id="gastao")
        sql = self.sql(conexao)
        self.assertIn("sac_crm_actions", sql)
        self.assertIn("sac_audit_log", sql)
        self.assertFalse(resultado["idempotent"])
        self.assertEqual(resultado["contactId"], "ct_1")
        dados = json.loads(conexao.cur.executions[-1][1][-1])
        self.assertEqual(dados["after"]["text"], "cliente pediu retorno")

    def test_nota_repetida_com_a_mesma_chave_nao_duplica_nem_reaudita(self):
        loja, conexao = store([{"contact_id": "ct_1", "assigned_to": None}, None,
                               {"id": "crm_1", "created_at": MOMENTO}])
        resultado = loja.panel_add_note("cv_1", text="mesma nota", actor_id="gastao",
                                        idempotency_key="chave-1")
        self.assertTrue(resultado["idempotent"])
        self.assertEqual(resultado["noteId"], "crm_1")
        self.assertNotIn("sac_audit_log", self.sql(conexao))

    def test_nenhuma_escrita_do_painel_enfileira_envio_externo(self):
        casos = (
            (lambda loja: loja.panel_set_stage("ct_1", stage="qualificado", actor_id="gastao"),
             [{"pipeline_stage": "novo_contato"}, {"id": 1}]),
            (lambda loja: loja.panel_assign_conversation("cv_1", assignee=None, actor_id="gastao"),
             [{"contact_id": "ct_1", "assigned_to": "gastao"}, {"id": 2}]),
            (lambda loja: loja.panel_add_note("cv_1", text="nota", actor_id="gastao"),
             [{"contact_id": "ct_1", "assigned_to": None}, {"id": "crm_1"}, {"id": 3}]),
        )
        for acao, resultados in casos:
            loja, conexao = store(resultados)
            acao(loja)
            sql = self.sql(conexao)
            with self.subTest(sql=sql[:40]):
                self.assertNotIn("sac_outbox", sql)
                self.assertNotIn("sac_domain_events", sql)
                self.assertNotIn("outbound.send", sql)

    def test_escrita_recusa_entrada_invalida_antes_de_abrir_conexao(self):
        def sem_conexao():
            raise AssertionError("nao deveria conectar")
        loja = PostgresStore(sem_conexao, tenant_id=TENANT, agent_id=AGENT, schema=SCHEMA)
        with self.assertRaises(ValueError):
            loja.panel_set_stage("ct_1", stage="etapa-que-nao-existe", actor_id="gastao")
        with self.assertRaises(ValueError):
            loja.panel_set_stage("ct_1", stage="qualificado", actor_id="  ")
        with self.assertRaises(ValueError):
            loja.panel_add_note("cv_1", text="   ", actor_id="gastao")
        with self.assertRaises(ValueError):
            loja.panel_add_note("cv_1", text="x" * 5000, actor_id="gastao")

    def test_contato_inexistente_no_escopo_nao_move_card(self):
        loja, conexao = store([None])
        with self.assertRaises(KeyError):
            loja.panel_set_stage("ct_de_outro_agente", stage="qualificado", actor_id="gastao")
        self.assertEqual(conexao.rollbacks, 1)
        self.assertNotIn("sac_audit_log", self.sql(conexao))


if __name__ == "__main__":
    unittest.main()
