"""Contrato HTTP do painel: sessao, isolamento por agente, CSRF e auditoria."""

import io
import json
import unittest

from collections import deque

from backend.panel_api import (DisabledPanelApplication, PanelAgent, PanelApplication,
                               PostgresPanelAgentCatalog, SESSION_COOKIE)
from backend.panel_auth import LoginThrottle, MIN_ITERATIONS, OperatorDirectory, SessionStore, hash_password

SENHA = "senha-de-homologacao-1"
HASH = hash_password(SENHA, iterations=MIN_ITERATIONS)
PROIBIDO = ("secret", "senha", "password", "token_ref", "api_key", "access_token", "pbkdf2")

LUCAS = PanelAgent("dr-lucas", "atendimento", "sac_dr_lucas", "Dr. Lucas", "Atendimento",
                   "provisioned", ({"channel": "whatsapp", "provider": "meta",
                                    "status": "disabled", "displayName": "WhatsApp"},))
BELLA = PanelAgent("bella-franklin", "atendimento", "sac_bella_franklin", "Bella Franklin",
                   "Atendimento", "provisioned", ())

CADASTRO = json.dumps({"operators": [
    {"id": "gastao", "displayName": "Gastao", "passwordHash": HASH,
     "agents": [{"tenantId": "dr-lucas", "agentId": "atendimento"}]},
    {"id": "operadora-b", "displayName": "Operadora B", "passwordHash": HASH,
     "agents": [{"tenantId": "bella-franklin", "agentId": "atendimento"}]},
    {"id": "leitora", "displayName": "Leitora", "passwordHash": HASH,
     "agents": [{"tenantId": "dr-lucas", "agentId": "atendimento", "write": False}]},
]})


class FakeStore:
    """Store de painel que registra chamadas e proibe qualquer saida externa."""

    def __init__(self, agent):
        self.agent = agent
        self.calls = []

    def _record(self, name, **kwargs):
        self.calls.append((name, kwargs))

    def panel_conversations(self, *, limit=25, cursor=None):
        self._record("conversations", limit=limit, cursor=cursor)
        if str(limit) == "abacaxi":
            raise ValueError("limite invalido")
        return {"conversations": [{"id": "cv_1", "channel": "whatsapp",
                                   "contact": {"id": "ct_1", "displayName": "Contato",
                                               "pipelineStage": "novo_contato"},
                                   "schema": self.agent.schema_name}],
                "nextCursor": None}

    def panel_messages(self, conversation_id, *, limit=50, cursor=None):
        self._record("messages", conversation_id=conversation_id, limit=limit, cursor=cursor)
        if conversation_id == "cv_de_outro":
            raise KeyError("conversa inexistente")
        return {"conversationId": conversation_id, "messages": [], "notes": [], "nextCursor": None}

    def panel_origins(self):
        self._record("origins")
        return {"origins": [{"slug": "kiwify_carrinho", "label": "Kiwify · carrinho",
                             "channel": "whatsapp", "platform": "Kiwify", "campaign": None,
                             "contacts": 2, "lastSeenAt": None,
                             "tenantId": self.agent.tenant_id, "agentId": self.agent.agent_id}]}

    def panel_pipeline(self):
        self._record("pipeline")
        return {"stages": [{"id": "novo_contato", "contacts": 1}], "total": 1}

    def panel_audit(self, *, limit=50):
        self._record("audit", limit=limit)
        return {"entries": []}

    def panel_set_stage(self, contact_id, *, stage, actor_id, reason=None):
        self._record("set_stage", contact_id=contact_id, stage=stage, actor_id=actor_id,
                     reason=reason)
        if stage == "etapa-inexistente":
            raise ValueError("etapa desconhecida")
        return {"contactId": contact_id, "before": "novo_contato", "after": stage,
                "changed": True, "auditId": "10"}

    def panel_assign_conversation(self, conversation_id, *, assignee, actor_id):
        self._record("assign", conversation_id=conversation_id, assignee=assignee,
                     actor_id=actor_id)
        return {"conversationId": conversation_id, "before": None, "after": assignee,
                "changed": True, "auditId": "11"}

    def panel_add_note(self, conversation_id, *, text, actor_id, idempotency_key=None):
        self._record("note", conversation_id=conversation_id, text=text, actor_id=actor_id,
                     idempotency_key=idempotency_key)
        if not text.strip():
            raise ValueError("nota vazia")
        repetida = idempotency_key == "repetida"
        return {"conversationId": conversation_id, "contactId": "ct_1", "noteId": "crm_1",
                "idempotencyKey": idempotency_key or "gerada", "idempotent": repetida,
                "auditId": None if repetida else "12"}

    def enqueue_outbound(self, **_):
        raise AssertionError("painel nao pode enfileirar envio externo")

    def ingest(self, *_args, **_kwargs):
        raise AssertionError("painel nao ingere webhook")


