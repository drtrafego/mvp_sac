import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class RuntimeV2ArtifactsTests(unittest.TestCase):
    def test_dependency_postgres_is_pinned(self):
        requirements = (ROOT / "requirements-v2.txt").read_text()
        self.assertRegex(requirements, r"(?m)^psycopg\[binary\]==\d+\.\d+\.\d+$")

    def test_image_runs_unprivileged_and_separate_cli(self):
        dockerfile = (ROOT / "Dockerfile.v2").read_text()
        self.assertIn("USER 10001:10001", dockerfile)
        self.assertIn('backend.runtime_v2", "server', dockerfile)
        self.assertNotIn("backend.cli", dockerfile)

    def test_compose_has_server_worker_readonly_and_readiness(self):
        compose = (ROOT / "compose.v2.yaml").read_text()
        self.assertIn("  sac-server:", compose)
        self.assertIn("  sac-worker:", compose)
        self.assertIn("/readyz", compose)
        self.assertGreaterEqual(compose.count("read_only: true"), 2)
        self.assertIn('backend.runtime_v2", "worker', compose)

    def test_env_example_nao_contem_valores_de_segredos(self):
        env = (ROOT / ".env.v2.example").read_text()
        forbidden = ("API_KEY=", "ACCESS_TOKEN=", "PASSWORD=", "APP_SECRET=")
        self.assertFalse(any(token in env for token in forbidden))
        self.assertIn("SECRET_DIR=/run/secrets/sac", env)


if __name__ == "__main__": unittest.main()
