"""Contrato estatico do painel: sem simulacao, sem origem escrita na mao."""

import json
import re
import unittest
from pathlib import Path

PAINEL = Path(__file__).resolve().parents[1] / "painel"
APP = (PAINEL / "app.js").read_text(encoding="utf-8")
INDEX = (PAINEL / "index.html").read_text(encoding="utf-8")
DATA = json.loads((PAINEL / "data.json").read_text(encoding="utf-8"))


class SemSimulacaoTests(unittest.TestCase):
    def test_painel_nao_mantem_mais_atendimento_simulado(self):
        for termo in ("simulatedConversations", "Simular contato", "Simulação manual",
                      "demo-${Date.now()}", "restaurar simulações"):
            with self.subTest(termo=termo):
                self.assertNotIn(termo, APP)
                self.assertNotIn(termo, INDEX)

    def test_localstorage_guarda_apenas_preferencia_de_navegacao(self):
        gravacoes = re.findall(r"localStorage\.setItem\(([^;]+?)\)\s*;", APP, re.S)
        self.assertEqual(len(gravacoes), 1)
        gravado = gravacoes[0]
        for campo in ("sourceId", "channel", "originSlug"):
            self.assertIn(campo, gravado)
        for proibido in ("conversations", "messages", "pipeline", "csrfToken", "password"):
            with self.subTest(proibido=proibido):
                self.assertNotIn(proibido, gravado)

    def test_chave_antiga_de_simulacao_e_apagada_no_boot(self):
        self.assertIn("sac-hermes-homologacao-v2", APP)
        self.assertIn("localStorage.removeItem", APP)

    def test_fallback_de_backend_indisponivel_e_visivel_e_nao_simula(self):
        self.assertIn("Backend v2 indisponível", APP)
        self.assertIn("nada é exibido por simulação", APP)


class VocabularioTests(unittest.TestCase):
    def test_nao_cimenta_o_vocabulario_real_versus_teste(self):
        for termo in ("REAL_MODE", "SIMULATED_MODE", "isReal(", "dataMode",
                      "real-readonly", "mode-badge", '"REAL"', '"TESTE"'):
            with self.subTest(termo=termo):
                self.assertNotIn(termo, APP)
                self.assertNotIn(termo, INDEX)

    def test_a_distincao_e_permissao_de_escrita_da_fonte(self):
        self.assertIn("permissions", APP)
        self.assertIn("source.permissions?.write", APP)
        self.assertIn("somente leitura", APP)


class OrigemEstruturadaTests(unittest.TestCase):
    LITERAIS = ("Mineração WhatsApp", "Mineração E-mail", "Anúncios",
                "sourceLabels", "sourceKeyByOrigin")

    def test_origem_nao_e_string_fixa_no_frontend(self):
        for literal in self.LITERAIS:
            with self.subTest(literal=literal):
                self.assertNotIn(literal, APP)

    def test_filtro_de_origem_usa_slug_e_nao_rotulo(self):
        self.assertIn("state.originSlug", APP)
        self.assertIn("origin.slug", APP)
        self.assertNotIn("item.origin === state.origin", APP)

    def test_origem_e_canal_seguem_campos_separados(self):
        self.assertIn("function originView(", APP)
        self.assertIn("function channelView(", APP)
        self.assertNotIn("origin.channel = item.channel", APP)

    def test_apresentacao_tem_ponto_unico_e_aceita_camada_externa(self):
        self.assertIn("window.SACOrigens", APP)
        for funcao in ("originChip(", "channelChip(", "stageView(", "originGrid("):
            with self.subTest(funcao=funcao):
                self.assertIn(funcao, APP)

    def test_index_carrega_a_camada_de_apresentacao_antes_da_camada_de_dados(self):
        self.assertIn('<script src="origens.js" defer></script>', INDEX)
        self.assertIn('<link rel="stylesheet" href="origens.css">', INDEX)
        self.assertLess(INDEX.index('src="origens.js"'), INDEX.index('src="app.js"'))

    def test_camada_de_dados_nao_desenha_marca_nem_svg(self):
        for proibido in ("<svg", "<path", "viewBox", "#25D366"):
            with self.subTest(proibido=proibido):
                self.assertNotIn(proibido, APP)


class TransporteTests(unittest.TestCase):
    def test_escrita_envia_csrf_e_cookie_de_mesma_origem(self):
        self.assertIn("X-SAC-Panel-CSRF", APP)
        self.assertIn('credentials:"same-origin"', APP)

    def test_base_da_api_vem_de_configuracao_e_nao_de_host_fixo(self):
        self.assertEqual(DATA["panelApi"]["baseUrl"], "api/")
        self.assertNotIn("127.0.0.1:8188", APP)
        self.assertNotIn("http://", APP)

    def test_data_json_nao_carrega_mais_conversas_nem_segredo(self):
        self.assertNotIn("conversations", DATA)
        texto = json.dumps(DATA).lower()
        for proibido in ("password", "senha", "secret", "token"):
            with self.subTest(proibido=proibido):
                self.assertNotIn(proibido, texto)

    def test_index_tem_dialogo_de_sessao_e_nao_tem_dialogo_de_simulacao(self):
        self.assertIn('id="login-dialog"', INDEX)
        self.assertIn('id="session-button"', INDEX)
        self.assertNotIn('id="contact-dialog"', INDEX)
        self.assertNotIn('id="new-contact"', INDEX)

    def test_composer_continua_sem_envio_externo(self):
        self.assertIn('<input disabled placeholder="Resposta ao contato desativada', APP)
        self.assertIn('<button class="primary" disabled>Enviar</button>', APP)


if __name__ == "__main__":
    unittest.main()