class Catalog:
    def __init__(self, agents=(LUCAS, BELLA), fail=False):
        self.agents = tuple(agents)
        self.fail = fail

    def list_all(self):
        if self.fail:
            raise RuntimeError("banco fora do ar")
        return self.agents

    def describe(self, tenant_id, agent_id):
        if self.fail:
            raise RuntimeError("banco fora do ar")
        return next((agent for agent in self.agents if agent.tenant_id == tenant_id
                     and agent.agent_id == agent_id), None)


class PanelApiTests(unittest.TestCase):
    def setUp(self):
        self.stores = {}
        self.catalog = Catalog()
        self.sessions = SessionStore()
        self.app = PanelApplication(
            directory=OperatorDirectory(lambda: CADASTRO), sessions=self.sessions,
            catalog=self.catalog, store_factory=self._store,
            throttle=LoginThrottle(max_failures=3, window_seconds=60))

    def _store(self, agent):
        return self.stores.setdefault((agent.tenant_id, agent.agent_id), FakeStore(agent))

    def call(self, method, path, *, body=None, cookie=None, csrf=None, query=""):
        raw = b"" if body is None else json.dumps(body).encode()
        environ = {"REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": query,
                   "CONTENT_LENGTH": str(len(raw)), "wsgi.input": io.BytesIO(raw)}
        if cookie:
            environ["HTTP_COOKIE"] = f"{SESSION_COOKIE}={cookie}"
        if csrf:
            environ["HTTP_X_SAC_PANEL_CSRF"] = csrf
        captured = {}

        def start_response(status, headers):
            captured["status"] = status
            captured["headers"] = headers

        chunks = b"".join(self.app(environ, start_response))
        payload = json.loads(chunks) if chunks else {}
        return int(captured["status"].split()[0]), payload, captured["headers"]

    def login(self, operator="gastao", password=SENHA):
        status, payload, headers = self.call("POST", "/api/v1/panel/session",
                                             body={"operator": operator, "password": password})
        cookie = next((value for name, value in headers if name == "Set-Cookie"), "")
        token = cookie.split(";")[0].split("=", 1)[1] if cookie else ""
        return status, payload, token

    # ------------------------------------------------------------- sessao

    def test_login_valido_cria_sessao_com_cookie_endurecido(self):
        status, payload, token = self.login()
        self.assertEqual(status, 200)
        self.assertTrue(token)
        self.assertEqual(payload["operator"]["id"], "gastao")
        self.assertTrue(payload["csrfToken"])
        _, _, headers = self.call("GET", "/api/v1/panel/session", cookie=token)
        cabecalho = dict(self.call("POST", "/api/v1/panel/session",
                                   body={"operator": "gastao", "password": SENHA})[2])
        self.assertIn("HttpOnly", cabecalho["Set-Cookie"])
        self.assertIn("SameSite=Strict", cabecalho["Set-Cookie"])
        self.assertIn("Secure", cabecalho["Set-Cookie"])

    def test_senha_errada_nao_cria_sessao_e_freia_forca_bruta(self):
        for _ in range(3):
            status, payload, token = self.login(password="senha-errada-longa")
            self.assertEqual((status, token), (401, ""))
        status, payload, _ = self.login(password="senha-errada-longa")
        self.assertEqual((status, payload["error"]), (429, "too_many_attempts"))

    def test_rotas_de_dados_exigem_sessao(self):
        for method, path in (("GET", "/api/v1/panel/agents"),
                             ("GET", "/api/v1/panel/agents/dr-lucas/atendimento/conversations"),
                             ("POST", "/api/v1/panel/agents/dr-lucas/atendimento/contacts/ct_1/stage")):
            with self.subTest(path=path):
                status, payload, _ = self.call(method, path, body={})
                self.assertEqual((status, payload["error"]), (401, "unauthorized"))
        self.assertEqual(self.stores, {})

    def test_logout_invalida_a_sessao(self):
        _, _, token = self.login()
        self.assertEqual(self.call("DELETE", "/api/v1/panel/session", cookie=token)[0], 200)
        self.assertEqual(self.call("GET", "/api/v1/panel/agents", cookie=token)[0], 401)

    # -------------------------------------------------------- isolamento

    def test_operador_ve_somente_os_agentes_da_propria_sessao(self):
        _, _, token = self.login()
        status, payload, _ = self.call("GET", "/api/v1/panel/agents", cookie=token)
        self.assertEqual(status, 200)
        self.assertEqual([agent["tenantId"] for agent in payload["agents"]], ["dr-lucas"])

    def test_agente_de_outro_operador_responde_404_e_nao_abre_store(self):
        _, _, token = self.login()
        status, payload, _ = self.call(
            "GET", "/api/v1/panel/agents/bella-franklin/atendimento/conversations", cookie=token)
        self.assertEqual((status, payload["error"]), (404, "not_found"))
        self.assertEqual(self.stores, {})

    def test_tenant_enviado_pelo_cliente_e_ignorado(self):
        _, _, token = self.login()
        status, payload, _ = self.call(
            "GET", "/api/v1/panel/agents/dr-lucas/atendimento/conversations", cookie=token,
            query="tenantId=bella-franklin&schema=sac_bella_franklin&agentId=outro")
        self.assertEqual(status, 200)
        self.assertEqual(payload["agent"]["tenantId"], "dr-lucas")
        self.assertEqual(payload["conversations"][0]["schema"], "sac_dr_lucas")
        self.assertEqual(list(self.stores), [("dr-lucas", "atendimento")])

    def test_escrita_com_tenant_forjado_no_corpo_nao_muda_o_escopo(self):
        _, payload, token = self.login()
        status, corpo, _ = self.call(
            "POST", "/api/v1/panel/agents/dr-lucas/atendimento/contacts/ct_1/stage",
            body={"stage": "qualificado", "tenantId": "bella-franklin",
                  "agentId": "outro", "actorId": "root", "schemaName": "sac_bella_franklin"},
            cookie=token, csrf=payload["csrfToken"])
        self.assertEqual(status, 200)
        chamada = self.stores[("dr-lucas", "atendimento")].calls[-1]
        self.assertEqual(chamada[0], "set_stage")
        self.assertEqual(chamada[1]["actor_id"], "gastao")
        self.assertNotIn(("bella-franklin", "atendimento"), self.stores)

    def test_conversa_de_outro_escopo_responde_404(self):
        _, _, token = self.login()
        status, payload, _ = self.call(
            "GET", "/api/v1/panel/agents/dr-lucas/atendimento/conversations/cv_de_outro/messages",
            cookie=token)
        self.assertEqual((status, payload["error"]), (404, "not_found"))

    # ------------------------------------------------------------- leitura

    def test_leitura_devolve_conversas_pipeline_e_auditoria(self):
        _, _, token = self.login()
        base = "/api/v1/panel/agents/dr-lucas/atendimento"
        conversas = self.call("GET", base + "/conversations", cookie=token)[1]
        mensagens = self.call("GET", base + "/conversations/cv_1/messages", cookie=token)[1]
        pipeline = self.call("GET", base + "/pipeline", cookie=token)[1]
        auditoria = self.call("GET", base + "/audit", cookie=token)[1]
        self.assertEqual(conversas["conversations"][0]["id"], "cv_1")
        self.assertEqual(mensagens["conversationId"], "cv_1")
        self.assertEqual(pipeline["stages"][0]["id"], "novo_contato")
        self.assertEqual(auditoria["entries"], [])

    def test_nenhuma_resposta_carrega_segredo(self):
        _, sessao, token = self.login()
        base = "/api/v1/panel/agents/dr-lucas/atendimento"
        respostas = [self.call("GET", "/api/v1/panel/agents", cookie=token)[1],
                     self.call("GET", "/api/v1/panel/session", cookie=token)[1],
                     self.call("GET", base + "/conversations", cookie=token)[1],
                     self.call("GET", base + "/pipeline", cookie=token)[1]]
        for resposta in respostas:
            texto = json.dumps(resposta).lower()
            for termo in PROIBIDO:
                with self.subTest(termo=termo):
                    self.assertNotIn(termo, texto)
            self.assertNotIn(HASH.lower(), texto)
            self.assertNotIn(SENHA, texto)

    def test_limite_invalido_devolve_400(self):
        _, _, token = self.login()
        status, payload, _ = self.call(
            "GET", "/api/v1/panel/agents/dr-lucas/atendimento/conversations",
            cookie=token, query="limit=abacaxi")
        self.assertEqual((status, payload["error"]), (400, "invalid_request"))

    def test_backend_fora_do_ar_devolve_503_explicito(self):
        _, _, token = self.login()
        self.catalog.fail = True
        for path in ("/api/v1/panel/agents",
                     "/api/v1/panel/agents/dr-lucas/atendimento/conversations"):
            with self.subTest(path=path):
                status, payload, _ = self.call("GET", path, cookie=token)
                self.assertEqual((status, payload["error"]), (503, "backend_unavailable"))

    # ------------------------------------------------------------- escrita

    def test_escrita_sem_csrf_e_recusada(self):
        _, _, token = self.login()
        status, payload, _ = self.call(
            "POST", "/api/v1/panel/agents/dr-lucas/atendimento/contacts/ct_1/stage",
            body={"stage": "qualificado"}, cookie=token)
        self.assertEqual((status, payload["error"]), (403, "invalid_csrf"))
        self.assertEqual(self.stores[("dr-lucas", "atendimento")].calls, [])

    def test_csrf_de_outra_sessao_nao_serve(self):
        _, primeira, token = self.login()
        _, segunda, _ = self.login()
        status, payload, _ = self.call(
            "POST", "/api/v1/panel/agents/dr-lucas/atendimento/contacts/ct_1/stage",
            body={"stage": "qualificado"}, cookie=token, csrf=segunda["csrfToken"])
        self.assertEqual((status, payload["error"]), (403, "invalid_csrf"))

    def test_as_tres_escritas_gravam_e_devolvem_auditoria(self):
        _, sessao, token = self.login()
        base = "/api/v1/panel/agents/dr-lucas/atendimento"
        csrf = sessao["csrfToken"]
        etapa = self.call("POST", base + "/contacts/ct_1/stage",
                          body={"stage": "qualificado", "reason": "cliente respondeu"},
                          cookie=token, csrf=csrf)
        nota = self.call("POST", base + "/conversations/cv_1/notes",
                         body={"text": "cliente pediu retorno"}, cookie=token, csrf=csrf)
        atribuicao = self.call("POST", base + "/conversations/cv_1/assignment",
                               body={"assignee": "gastao"}, cookie=token, csrf=csrf)
        self.assertEqual(etapa[0], 200)
        self.assertEqual(etapa[1]["auditId"], "10")
        self.assertEqual(nota[0], 201)
        self.assertEqual(nota[1]["auditId"], "12")
        self.assertEqual(atribuicao[0], 200)
        self.assertEqual(atribuicao[1]["auditId"], "11")
        acoes = [nome for nome, _ in self.stores[("dr-lucas", "atendimento")].calls]
        self.assertEqual(acoes, ["set_stage", "note", "assign"])

    def test_nota_repetida_e_idempotente(self):
        _, sessao, token = self.login()
        resposta = self.call("POST",
                             "/api/v1/panel/agents/dr-lucas/atendimento/conversations/cv_1/notes",
                             body={"text": "mesma nota", "idempotencyKey": "repetida"},
                             cookie=token, csrf=sessao["csrfToken"])
        self.assertEqual(resposta[0], 200)
        self.assertTrue(resposta[1]["idempotent"])

    def test_responsavel_precisa_ter_permissao_de_escrita_no_mesmo_agente(self):
        _, sessao, token = self.login()
        path = "/api/v1/panel/agents/dr-lucas/atendimento/conversations/cv_1/assignment"
        for assignee in ("operadora-b", "leitora", "nao-cadastrado"):
            with self.subTest(assignee=assignee):
                status, payload, _ = self.call("POST", path, body={"assignee": assignee},
                                               cookie=token, csrf=sessao["csrfToken"])
                self.assertEqual((status, payload["error"]), (400, "invalid_assignee"))
        self.assertEqual(self.stores[("dr-lucas", "atendimento")].calls, [])

    def test_etapa_desconhecida_e_nota_vazia_devolvem_400(self):
        _, sessao, token = self.login()
        base = "/api/v1/panel/agents/dr-lucas/atendimento"
        csrf = sessao["csrfToken"]
        etapa = self.call("POST", base + "/contacts/ct_1/stage",
                          body={"stage": "etapa-inexistente"}, cookie=token, csrf=csrf)
        nota = self.call("POST", base + "/conversations/cv_1/notes",
                         body={"text": "   "}, cookie=token, csrf=csrf)
        self.assertEqual((etapa[0], etapa[1]["error"]), (400, "invalid_request"))
        self.assertEqual((nota[0], nota[1]["error"]), (400, "invalid_request"))

    def test_origens_vem_estruturadas_do_backend_com_slug_estavel(self):
        _, _, token = self.login()
        status, payload, _ = self.call(
            "GET", "/api/v1/panel/agents/dr-lucas/atendimento/origins", cookie=token)
        self.assertEqual(status, 200)
        origem = payload["origins"][0]
        self.assertEqual(origem["slug"], "kiwify_carrinho")
        self.assertEqual(origem["tenantId"], "dr-lucas")
        # Canal da origem e campo proprio, separado do canal da conversa.
        self.assertIn("channel", origem)
        self.assertEqual(payload["agent"]["permissions"], {"read": True, "write": True})

    def test_permissao_de_escrita_vem_do_cadastro_e_bloqueia_as_tres_rotas(self):
        _, sessao, token = self.login(operator="leitora")
        base = "/api/v1/panel/agents/dr-lucas/atendimento"
        csrf = sessao["csrfToken"]
        leitura = self.call("GET", base + "/conversations", cookie=token)
        self.assertEqual(leitura[0], 200)
        self.assertEqual(leitura[1]["agent"]["permissions"], {"read": True, "write": False})
        escritas = (("POST", base + "/contacts/ct_1/stage", {"stage": "qualificado"}),
                    ("POST", base + "/conversations/cv_1/notes", {"text": "nota"}),
                    ("POST", base + "/conversations/cv_1/assignment", {"assignee": None}))
        for method, path, body in escritas:
            with self.subTest(path=path):
                status, payload, _ = self.call(method, path, body=body, cookie=token, csrf=csrf)
                self.assertEqual((status, payload["error"]), (403, "read_only"))
        self.assertEqual(self.stores[("dr-lucas", "atendimento")].calls, [("conversations",
                         {"limit": 25, "cursor": None})])

    def test_metodo_errado_e_rota_desconhecida(self):
        _, _, token = self.login()
        self.assertEqual(self.call("POST", "/api/v1/panel/agents", body={}, cookie=token)[0], 405)
        self.assertEqual(self.call("GET", "/api/v1/panel/agents/dr-lucas/atendimento/inventado",
                                   cookie=token)[0], 404)
        self.assertEqual(self.call("GET", "/webhooks/v2/qualquer", cookie=token)[0], 404)

    def test_corpo_grande_demais_e_recusado_antes_da_escrita(self):
        _, sessao, token = self.login()
        gigante = {"text": "x" * 200_000}
        status, payload, _ = self.call(
            "POST", "/api/v1/panel/agents/dr-lucas/atendimento/conversations/cv_1/notes",
            body=gigante, cookie=token, csrf=sessao["csrfToken"])
        self.assertEqual((status, payload["error"]), (413, "too_large"))
        self.assertEqual(self.stores[("dr-lucas", "atendimento")].calls, [])


