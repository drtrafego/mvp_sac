import hashlib
import hmac
import os
import unittest
from unittest.mock import patch

from adapters import dedupe_key, verify_meta_challenge, verify_meta_signature
from healthcheck import inspect_env


class OfflineTests(unittest.TestCase):
    def test_meta_signature(self):
        body, secret = b'{"ok":true}', "segredo-bem-grande"
        sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
        self.assertTrue(verify_meta_signature(body, sig, secret))
        self.assertFalse(verify_meta_signature(body + b"x", sig, secret))
        self.assertFalse(verify_meta_signature(body, None, secret))

    def test_challenge(self):
        self.assertEqual(verify_meta_challenge("subscribe", "token-correto", "123", "token-correto"), "123")
        self.assertIsNone(verify_meta_challenge("subscribe", "errado", "123", "token-correto"))

    def test_dedupe_is_stable_and_namespaced(self):
        self.assertEqual(dedupe_key("whatsapp", "abc"), "whatsapp:abc")
        self.assertNotEqual(dedupe_key("whatsapp", "abc"), dedupe_key("instagram", "abc"))
        self.assertEqual(dedupe_key("email", None, {"b": 2, "a": 1}), dedupe_key("email", None, {"a": 1, "b": 2}))

    def test_healthcheck_does_not_return_values(self):
        secret = "nao-pode-aparecer-123"
        with patch.dict(os.environ, {"META_APP_SECRET": secret}, clear=True):
            report = inspect_env()
        self.assertNotIn(secret, repr(report))
        self.assertEqual(report["meta"]["META_APP_SECRET"], "presente")

    def test_healthcheck_uses_runtime_email_names(self):
        env = {
            "EMAIL_PROVIDER": "brevo",
            "EMAIL_ACCOUNT_ID": "conta-isabella",
            "EMAIL_WEBHOOK_SECRET": "segredo-webhook-123",
            "EMAIL_SIGNATURE_HEADER": "X-Email-Signature",
            "EMAIL_SENDER": "sac@example.com",
            "BREVO_API_KEY": "chave-brevo-123",
        }
        with patch.dict(os.environ, env, clear=True):
            report = inspect_env()
        self.assertEqual(report["email"]["EMAIL_SENDER"], "presente")
        self.assertEqual(report["email"]["BREVO_API_KEY"], "presente")
        self.assertNotIn("BREVO_SENDER_EMAIL", report["email"])

    def test_healthcheck_switches_requirements_for_smtp(self):
        with patch.dict(os.environ, {"EMAIL_PROVIDER": "smtp"}, clear=True):
            report = inspect_env()
        self.assertIn("EMAIL_SMTP_HOST", report["email"])
        self.assertIn("EMAIL_USERNAME", report["email"])
        self.assertNotIn("BREVO_API_KEY", report["email"])


if __name__ == "__main__":
    unittest.main()
