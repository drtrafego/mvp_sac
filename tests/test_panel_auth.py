"""Identidade do operador do painel: hash no cofre, sessao server-side, freio."""

import json
import unittest

from backend.panel_auth import (
    AgentGrant, LoginThrottle, MIN_ITERATIONS, Operator, OperatorDirectory,
    SessionStore, hash_password, verify_password,
)

SENHA = "senha-de-homologacao-1"
HASH = hash_password(SENHA, iterations=MIN_ITERATIONS)


def cadastro(**alteracoes):
    base = {"operators": [
        {"id": "gastao", "displayName": "Gastao", "passwordHash": HASH,
         "agents": [{"tenantId": "dr-lucas", "agentId": "atendimento"},
                    {"tenantId": "gramado-plazza", "agentId": "atendimento"}]},
        {"id": "operadora-b", "displayName": "Operadora B", "passwordHash": HASH,
         "agents": [{"tenantId": "bella-franklin", "agentId": "atendimento"}]},
    ]}
    base.update(alteracoes)
    return json.dumps(base)


class SenhaTests(unittest.TestCase):
    def test_hash_confere_apenas_com_a_senha_certa(self):
        self.assertTrue(verify_password(SENHA, HASH))
        self.assertFalse(verify_password("senha-de-homologacao-2", HASH))

    def test_hash_nao_guarda_a_senha_em_texto(self):
        self.assertNotIn(SENHA, HASH)
        self.assertTrue(HASH.startswith("pbkdf2_sha256$"))

    def test_formato_invalido_nunca_autoriza(self):
        for invalido in ("", "x", "pbkdf2_sha256$1$aaaa$bbbb", "md5$1$a$b",
                         f"pbkdf2_sha256${MIN_ITERATIONS}$nao-base64$!!", None):
            with self.subTest(invalido=invalido):
                self.assertFalse(verify_password(SENHA, invalido))

    def test_recusa_senha_curta_e_iteracoes_baixas(self):
        with self.assertRaises(ValueError):
            hash_password("curta")
        with self.assertRaises(ValueError):
            hash_password(SENHA, iterations=1000)


class CadastroTests(unittest.TestCase):
    def diretorio(self, texto=None):
        return OperatorDirectory(lambda: texto if texto is not None else cadastro())

    def test_autentica_e_devolve_apenas_os_agentes_cadastrados(self):
        operador = self.diretorio().authenticate("gastao", SENHA)
        self.assertEqual(operador.id, "gastao")
        self.assertTrue(operador.allows("dr-lucas", "atendimento"))
        self.assertFalse(operador.allows("bella-franklin", "atendimento"))
        self.assertFalse(operador.allows("dr-lucas", "outro-agente"))

    def test_senha_errada_e_operador_inexistente_nao_autenticam(self):
        diretorio = self.diretorio()
        self.assertIsNone(diretorio.authenticate("gastao", "senha-errada-mesmo"))
        self.assertIsNone(diretorio.authenticate("nao-existe", SENHA))
        self.assertIsNone(diretorio.authenticate("", SENHA))

    def test_projecao_publica_nao_expoe_hash(self):
        publico = self.diretorio().authenticate("gastao", SENHA).public()
        serializado = json.dumps(publico)
        self.assertNotIn("passwordHash", serializado)
        self.assertNotIn("pbkdf2", serializado)
        self.assertNotIn(HASH, serializado)

    def test_cadastro_invalido_falha_fechado_sem_vazar_conteudo(self):
        casos = ("{}", "[]", "nao-json", json.dumps({"operators": []}),
                 json.dumps({"operators": [{"id": "SEM-HASH"}]}),
                 json.dumps({"operators": [{"id": "a", "passwordHash": HASH},
                                           {"id": "a", "passwordHash": HASH}]}))
        for texto in casos:
            with self.subTest(texto=texto[:24]):
                with self.assertRaises(LookupError):
                    self.diretorio(texto).authenticate("gastao", SENHA)

    def test_cadastro_recarregado_a_cada_consulta(self):
        conteudos = [cadastro(), json.dumps({"operators": [
            {"id": "gastao", "passwordHash": HASH, "agents": []}]})]
        diretorio = OperatorDirectory(lambda: conteudos.pop(0))
        self.assertTrue(diretorio.authenticate("gastao", SENHA).allows("dr-lucas", "atendimento"))
        self.assertFalse(diretorio.authenticate("gastao", SENHA).allows("dr-lucas", "atendimento"))

    def test_grant_com_identificador_invalido_e_recusado(self):
        with self.assertRaises(ValueError):
            AgentGrant("Tenant Com Espaco", "atendimento")


class FreioTests(unittest.TestCase):
    def test_bloqueia_depois_do_limite_e_libera_apos_a_janela(self):
        agora = [0.0]
        freio = LoginThrottle(max_failures=3, window_seconds=60, clock=lambda: agora[0])
        for _ in range(3):
            freio.register_failure("gastao")
        self.assertTrue(freio.blocked("gastao"))
        self.assertFalse(freio.blocked("outro"))
        agora[0] = 61.0
        self.assertFalse(freio.blocked("gastao"))

    def test_sucesso_zera_o_contador(self):
        freio = LoginThrottle(max_failures=2, window_seconds=60)
        freio.register_failure("gastao")
        freio.reset("gastao")
        freio.register_failure("gastao")
        self.assertFalse(freio.blocked("gastao"))


class SessaoTests(unittest.TestCase):
    operador = Operator("gastao", "Gastao", (AgentGrant("dr-lucas", "atendimento"),))

    def test_token_opaco_resolve_a_sessao_e_nao_fica_em_texto(self):
        loja = SessionStore()
        token, sessao = loja.create(self.operador)
        self.assertNotEqual(token, sessao.key)
        self.assertNotIn(token, loja._sessions)
        self.assertIs(loja.resolve(token).operator, self.operador)
        self.assertIsNone(loja.resolve("token-inventado"))
        self.assertIsNone(loja.resolve(""))

    def test_sessao_expira_por_ttl_e_por_ociosidade(self):
        agora = [1000.0]
        loja = SessionStore(ttl_seconds=100, idle_seconds=50, clock=lambda: agora[0])
        token, _ = loja.create(self.operador)
        agora[0] += 40
        self.assertIsNotNone(loja.resolve(token))
        agora[0] += 60
        self.assertIsNone(loja.resolve(token))
        outro, _ = loja.create(self.operador)
        agora[0] += 200
        self.assertIsNone(loja.resolve(outro))

    def test_logout_invalida_a_sessao(self):
        loja = SessionStore()
        token, _ = loja.create(self.operador)
        self.assertTrue(loja.destroy(token))
        self.assertIsNone(loja.resolve(token))
        self.assertFalse(loja.destroy(token))

    def test_limite_de_sessoes_descarta_a_mais_antiga(self):
        agora = [0.0]
        loja = SessionStore(max_sessions=2, clock=lambda: agora[0])
        primeiro, _ = loja.create(self.operador)
        agora[0] += 1
        segundo, _ = loja.create(self.operador)
        agora[0] += 1
        terceiro, _ = loja.create(self.operador)
        self.assertIsNone(loja.resolve(primeiro))
        self.assertIsNotNone(loja.resolve(segundo))
        self.assertIsNotNone(loja.resolve(terceiro))

    def test_csrf_e_proprio_de_cada_sessao(self):
        loja = SessionStore()
        _, uma = loja.create(self.operador)
        _, outra = loja.create(self.operador)
        self.assertNotEqual(uma.csrf_token, outra.csrf_token)


if __name__ == "__main__":
    unittest.main()