class CatalogoControlPlaneTests(unittest.TestCase):
    """O schema do agente vem do control plane e nenhuma coluna de segredo sai."""

    AGENTE = ("dr-lucas", "atendimento", "sac_dr_lucas", "Dr. Lucas", "Atendimento",
              "provisioned")
    CANAL = ("dr-lucas", "atendimento", "whatsapp", "meta", "disabled", "WhatsApp")

    class Cursor:
        def __init__(self, results):
            self.results = deque(results)
            self.executions = []

        def execute(self, sql, params=()):
            self.executions.append((" ".join(sql.split()), params))

        def fetchall(self):
            return self.results.popleft() if self.results else []

        def close(self):
            pass

    class Connection:
        def __init__(self, cursor):
            self.cur = cursor
            self.closed = 0

        def cursor(self):
            return self.cur

        def close(self):
            self.closed += 1

    def catalogo(self, results):
        cursor = self.Cursor(results)
        return PostgresPanelAgentCatalog(lambda: self.Connection(cursor)), cursor

    def test_consulta_lista_colunas_explicitas_e_nenhuma_referencia_de_cofre(self):
        catalogo, cursor = self.catalogo([[self.AGENTE], [self.CANAL]])
        agentes = catalogo.list_all()
        self.assertEqual(agentes[0].schema_name, "sac_dr_lucas")
        self.assertEqual(agentes[0].channels[0]["provider"], "meta")
        consultas = " ".join(sql for sql, _ in cursor.executions)
        self.assertNotIn("*", consultas)
        for proibida in ("secret_ref", "access_token", "api_key", "smtp_password",
                         "imap_password", "signature_secret"):
            with self.subTest(proibida=proibida):
                self.assertNotIn(proibida, consultas)
        self.assertNotIn("secret", json.dumps(agentes[0].public()).lower())

    def test_describe_usa_parametro_e_nao_concatena_o_pedido(self):
        catalogo, cursor = self.catalogo([[self.AGENTE], [self.CANAL]])
        agente = catalogo.describe("dr-lucas", "atendimento")
        self.assertEqual(agente.tenant_id, "dr-lucas")
        self.assertEqual(cursor.executions[0][1], ("dr-lucas", "atendimento"))
        self.assertIn("ag.tenant_id = %s", cursor.executions[0][0])

    def test_agente_inexistente_ou_fora_do_status_visivel_devolve_none(self):
        catalogo, _ = self.catalogo([[]])
        self.assertIsNone(catalogo.describe("nao", "existe"))
        suspenso = ("dr-lucas", "atendimento", "sac_dr_lucas", "Dr. Lucas", "Atendimento",
                    "suspended")
        catalogo, _ = self.catalogo([[suspenso]])
        self.assertIsNone(catalogo.describe("dr-lucas", "atendimento"))


