"""Configuracao de canais: CRUD tenant-bound, cofre so de escrita e pendencias.

O eixo destes testes e uma pergunta so: o valor do segredo pode sair daqui? A
resposta tem de ser nao em toda resposta HTTP, em toda linha de auditoria e em
todo log. O resto cobre isolamento por tenant, recusa do que so o servidor pode
gerar e o comportamento do cofre em disco.
"""

import errno
import io
import json
import logging
import os
import stat
import tempfile
import unittest
from collections import deque
from pathlib import Path

from backend.panel_api import PanelAgent, PanelApplication, SESSION_COOKIE
from backend.panel_auth import (LoginThrottle, MIN_ITERATIONS, OperatorDirectory,
                                SessionStore, hash_password)
from backend.panel_config import (ConfigError, SecretVault, SecretWriteQuota,
                                  VaultUnavailable, account_checklist,
                                  agent_checklist, derive_secret_ref,
                                  new_endpoint_id, normalize_webhook_base,
                                  validate_new_account)
from backend.postgres_store import PanelConflictError, PostgresStore

SENHA = "senha-de-homologacao-1"
HASH = hash_password(SENHA, iterations=MIN_ITERATIONS)
VALOR = "EAAG-valor-de-segredo-que-nao-pode-vazar-9f3a"
BASE = "https://sac.example.com"

LUCAS = PanelAgent("dr-lucas", "atendimento", "sac_dr_lucas", "Dr. Lucas", "Atendimento",
                   "provisioned", ())
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

CAMPOS_DE_SEGREDO = ("signature", "verify", "accessToken", "apiKey", "smtpUsername",
                     "smtpPassword", "imapUsername", "imapPassword")


def _valores(no):
    """Todos os valores escalares de uma estrutura JSON, recursivamente."""
    if isinstance(no, dict):
        for chave, filho in no.items():
            yield chave
            yield from _valores(filho)
    elif isinstance(no, (list, tuple)):
        for filho in no:
            yield from _valores(filho)
    else:
        yield no


def conta_vazia(account_id, channel, provider, external, **extra):
    conta = {"id": account_id, "channel": channel, "provider": provider,
             "externalAccountId": external, "publicEndpointId": None,
             "signatureHeader": None, "displayName": None, "status": "disabled",
             "config": {}, "secretRefs": {campo: None for campo in CAMPOS_DE_SEGREDO},
             "createdAt": "2026-09-10T00:00:00Z", "updatedAt": "2026-09-10T00:00:00Z"}
    conta.update(extra)
    return conta


class FakeChannelStore:
    """Store de contas de canal em memoria, com as mesmas garantias do real.

    Guarda a trilha de auditoria separada para os testes poderem provar que o
    valor do segredo nunca chega ate ela.
    """

    def __init__(self, agent):
        self.agent = agent
        self.accounts = {}
        self.audit = []
        self.calls = []

    # -- leitura

    def panel_channel_accounts(self):
        self.calls.append(("list", {}))
        return {"accounts": [json.loads(json.dumps(item))
                             for item in self.accounts.values()]}

    def panel_channel_account(self, account_id):
        self.calls.append(("get", {"account_id": account_id}))
        if account_id not in self.accounts:
            raise KeyError("conta de canal inexistente")
        return {"account": json.loads(json.dumps(self.accounts[account_id]))}

    # -- escrita

    def _audit(self, action, account_id, data):
        self.audit.append({"action": action, "objectId": account_id,
                           "actorId": data.pop("actor_id"), "data": data})
        return str(len(self.audit))

    def panel_create_channel_account(self, *, account_id, channel, provider,
                                     external_account_id, display_name,
                                     signature_header, status, config, actor_id):
        self.calls.append(("create", {"account_id": account_id, "channel": channel,
                                      "provider": provider, "actor_id": actor_id}))
        chave = (channel, provider, external_account_id)
        if any((c["channel"], c["provider"], c["externalAccountId"]) == chave
               for c in self.accounts.values()):
            raise PanelConflictError("conta_duplicada", "ja existe conta assim")
        conta = conta_vazia(account_id, channel, provider, external_account_id,
                            displayName=display_name, signatureHeader=signature_header,
                            status=status, config=dict(config))
        self.accounts[account_id] = conta
        audit = self._audit("panel.channel_account.create", account_id,
                            {"actor_id": actor_id, "after": dict(conta)})
        return {"account": json.loads(json.dumps(conta)), "created": True, "auditId": audit}

    def panel_update_channel_account(self, account_id, *, changes, actor_id):
        self.calls.append(("update", {"account_id": account_id, "changes": dict(changes),
                                      "actor_id": actor_id}))
        conta = self.accounts[account_id]
        publicos = {"display_name": "displayName", "external_account_id": "externalAccountId",
                    "signature_header": "signatureHeader", "status": "status",
                    "config": "config"}
        antes = json.loads(json.dumps(conta))
        for coluna, valor in changes.items():
            conta[publicos[coluna]] = valor
        audit = self._audit("panel.channel_account.update", account_id,
                            {"actor_id": actor_id, "before": antes, "after": dict(conta)})
        return {"account": json.loads(json.dumps(conta)), "changed": antes != conta,
                "auditId": audit}

    def panel_disable_channel_account(self, account_id, *, actor_id):
        self.calls.append(("disable", {"account_id": account_id, "actor_id": actor_id}))
        conta = self.accounts[account_id]
        mudou = conta["status"] != "disabled"
        conta["status"] = "disabled"
        audit = self._audit("panel.channel_account.disable", account_id,
                            {"actor_id": actor_id, "changed": mudou})
        return {"account": json.loads(json.dumps(conta)), "changed": mudou, "auditId": audit}

    def panel_generate_channel_endpoint(self, account_id, *, endpoint_id, signature_ref,
                                        verify_ref, signature_header, actor_id):
        self.calls.append(("endpoint", {"account_id": account_id,
                                        "endpoint_id": endpoint_id, "actor_id": actor_id}))
        conta = self.accounts[account_id]
        if conta["publicEndpointId"]:
            return {"account": json.loads(json.dumps(conta)), "created": False,
                    "auditId": None}
        conta["publicEndpointId"] = endpoint_id
        conta["secretRefs"]["signature"] = signature_ref
        if verify_ref and not conta["secretRefs"]["verify"]:
            conta["secretRefs"]["verify"] = verify_ref
        if signature_header and not conta["signatureHeader"]:
            conta["signatureHeader"] = signature_header
        audit = self._audit("panel.channel_account.endpoint", account_id,
                            {"actor_id": actor_id, "public_endpoint_id": endpoint_id,
                             "signature_secret_ref": signature_ref})
        return {"account": json.loads(json.dumps(conta)), "created": True, "auditId": audit}

    def panel_record_channel_secret(self, account_id, *, field, secret_ref, actor_id,
                                    already_referenced):
        self.calls.append(("secret", {"account_id": account_id, "field": field,
                                      "secret_ref": secret_ref, "actor_id": actor_id}))
        conta = self.accounts[account_id]
        if not already_referenced:
            conta["secretRefs"][field] = secret_ref
        audit = self._audit("panel.channel_account.secret_ref", account_id,
                            {"actor_id": actor_id, "field": field, "secret_ref": secret_ref,
                             "vault_write": True,
                             "reference_created": not already_referenced})
        return {"account": json.loads(json.dumps(conta)), "secretRef": secret_ref,
                "auditId": audit}

    # -- portas que o painel nunca pode usar

    def enqueue_outbound(self, **_):
        raise AssertionError("configuracao de canal nao enfileira envio externo")

    def ingest(self, *_a, **_k):
        raise AssertionError("configuracao de canal nao ingere webhook")


