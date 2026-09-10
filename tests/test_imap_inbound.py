import unittest
from email.message import EmailMessage

from backend.imap_inbound import IMAPInbound


class Sink:
    def __init__(self): self.items = []
    def persist(self, items): self.items.extend(items)


class FakeIMAP:
    def __init__(self, raw): self.raw, self.stores = raw, []
    def login(self, *_): pass
    def select(self, *_): return "OK", [b"1"]
    def uid(self, command, *args):
        if command == "search": return "OK", [b"7"]
        if command == "fetch": return "OK", [(b"7 (RFC822)", self.raw), b")"]
        if command == "store": self.stores.append(args); return "OK", []
    def logout(self): pass


class IMAPTests(unittest.TestCase):
    def test_persiste_antes_de_marcar_lida(self):
        msg = EmailMessage()
        msg["From"] = "Pessoa <Pessoa@Example.com>"
        msg["To"] = "Bella <bella@example.com>"
        msg["Subject"] = "Olá"
        msg["Message-ID"] = "<mail-1@example.com>"
        msg["Date"] = "Tue, 08 Sep 2026 20:00:00 +0000"
        msg.set_content("Quero conversar")
        sink, clients = Sink(), []
        def factory(*_):
            client = FakeIMAP(msg.as_bytes()); clients.append(client); return client
        worker = IMAPInbound(host="imap.example.com", port=993, username="u", password="p",
                             account_id="bella@example.com", sink=sink, factory=factory)
        self.assertTrue(worker.poll_once())
        self.assertEqual(sink.items[0].identity.external_user_id, "pessoa@example.com")
        self.assertEqual(sink.items[0].message["text"].strip(), "Quero conversar")
        self.assertTrue(clients[0].stores)

    def test_nao_marca_lida_quando_persistencia_falha(self):
        msg = EmailMessage(); msg["From"] = "a@example.com"; msg.set_content("oi")
        class Fail:
            def persist(self, _): raise RuntimeError("db")
        client = FakeIMAP(msg.as_bytes())
        worker = IMAPInbound(host="h", port=993, username="u", password="p",
                             account_id="inbox", sink=Fail(), factory=lambda *_: client)
        with self.assertRaises(RuntimeError): worker.poll_once()
        self.assertEqual(client.stores, [])


if __name__ == "__main__": unittest.main()
