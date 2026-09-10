"""Origem de aquisicao normalizada: slug estavel e separada do canal."""

import unittest

from backend.origins import (UNKNOWN_SLUG, AcquisitionOrigin, normalize, slugify)


class SlugTests(unittest.TestCase):
    def test_slug_remove_acento_espaco_e_pontuacao(self):
        self.assertEqual(slugify("Mineração WhatsApp"), "mineracao_whatsapp")
        self.assertEqual(slugify("Kiwify · Carrinho Abandonado!"), "kiwify_carrinho_abandonado")
        self.assertEqual(slugify("  "), "")
        self.assertEqual(slugify(None), "")

    def test_slug_tem_tamanho_limitado(self):
        self.assertLessEqual(len(slugify("x" * 500)), 64)


class NormalizacaoTests(unittest.TestCase):
    def test_slug_explicito_prevalece(self):
        origem = normalize({"slug": "kiwify_carrinho", "label": "Carrinho abandonado",
                            "platform": "Kiwify", "campaign": "black-friday"})
        self.assertEqual(origem.slug, "kiwify_carrinho")
        self.assertEqual(origem.label, "Carrinho abandonado")
        self.assertEqual(origem.campaign, "black-friday")

    def test_slug_derivado_de_plataforma_e_origem(self):
        origem = normalize({"platform": "Kiwify", "source": "Carrinho Abandonado"})
        self.assertEqual(origem.slug, "kiwify_carrinho_abandonado")
        self.assertEqual(origem.label, "Kiwify · Carrinho Abandonado")

    def test_provedor_novo_nao_exige_alteracao_de_codigo(self):
        for payload, esperado in (({"platform": "Hotmart", "source": "boleto"}, "hotmart_boleto"),
                                  ({"source": "recuperador_de_vendas"}, "recuperador_de_vendas"),
                                  ({"platform": "Meta", "source": "Anúncios"}, "meta_anuncios")):
            with self.subTest(payload=payload):
                self.assertEqual(normalize(payload).slug, esperado)

    def test_origem_ausente_ou_invalida_vira_origem_nao_identificada(self):
        for payload in (None, {}, [], "texto", {"campaign": "so-campanha"}):
            with self.subTest(payload=payload):
                origem = normalize(payload)
                self.assertEqual(origem.slug, UNKNOWN_SLUG)
                self.assertFalse(origem.identified)

    def test_canal_da_origem_nao_e_inferido_e_so_aceita_canal_conhecido(self):
        self.assertIsNone(normalize({"source": "kiwify"}).channel)
        self.assertEqual(normalize({"source": "kiwify", "channel": "whatsapp"}).channel, "whatsapp")
        self.assertIsNone(normalize({"source": "kiwify", "channel": "sms"}).channel)
        self.assertIsNone(normalize({"source": "kiwify", "channel": "carrinho"}).channel)

    def test_projecao_publica_tem_o_contrato_do_painel(self):
        publico = normalize({"platform": "Kiwify", "source": "carrinho", "channel": "whatsapp",
                             "campaign": "bf"}).public()
        self.assertEqual(set(publico), {"slug", "label", "channel", "platform", "campaign"})
        self.assertEqual(publico["channel"], "whatsapp")

    def test_origem_desconhecida_preserva_canal_declarado(self):
        origem = normalize({"channel": "email"})
        self.assertEqual((origem.slug, origem.channel), (UNKNOWN_SLUG, "email"))

    def test_dataclass_e_imutavel(self):
        with self.assertRaises(Exception):
            AcquisitionOrigin("a", "b").slug = "c"


if __name__ == "__main__":
    unittest.main()
