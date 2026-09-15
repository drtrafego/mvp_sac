"""A sonda do HEALTHCHECK precisa manter o criterio do comando que substituiu:
saida 0 somente em 200, e nenhum import caro alem de ``socket``."""
import socket
import sys
import threading
import unittest

import readyz_probe


class FakeHTTPServer:
    """Servidor de uma conexao que responde com bytes fixos, opcionalmente picotados."""

    def __init__(self, chunks):
        self.chunks = chunks
        self.request = b""
        self.listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.listener.bind(("127.0.0.1", 0))
        self.listener.listen(1)
        self.port = self.listener.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)

    def _serve(self):
        try:
            conn, _ = self.listener.accept()
        except OSError:
            return
        with conn:
            conn.settimeout(5)
            try:
                self.request = conn.recv(4096)
                for chunk in self.chunks:
                    conn.sendall(chunk)
            except OSError:
                pass

    def __enter__(self):
        self.thread.start()
        return self

    def __exit__(self, *exc):
        self.listener.close()
        self.thread.join(timeout=5)


OK = [b"HTTP/1.0 200 OK\r\nContent-Length: 2\r\n\r\n{}"]
UNAVAILABLE = [b"HTTP/1.0 503 Service Unavailable\r\nContent-Length: 2\r\n\r\n{}"]


class ProbeTests(unittest.TestCase):
    def test_200_sai_zero(self):
        with FakeHTTPServer(OK) as server:
            self.assertEqual(readyz_probe.probe("127.0.0.1", server.port), 0)

    def test_503_sai_um(self):
        with FakeHTTPServer(UNAVAILABLE) as server:
            self.assertEqual(readyz_probe.probe("127.0.0.1", server.port), 1)

    def test_http_1_1_tambem_e_aceito(self):
        with FakeHTTPServer([b"HTTP/1.1 200 OK\r\n\r\n"]) as server:
            self.assertEqual(readyz_probe.probe("127.0.0.1", server.port), 0)

    def test_status_partido_em_varios_pacotes(self):
        """readline nao pode se enganar com leitura curta do socket."""
        with FakeHTTPServer([b"HTTP/1.0 ", b"200 OK\r\n", b"\r\n"]) as server:
            self.assertEqual(readyz_probe.probe("127.0.0.1", server.port), 0)

    def test_resposta_vazia_sai_um(self):
        with FakeHTTPServer([]) as server:
            self.assertEqual(readyz_probe.probe("127.0.0.1", server.port), 1)

    def test_envia_get_no_caminho_pedido(self):
        with FakeHTTPServer(OK) as server:
            readyz_probe.probe("127.0.0.1", server.port, "/readyz")
        self.assertTrue(server.request.startswith(b"GET /readyz HTTP/1.1\r\n"))
        self.assertIn(b"Connection: close\r\n", server.request)


class MainTests(unittest.TestCase):
    def test_conexao_recusada_sai_um_sem_traceback(self):
        livre = socket.socket()
        livre.bind(("127.0.0.1", 0))
        porta = livre.getsockname()[1]
        livre.close()
        self.assertEqual(readyz_probe.main([str(porta), "/readyz", "1"]), 1)

    def test_sem_argumentos_sai_dois(self):
        self.assertEqual(readyz_probe.main([]), 2)

    def test_porta_invalida_sai_dois(self):
        self.assertEqual(readyz_probe.main(["nao-e-porta"]), 2)

    def test_main_devolve_zero_para_200(self):
        with FakeHTTPServer(OK) as server:
            self.assertEqual(readyz_probe.main([str(server.port), "/readyz", "5"]), 0)

    def test_nao_importa_urllib(self):
        """O ganho todo vem de nao puxar urllib.request; trave isso."""
        self.assertNotIn("urllib.request", sys.modules.get("readyz_probe").__dict__)
        fonte = readyz_probe.__file__
        with open(fonte, encoding="utf-8") as handle:
            corpo = handle.read()
        for linha in corpo.splitlines():
            despido = linha.strip()
            if despido.startswith(("import ", "from ")):
                self.assertNotIn("urllib", despido)
                self.assertNotIn("http.client", despido)


if __name__ == "__main__":
    unittest.main()