class Catalog:
    def __init__(self, agents=(LUCAS, BELLA)):
        self.agents = tuple(agents)

    def list_all(self):
        return self.agents

    def describe(self, tenant_id, agent_id):
        return next((a for a in self.agents if a.tenant_id == tenant_id
                     and a.agent_id == agent_id), None)


class BaseCanal(unittest.TestCase):
    """Aplicacao com cofre real em diretorio temporario."""

    def setUp(self):
        self.raiz = tempfile.TemporaryDirectory()
        self.addCleanup(self.raiz.cleanup)
        self.cofre = SecretVault(self.raiz.name)
        self.stores = {}
        self.quota = SecretWriteQuota(max_writes=4, window_seconds=600)
        self.app = PanelApplication(
            directory=OperatorDirectory(lambda: CADASTRO), sessions=SessionStore(),
            catalog=Catalog(), store_factory=self._store,
            throttle=LoginThrottle(max_failures=3, window_seconds=60),
            vault=self.cofre, webhook_base_url=BASE, secret_quota=self.quota)

    def _store(self, agent):
        return self.stores.setdefault((agent.tenant_id, agent.agent_id),
                                      FakeChannelStore(agent))

    def store(self, tenant="dr-lucas", agent="atendimento"):
        return self.stores[(tenant, agent)]

    def call(self, method, path, *, body=None, cookie=None, csrf=None, query=""):
        raw = b"" if body is None else json.dumps(body).encode()
        environ = {"REQUEST_METHOD": method, "PATH_INFO": path, "QUERY_STRING": query,
                   "CONTENT_LENGTH": str(len(raw)), "wsgi.input": io.BytesIO(raw)}
        if cookie:
            environ["HTTP_COOKIE"] = f"{SESSION_COOKIE}={cookie}"
        if csrf:
            environ["HTTP_X_SAC_PANEL_CSRF"] = csrf
        capturado = {}

        def start_response(status, headers):
            capturado["status"] = status

        corpo = b"".join(self.app(environ, start_response))
        return (int(capturado["status"].split()[0]),
                json.loads(corpo) if corpo else {})

    def login(self, operator="gastao"):
        raw = json.dumps({"operator": operator, "password": SENHA}).encode()
        capturado = {}
        environ = {"REQUEST_METHOD": "POST", "PATH_INFO": "/api/v1/panel/session",
                   "QUERY_STRING": "", "CONTENT_LENGTH": str(len(raw)),
                   "wsgi.input": io.BytesIO(raw)}
        corpo = b"".join(self.app(environ,
                                  lambda s, h: capturado.update(headers=dict(h))))
        payload = json.loads(corpo)
        cookie = capturado["headers"]["Set-Cookie"]
        return cookie.split(";")[0].split("=", 1)[1], payload["csrfToken"]

    def base(self, tenant="dr-lucas", agent="atendimento"):
        return f"/api/v1/panel/agents/{tenant}/{agent}/channels"

    def criar_conta(self, token, csrf, *, channel="whatsapp", provider="meta",
                    external="5511999", config=None):
        corpo = {"channel": channel, "provider": provider,
                 "externalAccountId": external, "displayName": "Canal",
                 "config": config or {}}
        return self.call("POST", self.base(), body=corpo, cookie=token, csrf=csrf)