class PainelDesligadoTests(unittest.TestCase):
    def test_sem_cadastro_de_operadores_o_painel_falha_fechado(self):
        captured = {}
        body = b"".join(DisabledPanelApplication()(
            {"REQUEST_METHOD": "GET", "PATH_INFO": "/api/v1/panel/agents"},
            lambda status, headers: captured.update(status=status)))
        self.assertEqual(captured["status"], "503 Service Unavailable")
        self.assertEqual(json.loads(body)["error"], "panel_disabled")


class CookieInseguroTests(unittest.TestCase):
    def test_secure_pode_ser_desligado_apenas_por_configuracao_explicita(self):
        app = PanelApplication(directory=OperatorDirectory(lambda: CADASTRO),
                               sessions=SessionStore(), catalog=Catalog(),
                               store_factory=lambda agent: FakeStore(agent),
                               cookie_secure=False, cookie_path="/sac/api/")
        raw = json.dumps({"operator": "gastao", "password": SENHA}).encode()
        captured = {}
        app({"REQUEST_METHOD": "POST", "PATH_INFO": "/api/v1/panel/session",
             "QUERY_STRING": "", "CONTENT_LENGTH": str(len(raw)), "wsgi.input": io.BytesIO(raw)},
            lambda status, headers: captured.update(headers=dict(headers)))
        cookie = captured["headers"]["Set-Cookie"]
        self.assertNotIn("Secure", cookie)
        self.assertIn("Path=/sac/api/", cookie)


if __name__ == "__main__":
    unittest.main()