class CrudDeContasTests(BaseCanal):
    def test_criar_conta_nasce_desativada_sem_endpoint_e_sem_referencia(self):
        token, csrf = self.login()
        status, corpo = self.criar_conta(token, csrf)
        self.assertEqual(status, 201)
        conta = corpo["account"]
        self.assertEqual(conta["status"], "disabled")
        self.assertIsNone(conta["publicEndpointId"])
        self.assertIsNone(conta["webhookUrl"])
        self.assertTrue(conta["id"].startswith("ch_"))
        self.assertEqual(sorted(conta["secrets"]), ["accessToken", "signature", "verify"])
        for campo in conta["secrets"].values():
            self.assertEqual(campo, {"ref": None, "state": "ausente"})

    def test_listar_devolve_apenas_referencia_e_estado_nunca_valor(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        self.call("POST", f"{self.base()}/{conta['id']}/endpoint", body={},
                  cookie=token, csrf=csrf)
        self.call("PUT", f"{self.base()}/{conta['id']}/secrets/accessToken",
                  body={"value": VALOR}, cookie=token, csrf=csrf)
        status, corpo = self.call("GET", self.base(), cookie=token)
        self.assertEqual(status, 200)
        segredos = corpo["accounts"][0]["secrets"]
        self.assertEqual(segredos["accessToken"]["state"], "presente")
        self.assertEqual(segredos["accessToken"]["ref"],
                         f"dr-lucas/atendimento/{conta['id']}/access_token")
        self.assertNotIn(VALOR, json.dumps(corpo))
        self.assertNotIn("value", json.dumps(corpo))

    def test_edicao_altera_config_e_recusa_troca_de_canal_ou_provedor(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf, channel="email", provider="brevo",
                                 external="sac@cliente.com")[1]["account"]
        rota = f"{self.base()}/{conta['id']}"
        status, corpo = self.call("PATCH", rota, cookie=token, csrf=csrf, body={
            "displayName": "Suporte", "config": {"sender_email": "sac@cliente.com",
                                                 "sender_name": "Suporte"}})
        self.assertEqual(status, 200)
        self.assertEqual(corpo["account"]["displayName"], "Suporte")
        self.assertEqual(corpo["account"]["config"]["sender_email"], "sac@cliente.com")
        for imutavel, valor in (("channel", "whatsapp"), ("provider", "smtp")):
            with self.subTest(campo=imutavel):
                status, corpo = self.call("PATCH", rota, body={imutavel: valor},
                                          cookie=token, csrf=csrf)
                self.assertEqual((status, corpo["error"]), (400, "campo_imutavel"))

    def test_desativar_conta_mantem_a_linha_e_registra_auditoria(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        status, corpo = self.call("DELETE", f"{self.base()}/{conta['id']}",
                                  cookie=token, csrf=csrf)
        self.assertEqual(status, 200)
        self.assertEqual(corpo["account"]["status"], "disabled")
        acoes = [item["action"] for item in self.store().audit]
        self.assertIn("panel.channel_account.disable", acoes)

    def test_conta_duplicada_responde_409(self):
        token, csrf = self.login()
        self.criar_conta(token, csrf)
        status, corpo = self.criar_conta(token, csrf)
        self.assertEqual((status, corpo["error"]), (409, "conta_duplicada"))

    def test_canal_provedor_e_config_invalidos_viram_400_com_codigo(self):
        token, csrf = self.login()
        casos = (
            ({"channel": "sms", "provider": "meta", "externalAccountId": "1"},
             "canal_invalido"),
            ({"channel": "whatsapp", "provider": "twilio", "externalAccountId": "1"},
             "provedor_invalido"),
            ({"channel": "email", "provider": "meta", "externalAccountId": "1"},
             "provedor_incompativel"),
            ({"channel": "whatsapp", "provider": "meta", "externalAccountId": "1",
              "config": {"host": "smtp.cliente.com"}}, "config_chave_desconhecida"),
            ({"channel": "whatsapp", "provider": "meta", "externalAccountId": "1",
              "config": {"graph_url": "http://graph.facebook.com"}}, "config_invalida"),
            ({"channel": "whatsapp", "provider": "meta", "externalAccountId": ""},
             "campo_obrigatorio"),
        )
        for corpo, esperado in casos:
            with self.subTest(codigo=esperado):
                status, resposta = self.call("POST", self.base(), body=corpo,
                                             cookie=token, csrf=csrf)
                self.assertEqual((status, resposta["error"]), (400, esperado))
        self.assertEqual(self.store().accounts, {})

    def test_config_com_chave_de_segredo_e_recusada_antes_do_banco(self):
        token, csrf = self.login()
        status, corpo = self.call("POST", self.base(), cookie=token, csrf=csrf, body={
            "channel": "email", "provider": "brevo", "externalAccountId": "sac@x.com",
            "config": {"api_key": "abc"}})
        # A chave nem chega na lista permitida do provedor.
        self.assertEqual(status, 400)
        self.assertIn(corpo["error"], ("config_chave_desconhecida", "config_com_segredo"))
        self.assertEqual(self.store().accounts, {})


class ServidorGeraOsIdsTests(BaseCanal):
    def test_public_endpoint_id_do_cliente_e_recusado_em_toda_rota(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        forjado = "x" * 32
        rotas = (("POST", self.base(), {"channel": "whatsapp", "provider": "meta",
                                        "externalAccountId": "5511888",
                                        "publicEndpointId": forjado}),
                 ("PATCH", f"{self.base()}/{conta['id']}",
                  {"displayName": "x", "publicEndpointId": forjado}),
                 ("POST", f"{self.base()}/{conta['id']}/endpoint",
                  {"publicEndpointId": forjado}))
        for metodo, rota, corpo in rotas:
            with self.subTest(rota=rota):
                status, resposta = self.call(metodo, rota, body=corpo, cookie=token,
                                             csrf=csrf)
                self.assertEqual((status, resposta["error"]), (400, "endpoint_nao_aceito"))
        self.assertIsNone(self.store().accounts[conta["id"]]["publicEndpointId"])

    def test_id_da_conta_do_cliente_e_recusado(self):
        token, csrf = self.login()
        status, corpo = self.call("POST", self.base(), cookie=token, csrf=csrf, body={
            "channel": "whatsapp", "provider": "meta", "externalAccountId": "5511777",
            "id": "ch_escolhido_pelo_cliente"})
        self.assertEqual((status, corpo["error"]), (400, "id_nao_aceito"))

    def test_valor_de_segredo_no_corpo_do_cadastro_e_recusado(self):
        token, csrf = self.login()
        for chave in ("accessToken", "apiKey", "signatureSecretRef", "password"):
            with self.subTest(chave=chave):
                status, corpo = self.call("POST", self.base(), cookie=token, csrf=csrf,
                                          body={"channel": "whatsapp", "provider": "meta",
                                                "externalAccountId": "5511666",
                                                chave: VALOR})
                self.assertEqual(status, 400)
                self.assertEqual(corpo["error"], "segredo_nao_aceito")
                self.assertNotIn(VALOR, json.dumps(corpo))

    def test_endpoint_gerado_no_servidor_devolve_url_pronta_e_nao_regenera(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        status, corpo = self.call("POST", f"{self.base()}/{conta['id']}/endpoint",
                                  body={}, cookie=token, csrf=csrf)
        self.assertEqual(status, 201)
        endpoint = corpo["publicEndpointId"]
        self.assertRegex(endpoint, r"^[A-Za-z0-9_-]{16,128}$")
        self.assertEqual(corpo["webhookUrl"], f"{BASE}/webhooks/v2/{endpoint}")
        self.assertEqual(corpo["webhookPath"], f"/webhooks/v2/{endpoint}")
        # A assinatura entra junto: o CHECK do banco exige o par.
        self.assertEqual(corpo["account"]["secrets"]["signature"]["ref"],
                         f"dr-lucas/atendimento/{conta['id']}/signature")
        de_novo = self.call("POST", f"{self.base()}/{conta['id']}/endpoint", body={},
                            cookie=token, csrf=csrf)
        self.assertEqual(de_novo[0], 200)
        self.assertFalse(de_novo[1]["created"])
        self.assertEqual(de_novo[1]["publicEndpointId"], endpoint)


class IsolamentoPorTenantTests(BaseCanal):
    def test_agente_de_outro_operador_responde_404_e_nao_abre_store(self):
        token, csrf = self.login()
        rotas = (("GET", self.base("bella-franklin"), None),
                 ("POST", self.base("bella-franklin"),
                  {"channel": "whatsapp", "provider": "meta", "externalAccountId": "1"}),
                 ("GET", "/api/v1/panel/agents/bella-franklin/atendimento/channel-checklist",
                  None))
        for metodo, rota, corpo in rotas:
            with self.subTest(rota=rota):
                status, resposta = self.call(metodo, rota, body=corpo, cookie=token,
                                             csrf=csrf)
                self.assertEqual((status, resposta["error"]), (404, "not_found"))
        self.assertNotIn(("bella-franklin", "atendimento"), self.stores)

    def test_conta_de_outro_agente_nao_e_alcancavel_pelo_id(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        outro, outro_csrf = self.login(operator="operadora-b")
        status, corpo = self.call("GET", f"{self.base('bella-franklin')}/{conta['id']}",
                                  cookie=outro)
        self.assertEqual((status, corpo["error"]), (404, "not_found"))
        status, corpo = self.call(
            "PUT", f"{self.base('bella-franklin')}/{conta['id']}/secrets/accessToken",
            body={"value": VALOR}, cookie=outro, csrf=outro_csrf)
        self.assertEqual((status, corpo["error"]), (404, "not_found"))

    def test_tenant_forjado_no_corpo_nao_muda_o_escopo_da_referencia(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        status, corpo = self.call(
            "PUT", f"{self.base()}/{conta['id']}/secrets/accessToken", cookie=token,
            csrf=csrf, body={"value": VALOR, "tenantId": "bella-franklin",
                             "agentId": "outro"})
        self.assertEqual(status, 200)
        self.assertTrue(corpo["secretRef"].startswith("dr-lucas/atendimento/"))
        self.assertTrue((Path(self.raiz.name) / "dr-lucas").is_dir())
        self.assertFalse((Path(self.raiz.name) / "bella-franklin").exists())

    def test_operador_somente_leitura_le_mas_nao_escreve(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        leitora, leitora_csrf = self.login(operator="leitora")
        self.assertEqual(self.call("GET", self.base(), cookie=leitora)[0], 200)
        escritas = (
            ("POST", self.base(), {"channel": "instagram", "provider": "meta",
                                   "externalAccountId": "178"}),
            ("PATCH", f"{self.base()}/{conta['id']}", {"displayName": "x"}),
            ("DELETE", f"{self.base()}/{conta['id']}", None),
            ("POST", f"{self.base()}/{conta['id']}/endpoint", {}),
            ("PUT", f"{self.base()}/{conta['id']}/secrets/accessToken", {"value": VALOR}),
        )
        for metodo, rota, corpo in escritas:
            with self.subTest(rota=f"{metodo} {rota}"):
                status, resposta = self.call(metodo, rota, body=corpo, cookie=leitora,
                                             csrf=leitora_csrf)
                self.assertEqual((status, resposta["error"]), (403, "read_only"))
        self.assertEqual(len(self.store().accounts), 1)

    def test_escrita_sem_csrf_e_recusada_antes_de_tocar_o_cofre(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        status, corpo = self.call("PUT", f"{self.base()}/{conta['id']}/secrets/accessToken",
                                  body={"value": VALOR}, cookie=token)
        self.assertEqual((status, corpo["error"]), (403, "invalid_csrf"))
        self.assertEqual(list(Path(self.raiz.name).rglob("*")), [])

    def test_rota_de_canal_exige_sessao(self):
        status, corpo = self.call("GET", self.base())
        self.assertEqual((status, corpo["error"]), (401, "unauthorized"))
        self.assertEqual(self.stores, {})


class GravacaoDeSegredoTests(BaseCanal):
    def preparar(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        return token, csrf, conta

    def test_grava_com_0600_dono_correto_e_conteudo_exato(self):
        token, csrf, conta = self.preparar()
        status, corpo = self.call("PUT", f"{self.base()}/{conta['id']}/secrets/accessToken",
                                  body={"value": VALOR}, cookie=token, csrf=csrf)
        self.assertEqual(status, 200)
        alvo = Path(self.raiz.name) / "dr-lucas" / "atendimento" / conta["id"] / "access_token"
        info = alvo.lstat()
        self.assertEqual(stat.S_IMODE(info.st_mode), 0o600)
        self.assertEqual(info.st_uid, os.geteuid())
        self.assertEqual(alvo.read_text(), VALOR)
        self.assertEqual(stat.S_IMODE(alvo.parent.lstat().st_mode), 0o700)
        self.assertEqual(corpo["state"], "presente")

    def test_resposta_auditoria_e_log_nao_carregam_o_valor_nem_o_tamanho(self):
        token, csrf, conta = self.preparar()
        with self.assertNoLogs(level=logging.DEBUG):
            status, corpo = self.call(
                "PUT", f"{self.base()}/{conta['id']}/secrets/accessToken",
                body={"value": VALOR}, cookie=token, csrf=csrf)
        self.assertEqual(status, 200)
        respostas = [corpo,
                     self.call("GET", self.base(), cookie=token)[1],
                     self.call("GET", f"{self.base()}/{conta['id']}", cookie=token)[1],
                     self.call("GET", "/api/v1/panel/agents/dr-lucas/atendimento/"
                                      "channel-checklist", cookie=token)[1]]
        trilha = json.dumps(self.store().audit)
        for texto in [json.dumps(item) for item in respostas] + [trilha]:
            self.assertNotIn(VALOR, texto)
            self.assertNotIn(VALOR[:12], texto)
        # O tamanho exato tambem nao pode aparecer como campo de nenhum objeto.
        for item in respostas + self.store().audit:
            self.assertNotIn(len(VALOR), list(_valores(item)))
            self.assertNotIn(str(len(VALOR)), list(_valores(item)))
        registro = self.store().audit[-1]
        self.assertEqual(registro["action"], "panel.channel_account.secret_ref")
        self.assertEqual(registro["actorId"], "gastao")
        self.assertEqual(registro["objectId"], conta["id"])
        self.assertEqual(registro["data"]["field"], "accessToken")
        self.assertTrue(registro["data"]["vault_write"])
        self.assertNotIn("value", registro["data"])
        self.assertNotIn("length", registro["data"])

    def test_regravacao_reaproveita_a_referencia_e_troca_o_conteudo(self):
        token, csrf, conta = self.preparar()
        rota = f"{self.base()}/{conta['id']}/secrets/accessToken"
        primeira = self.call("PUT", rota, body={"value": VALOR}, cookie=token, csrf=csrf)
        segunda = self.call("PUT", rota, body={"value": VALOR + "-novo"}, cookie=token,
                            csrf=csrf)
        self.assertEqual(primeira[1]["secretRef"], segunda[1]["secretRef"])
        alvo = Path(self.raiz.name) / "dr-lucas" / "atendimento" / conta["id"] / "access_token"
        self.assertEqual(alvo.read_text(), VALOR + "-novo")
        self.assertEqual([p.name for p in alvo.parent.iterdir()], ["access_token"])

    def test_assinatura_sem_endpoint_responde_409_e_nao_grava(self):
        token, csrf, conta = self.preparar()
        status, corpo = self.call("PUT", f"{self.base()}/{conta['id']}/secrets/signature",
                                  body={"value": VALOR}, cookie=token, csrf=csrf)
        self.assertEqual((status, corpo["error"]), (409, "endpoint_nao_gerado"))
        self.assertEqual(list(Path(self.raiz.name).rglob("signature")), [])

    def test_campo_fora_do_provedor_e_valor_invalido_respondem_400(self):
        token, csrf, conta = self.preparar()
        casos = ((f"{self.base()}/{conta['id']}/secrets/smtpPassword", {"value": VALOR},
                  "campo_de_segredo_invalido"),
                 (f"{self.base()}/{conta['id']}/secrets/inventado", {"value": VALOR},
                  "campo_de_segredo_invalido"),
                 (f"{self.base()}/{conta['id']}/secrets/accessToken", {"value": "ab"},
                  "valor_invalido"),
                 (f"{self.base()}/{conta['id']}/secrets/accessToken", {"value": 42},
                  "valor_invalido"))
        for rota, corpo, esperado in casos:
            with self.subTest(codigo=esperado, rota=rota):
                status, resposta = self.call("PUT", rota, body=corpo, cookie=token,
                                             csrf=csrf)
                self.assertEqual((status, resposta["error"]), (400, esperado))
        self.assertEqual(list(Path(self.raiz.name).rglob("access_token")), [])

    def test_limite_por_sessao_corta_a_varredura(self):
        token, csrf, conta = self.preparar()
        rota = f"{self.base()}/{conta['id']}/secrets/accessToken"
        restantes = []
        for _ in range(self.quota.max_writes):
            status, corpo = self.call("PUT", rota, body={"value": VALOR}, cookie=token,
                                      csrf=csrf)
            self.assertEqual(status, 200)
            restantes.append(corpo["remainingAttempts"])
        self.assertEqual(restantes, [3, 2, 1, 0])
        status, corpo = self.call("PUT", rota, body={"value": VALOR}, cookie=token,
                                  csrf=csrf)
        self.assertEqual((status, corpo["error"]), (429, "muitas_gravacoes"))
        # Outra sessao tem orcamento proprio.
        outro_token, outro_csrf = self.login()
        self.assertEqual(self.call("PUT", rota, body={"value": VALOR}, cookie=outro_token,
                                   csrf=outro_csrf)[0], 200)

    def test_tentativa_invalida_tambem_gasta_orcamento(self):
        token, csrf, conta = self.preparar()
        rota = f"{self.base()}/{conta['id']}/secrets/accessToken"
        for _ in range(self.quota.max_writes):
            self.call("PUT", rota, body={"value": "x"}, cookie=token, csrf=csrf)
        status, corpo = self.call("PUT", rota, body={"value": VALOR}, cookie=token,
                                  csrf=csrf)
        self.assertEqual((status, corpo["error"]), (429, "muitas_gravacoes"))

    def test_cofre_somente_leitura_responde_409_e_nao_500(self):
        token, csrf, conta = self.preparar()

        def somente_leitura(*_a, **_k):
            raise OSError(errno.EROFS, "Read-only file system")

        original = tempfile.mkstemp
        tempfile.mkstemp = somente_leitura
        self.addCleanup(setattr, tempfile, "mkstemp", original)
        status, corpo = self.call("PUT", f"{self.base()}/{conta['id']}/secrets/accessToken",
                                  body={"value": VALOR}, cookie=token, csrf=csrf)
        tempfile.mkstemp = original
        self.assertEqual((status, corpo["error"]), (409, "cofre_somente_leitura"))
        self.assertIn("somente leitura", corpo["message"])
        self.assertNotIn(VALOR, json.dumps(corpo))
        self.assertEqual(self.store().audit[-1]["action"],
                         "panel.channel_account.create")

    def test_sem_cofre_configurado_a_subarvore_inteira_responde_503(self):
        app = PanelApplication(directory=OperatorDirectory(lambda: CADASTRO),
                               sessions=SessionStore(), catalog=Catalog(),
                               store_factory=self._store)
        self.app = app
        token, _ = self.login()
        status, corpo = self.call("GET", self.base(), cookie=token)
        self.assertEqual((status, corpo["error"]), (503, "cofre_nao_configurado"))


class CofreEmDiscoTests(unittest.TestCase):
    """O cofre em si: caminho, permissao, atomicidade e estado."""

    def setUp(self):
        self.raiz = tempfile.TemporaryDirectory()
        self.addCleanup(self.raiz.cleanup)
        self.root = Path(self.raiz.name)
        self.cofre = SecretVault(self.raiz.name)

    def test_recusa_caminho_relativo_absoluto_e_fora_do_formato(self):
        proibidos = ("../fora", "a/../../fora", "..", "/etc/passwd", "a//b", "./a",
                     "a/./b", "a b", "a\\b", "", "a/..", "a\x00b")
        for ref in proibidos:
            with self.subTest(ref=ref):
                with self.assertRaises(ConfigError) as erro:
                    self.cofre.target(ref)
                self.assertEqual(erro.exception.code, "secret_ref_invalido")
                # Referencia vazia e "sem segredo cadastrado"; o resto e caminho
                # malformado e nunca pode ser tratado como simples ausencia.
                self.assertEqual(self.cofre.state(ref),
                                 "ausente" if ref == "" else "invalido")
        self.assertEqual(list(self.root.rglob("*")), [])

    def test_recusa_symlink_no_alvo_e_no_diretorio_intermediario(self):
        fora = Path(self.raiz.name).parent / "alvo-fora-do-cofre"
        fora.write_text("nao me sobrescreva")
        self.addCleanup(fora.unlink)
        (self.root / "atalho").symlink_to(fora)
        (self.root / "pasta-atalho").symlink_to(fora.parent)
        for ref in ("atalho", "pasta-atalho/alvo-fora-do-cofre"):
            with self.subTest(ref=ref):
                with self.assertRaises(ConfigError) as erro:
                    self.cofre.write(ref, "valor-que-nao-deve-sair")
                self.assertEqual(erro.exception.code, "secret_ref_symlink")
        self.assertEqual(fora.read_text(), "nao me sobrescreva")

    def test_escrita_e_atomica_e_nao_deixa_temporario(self):
        self.cofre.write("cliente/agente/conta/api_key", "valor-original-1")
        alvo = self.root / "cliente" / "agente" / "conta" / "api_key"
        original = os.replace

        def falhar(*_a, **_k):
            raise OSError(errno.EIO, "falha na troca")

        os.replace = falhar
        try:
            with self.assertRaises(VaultUnavailable):
                self.cofre.write("cliente/agente/conta/api_key", "valor-novo-2")
        finally:
            os.replace = original
        self.assertEqual(alvo.read_text(), "valor-original-1")
        self.assertEqual([p.name for p in alvo.parent.iterdir()], ["api_key"])

    def test_estado_presente_ausente_e_invalido(self):
        ref = "cliente/agente/conta/api_key"
        self.assertEqual(self.cofre.state(None), "ausente")
        self.assertEqual(self.cofre.state(ref), "ausente")
        self.cofre.write(ref, "valor-de-teste-1")
        self.assertEqual(self.cofre.state(ref), "presente")
        alvo = self.root / "cliente" / "agente" / "conta" / "api_key"
        os.chmod(alvo, 0o644)
        self.assertEqual(self.cofre.state(ref), "invalido")
        os.chmod(alvo, 0o600)
        alvo.write_text("")
        self.assertEqual(self.cofre.state(ref), "invalido")
        (self.root / "diretorio").mkdir()
        self.assertEqual(self.cofre.state("diretorio"), "invalido")

    def test_o_cofre_nao_tem_nenhum_metodo_que_devolva_valor(self):
        publicos = [nome for nome in dir(self.cofre) if not nome.startswith("_")]
        self.assertEqual(sorted(publicos),
                         ["dir_mode", "file_mode", "max_bytes", "root", "state",
                          "target", "write"])
        self.cofre.write("cliente/agente/conta/api_key", "valor-de-teste-1")
        self.assertNotIn("valor-de-teste-1", str(self.cofre.state(
            "cliente/agente/conta/api_key")))

    def test_referencia_derivada_e_sempre_do_escopo_do_agente(self):
        ref = derive_secret_ref("dr-lucas", "atendimento", "ch_abc", "smtpPassword")
        self.assertEqual(ref, "dr-lucas/atendimento/ch_abc/smtp_password")
        self.assertIsNotNone(self.cofre.target(ref))
        with self.assertRaises(ConfigError):
            derive_secret_ref("dr-lucas", "atendimento", "ch_abc", "inventado")

    def test_valor_grande_demais_ou_vazio_nao_e_gravado(self):
        for valor in ("", "   ", "xyz", "segredo-longo-demais" * 2_000):
            with self.subTest(tamanho=len(valor)):
                with self.assertRaises(ConfigError) as erro:
                    self.cofre.write("cliente/agente/conta/api_key", valor)
                self.assertEqual(erro.exception.code, "valor_invalido")
                # Nem o valor nem o tamanho exato entram na mensagem de erro.
                mensagem = str(erro.exception.message)
                if valor.strip():
                    self.assertNotIn(valor.strip()[:20], mensagem)
                self.assertNotIn(str(len(valor)), mensagem)
        self.assertEqual(list(self.root.rglob("api_key")), [])


class PendenciasTests(BaseCanal):
    def estado(self, ref):
        return self.cofre.state(ref)

    def test_conta_meta_incompleta_lista_endpoint_e_token(self):
        conta = conta_vazia("ch_1", "whatsapp", "meta", "5511999")
        checklist = account_checklist(conta, self.estado)
        codigos = {(item["code"], item["field"]) for item in checklist["pendencias"]}
        self.assertIn(("segredo_ausente", "accessToken"), codigos)
        self.assertIn(("endpoint_nao_gerado", "publicEndpointId"), codigos)
        self.assertFalse(checklist["canActivate"])

    def test_provedor_incompativel_bloqueia_e_encerra_a_analise(self):
        conta = conta_vazia("ch_1", "email", "meta", "sac@x.com")
        checklist = account_checklist(conta, self.estado)
        self.assertEqual([item["code"] for item in checklist["pendencias"]],
                         ["provedor_incompativel"])
        self.assertFalse(checklist["canActivate"])

    def test_referencia_apontando_para_arquivo_ruim_vira_segredo_invalido(self):
        ref = "dr-lucas/atendimento/ch_1/api_key"
        self.cofre.write(ref, "chave-brevo-de-teste")
        os.chmod(Path(self.raiz.name) / "dr-lucas" / "atendimento" / "ch_1" / "api_key",
                 0o644)
        conta = conta_vazia("ch_1", "email", "brevo", "sac@x.com",
                            config={"sender_email": "sac@x.com"})
        conta["secretRefs"]["apiKey"] = ref
        checklist = account_checklist(conta, self.estado)
        pendencia = next(i for i in checklist["pendencias"] if i["field"] == "apiKey")
        self.assertEqual(pendencia["code"], "segredo_invalido")
        self.assertTrue(pendencia["blocks"])
        self.assertEqual(pendencia["secretRef"], ref)

    def test_config_obrigatoria_ausente_bloqueia_a_ativacao(self):
        conta = conta_vazia("ch_1", "email", "smtp", "sac@x.com",
                            config={"host": "smtp.cliente.com"})
        conta["secretRefs"]["smtpPassword"] = "dr-lucas/atendimento/ch_1/smtp_password"
        self.cofre.write(conta["secretRefs"]["smtpPassword"], "senha-smtp-de-teste")
        checklist = account_checklist(conta, self.estado)
        bloqueios = [i["field"] for i in checklist["pendencias"] if i["blocks"]]
        self.assertEqual(bloqueios, ["sender_email"])

    def test_conta_completa_pode_ativar_e_endpoint_de_email_nao_bloqueia(self):
        conta = conta_vazia("ch_1", "email", "brevo", "sac@x.com",
                            config={"sender_email": "sac@x.com"})
        conta["secretRefs"]["apiKey"] = "dr-lucas/atendimento/ch_1/api_key"
        self.cofre.write(conta["secretRefs"]["apiKey"], "chave-brevo-de-teste")
        checklist = account_checklist(conta, self.estado)
        self.assertTrue(checklist["canActivate"])
        self.assertEqual([i["code"] for i in checklist["pendencias"]],
                         ["endpoint_nao_gerado"])
        self.assertFalse(checklist["pendencias"][0]["blocks"])

    def test_rota_de_checklist_lista_canais_sem_conta(self):
        token, csrf = self.login()
        self.criar_conta(token, csrf)
        status, corpo = self.call(
            "GET", "/api/v1/panel/agents/dr-lucas/atendimento/channel-checklist",
            cookie=token)
        self.assertEqual(status, 200)
        self.assertEqual(corpo["channelsWithoutAccount"], ["instagram", "email"])
        self.assertFalse(corpo["ready"])
        self.assertEqual(corpo["accounts"][0]["channel"], "whatsapp")
        self.assertEqual(corpo["agent"]["tenantId"], "dr-lucas")

    def test_ativar_conta_com_pendencia_responde_409_com_a_lista(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        status, corpo = self.call("PATCH", f"{self.base()}/{conta['id']}",
                                  body={"status": "active"}, cookie=token, csrf=csrf)
        self.assertEqual((status, corpo["error"]), (409, "ativacao_com_pendencia"))
        self.assertTrue(all(item["blocks"] for item in corpo["pendencias"]))
        self.assertEqual(self.store().accounts[conta["id"]]["status"], "disabled")

    def test_referencia_preenchida_sem_arquivo_bloqueia_a_ativacao(self):
        """Regressao: referencia pendurada derruba o agente inteiro, nao so a conta.

        ``ProductionWorkerFactory.build`` resolve ``signature_secret_ref`` e
        ``verify_secret_ref`` de toda conta ativa. Um arquivo faltando levanta
        no build, ``ProductionReadiness`` devolve False e ``/readyz`` fica 503
        para o agente todo -- inclusive para os canais que estavam saudaveis.
        """
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        self.call("POST", f"{self.base()}/{conta['id']}/endpoint", body={},
                  cookie=token, csrf=csrf)
        self.call("PUT", f"{self.base()}/{conta['id']}/secrets/accessToken",
                  body={"value": VALOR}, cookie=token, csrf=csrf)
        status, corpo = self.call("PATCH", f"{self.base()}/{conta['id']}",
                                  body={"status": "active"}, cookie=token, csrf=csrf)
        self.assertEqual((status, corpo["error"]), (409, "ativacao_com_pendencia"))
        campos = {item["field"] for item in corpo["pendencias"]}
        self.assertEqual(campos, {"signature", "verify"})
        self.assertEqual(self.store().accounts[conta["id"]]["status"], "disabled")

    def test_imap_nao_bloqueia_porque_a_factory_nao_o_resolve(self):
        conta = conta_vazia("ch_1", "email", "smtp", "sac@x.com",
                            config={"host": "smtp.cliente.com",
                                    "sender_email": "sac@x.com"})
        conta["secretRefs"]["smtpPassword"] = "dr-lucas/atendimento/ch_1/smtp_password"
        self.cofre.write(conta["secretRefs"]["smtpPassword"], "senha-smtp-de-teste")
        conta["secretRefs"]["imapUsername"] = "dr-lucas/atendimento/ch_1/imap_username"
        checklist = account_checklist(conta, self.estado)
        imap = [i for i in checklist["pendencias"] if str(i["field"]).startswith("imap")]
        self.assertEqual({i["field"] for i in imap}, {"imapUsername", "imapPassword"})
        self.assertTrue(all(not i["blocks"] for i in imap))
        self.assertTrue(checklist["canActivate"])

    def test_ativacao_passa_quando_o_checklist_esta_limpo(self):
        token, csrf = self.login()
        conta = self.criar_conta(token, csrf)[1]["account"]
        self.call("POST", f"{self.base()}/{conta['id']}/endpoint", body={}, cookie=token,
                  csrf=csrf)
        for campo in ("signature", "verify", "accessToken"):
            self.call("PUT", f"{self.base()}/{conta['id']}/secrets/{campo}",
                      body={"value": VALOR}, cookie=token, csrf=csrf)
        status, corpo = self.call("PATCH", f"{self.base()}/{conta['id']}",
                                  body={"status": "active"}, cookie=token, csrf=csrf)
        self.assertEqual(status, 200)
        self.assertEqual(corpo["account"]["status"], "active")

    def test_conta_nova_nao_pode_nascer_ativa(self):
        with self.assertRaises(ConfigError) as erro:
            validate_new_account({"channel": "whatsapp", "provider": "meta",
                                  "externalAccountId": "5511999", "status": "active"})
        self.assertEqual(erro.exception.code, "ativacao_com_pendencia")

    def test_checklist_do_agente_agrega_contas_e_canais(self):
        contas = [conta_vazia("ch_1", "whatsapp", "meta", "5511999")]
        resumo = agent_checklist(contas, self.estado)
        self.assertEqual(resumo["channelsWithoutAccount"], ["instagram", "email"])
        self.assertFalse(resumo["ready"])


class OrcamentoDeGravacaoTests(unittest.TestCase):
    def test_orcamento_por_chave_reabre_depois_da_janela(self):
        agora = [0.0]
        quota = SecretWriteQuota(max_writes=2, window_seconds=10,
                                 clock=lambda: agora[0])
        self.assertTrue(quota.consume("a"))
        self.assertTrue(quota.consume("a"))
        self.assertFalse(quota.consume("a"))
        self.assertEqual(quota.remaining("a"), 0)
        self.assertTrue(quota.consume("b"))
        agora[0] = 11.0
        self.assertEqual(quota.remaining("a"), 2)
        self.assertTrue(quota.consume("a"))

    def test_limites_invalidos_falham_no_arranque(self):
        for kwargs in ({"max_writes": 0}, {"window_seconds": 0}):
            with self.subTest(**kwargs):
                with self.assertRaises(ValueError):
                    SecretWriteQuota(**kwargs)


class BaseDoWebhookTests(unittest.TestCase):
    def test_base_precisa_ser_https_salvo_loopback(self):
        self.assertEqual(normalize_webhook_base("https://sac.example.com/"),
                         "https://sac.example.com")
        self.assertEqual(normalize_webhook_base(""), "")
        self.assertEqual(normalize_webhook_base("http://127.0.0.1:8080"),
                         "http://127.0.0.1:8080")
        for ruim in ("http://sac.example.com", "ftp://x", "https://sac example.com"):
            with self.subTest(base=ruim):
                with self.assertRaises(ValueError):
                    normalize_webhook_base(ruim)

    def test_endpoint_gerado_cabe_no_check_do_banco(self):
        for _ in range(20):
            self.assertRegex(new_endpoint_id(), r"^[A-Za-z0-9_-]{16,128}$")


class StoreDeContasTests(unittest.TestCase):
    """SQL do control plane: escopo no WHERE e nenhum valor de segredo."""

    LINHA = ("ch_1", "whatsapp", "meta", "5511999", None, None, None, None, None,
             None, None, None, None, None, "WhatsApp", "disabled", "{}",
             "2026-09-10T00:00:00Z", "2026-09-10T00:00:00Z")

    class Cursor:
        def __init__(self, resultados):
            self.resultados = deque(resultados)
            self.executions = []

        def execute(self, sql, params=()):
            self.executions.append((" ".join(sql.split()), tuple(params)))

        def fetchone(self):
            return self.resultados.popleft() if self.resultados else None

        def fetchall(self):
            return self.resultados.popleft() if self.resultados else []

        def close(self):
            pass

    class Connection:
        def __init__(self, cursor):
            self.cur = cursor

        def cursor(self):
            return self.cur

        def commit(self):
            pass

        def rollback(self):
            pass

        def close(self):
            pass

    def store(self, resultados):
        cursor = self.Cursor(resultados)
        loja = PostgresStore(lambda: self.Connection(cursor), tenant_id="dr-lucas",
                             agent_id="atendimento", schema="sac_dr_lucas")
        return loja, cursor

    def test_listagem_filtra_por_tenant_e_agente_e_nao_usa_estrela(self):
        loja, cursor = self.store([[self.LINHA]])
        payload = loja.panel_channel_accounts()
        sql, params = cursor.executions[0]
        self.assertIn("WHERE tenant_id=%s AND agent_id=%s", sql)
        self.assertEqual(params, ("dr-lucas", "atendimento"))
        self.assertNotIn("*", sql)
        self.assertEqual(payload["accounts"][0]["id"], "ch_1")
        self.assertEqual(payload["accounts"][0]["secretRefs"]["accessToken"], None)

    def test_gravacao_de_referencia_manda_caminho_e_registra_auditoria_sem_valor(self):
        loja, cursor = self.store([self.LINHA, self.LINHA, ("77",)])
        resultado = loja.panel_record_channel_secret(
            "ch_1", field="accessToken", secret_ref="dr-lucas/atendimento/ch_1/access_token",
            actor_id="gastao", already_referenced=False)
        self.assertEqual(resultado["auditId"], "77")
        update = next(item for item in cursor.executions
                      if item[0].startswith("UPDATE"))
        self.assertIn("SET access_token_secret_ref=%s", update[0])
        self.assertEqual(update[1][0], "dr-lucas/atendimento/ch_1/access_token")
        self.assertEqual(update[1][1:], ("dr-lucas", "atendimento", "ch_1"))
        auditoria = next(item for item in cursor.executions if "sac_audit_log" in item[0])
        dados = json.loads(auditoria[1][-1])
        self.assertEqual(dados["secret_ref"], "dr-lucas/atendimento/ch_1/access_token")
        self.assertTrue(dados["vault_write"])
        self.assertNotIn("value", dados)
        self.assertNotIn("length", dados)
        self.assertNotIn("size", dados)

    def test_criacao_recusa_duplicidade_antes_do_insert(self):
        loja, cursor = self.store([(1,)])
        with self.assertRaises(PanelConflictError) as erro:
            loja.panel_create_channel_account(
                account_id="ch_1", channel="whatsapp", provider="meta",
                external_account_id="5511999", display_name=None, signature_header=None,
                status="disabled", config={}, actor_id="gastao")
        self.assertEqual(erro.exception.code, "conta_duplicada")
        self.assertTrue(all("INSERT" not in sql for sql, _ in cursor.executions))

    def test_conta_de_outro_escopo_levanta_keyerror(self):
        loja, _ = self.store([None])
        with self.assertRaises(KeyError):
            loja.panel_channel_account("ch_de_outro")

    def test_edicao_so_aceita_coluna_da_lista_branca(self):
        loja, _ = self.store([self.LINHA])
        with self.assertRaises(ValueError):
            loja.panel_update_channel_account(
                "ch_1", changes={"access_token_secret_ref": "x"}, actor_id="gastao")

    def test_endpoint_entra_junto_com_a_referencia_de_assinatura(self):
        completa = list(self.LINHA)
        completa[4] = "endpoint-opaco-de-teste-1"
        completa[5] = "dr-lucas/atendimento/ch_1/signature"
        loja, cursor = self.store([self.LINHA, tuple(completa), ("81",)])
        resultado = loja.panel_generate_channel_endpoint(
            "ch_1", endpoint_id="endpoint-opaco-de-teste-1",
            signature_ref="dr-lucas/atendimento/ch_1/signature",
            verify_ref="dr-lucas/atendimento/ch_1/verify", signature_header=None,
            actor_id="gastao")
        update = next(item for item in cursor.executions
                      if item[0].startswith("UPDATE"))
        self.assertIn("public_endpoint_id=%s,signature_secret_ref=%s", update[0])
        self.assertIn("AND public_endpoint_id IS NULL", update[0])
        self.assertTrue(resultado["created"])


if __name__ == "__main__":
    unittest.main()
