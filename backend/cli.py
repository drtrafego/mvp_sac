"""Composition root operacional da homologacao multicanal.

Importar este modulo nao abre socket, banco ou rede. Todos os efeitos acontecem
somente depois de ``main`` selecionar um comando.
"""
from __future__ import annotations

import argparse
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path
from threading import Event
from time import sleep
from typing import Callable, Mapping
from wsgiref.simple_server import make_server

from .app import AppConfig, WebhookApplication
from .connectors import BrevoConnector, HermesClient, MetaConnector, SMTPConnector
from .imap_inbound import IMAPInbound
from .service import BackendService
from .store import SQLiteStore


@dataclass(frozen=True)
class Settings:
    tenant_id: str
    database_path: str
    host: str
    port: int
    poll_seconds: float
    meta_app_secret: str
    meta_verify_token: str
    email_webhook_secret: str
    email_signature_header: str
    email_account_id: str
    email_provider: str
    graph_url: str
    whatsapp_token: str | None
    instagram_token: str | None
    brevo_api_key: str | None
    email_sender: str | None
    email_sender_name: str
    smtp_host: str | None
    smtp_port: int
    smtp_username: str | None
    smtp_password: str | None
    smtp_starttls: bool
    smtp_ssl: bool
    imap_host: str | None
    imap_port: int
    imap_username: str | None
    imap_password: str | None
    imap_mailbox: str
    imap_ssl: bool
    imap_starttls: bool
    hermes_url: str
    hermes_api_key: str | None
    hermes_model: str
    force_dry_run: bool
    strict_config: bool

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "Settings":
        tenant = env.get("TENANT_ID", "").strip()
        if not tenant:
            raise ValueError("TENANT_ID e obrigatorio")
        try:
            port = int(env.get("BACKEND_PORT", "8080"))
            poll = float(env.get("WORKER_POLL_SECONDS", "1"))
            smtp_port = int(env.get("SMTP_PORT") or env.get("EMAIL_SMTP_PORT", "587"))
            imap_port = int(env.get("EMAIL_IMAP_PORT", "993"))
        except ValueError as exc:
            raise ValueError("BACKEND_PORT/WORKER_POLL_SECONDS invalidos") from exc
        if not 1 <= port <= 65535 or not 0.05 <= poll <= 60:
            raise ValueError("porta ou intervalo fora do limite")
        version = env.get("META_GRAPH_API_VERSION", "v23.0").strip().lstrip("/")
        settings = cls(
            tenant_id=tenant,
            database_path=env.get("DATABASE_PATH", "var/multicanal.sqlite3"),
            host=env.get("BACKEND_HOST", "127.0.0.1"), port=port, poll_seconds=poll,
            meta_app_secret=env.get("META_APP_SECRET", ""),
            meta_verify_token=env.get("META_VERIFY_TOKEN", ""),
            email_webhook_secret=env.get("EMAIL_WEBHOOK_SECRET", ""),
            email_signature_header=env.get("EMAIL_SIGNATURE_HEADER", "X-Email-Signature"),
            email_account_id=env.get("EMAIL_ACCOUNT_ID", "email"),
            email_provider=env.get("EMAIL_PROVIDER", "generic") or "generic",
            graph_url=f"https://graph.facebook.com/{version}",
            whatsapp_token=env.get("WHATSAPP_ACCESS_TOKEN") or None,
            instagram_token=env.get("INSTAGRAM_ACCESS_TOKEN") or None,
            brevo_api_key=env.get("BREVO_API_KEY") or None,
            email_sender=env.get("EMAIL_SENDER") or env.get("EMAIL_USERNAME") or None,
            email_sender_name=env.get("EMAIL_SENDER_NAME", "Hermes"),
            smtp_host=env.get("SMTP_HOST") or env.get("EMAIL_SMTP_HOST") or None, smtp_port=smtp_port,
            smtp_username=env.get("SMTP_USERNAME") or env.get("EMAIL_USERNAME") or None,
            smtp_password=env.get("SMTP_PASSWORD") or env.get("EMAIL_PASSWORD") or None,
            smtp_starttls=env.get("SMTP_STARTTLS", "true").strip().casefold() in {"1", "true", "yes", "sim"},
            smtp_ssl=env.get("SMTP_SSL", "false").strip().casefold() in {"1", "true", "yes", "sim"},
            imap_host=env.get("EMAIL_IMAP_HOST") or None, imap_port=imap_port,
            imap_username=env.get("EMAIL_IMAP_USERNAME") or env.get("EMAIL_USERNAME") or None,
            imap_password=env.get("EMAIL_IMAP_PASSWORD") or env.get("EMAIL_PASSWORD") or None,
            imap_mailbox=env.get("EMAIL_IMAP_MAILBOX", "INBOX"),
            imap_ssl=env.get("EMAIL_IMAP_SSL", "true").strip().casefold() in {"1", "true", "yes", "sim"},
            imap_starttls=env.get("EMAIL_IMAP_STARTTLS", "false").strip().casefold() in {"1", "true", "yes", "sim"},
            hermes_url=env.get("HERMES_BASE_URL", "http://127.0.0.1:8000"),
            hermes_api_key=env.get("HERMES_API_KEY") or None,
            hermes_model=env.get("HERMES_MODEL", "Hermes"),
            force_dry_run=env.get("DRY_RUN", "").strip().casefold() in {"1", "true", "yes", "sim"},
            strict_config=env.get("STRICT_CONFIG", "").strip().casefold() in {"1", "true", "yes", "sim"},
        )
        settings.validate_runtime()
        return settings

    def validate_runtime(self) -> None:
        """Falha fechado na ativacao; homologacao continua segura em dry-run."""
        if not self.strict_config or self.force_dry_run:
            return
        missing = []
        required = {
            "META_APP_SECRET": self.meta_app_secret,
            "META_VERIFY_TOKEN": self.meta_verify_token,
            "WHATSAPP_ACCESS_TOKEN": self.whatsapp_token,
            "INSTAGRAM_ACCESS_TOKEN": self.instagram_token,
            "HERMES_API_KEY": self.hermes_api_key,
            "EMAIL_WEBHOOK_SECRET": self.email_webhook_secret,
            "EMAIL_ACCOUNT_ID": self.email_account_id,
        }
        if self.email_provider == "brevo":
            required.update({"BREVO_API_KEY": self.brevo_api_key,
                             "EMAIL_SENDER": self.email_sender})
        elif self.email_provider == "smtp":
            required.update({"SMTP_HOST": self.smtp_host, "EMAIL_SENDER": self.email_sender})
            if self.smtp_ssl and self.smtp_starttls:
                missing.append("SMTP_SSL e SMTP_STARTTLS não podem estar ativos juntos")
        else:
            missing.append("EMAIL_PROVIDER deve ser brevo ou smtp")
        if self.imap_host:
            required.update({"EMAIL_IMAP_USERNAME": self.imap_username,
                             "EMAIL_IMAP_PASSWORD": self.imap_password})
            if self.imap_ssl and self.imap_starttls:
                missing.append("EMAIL_IMAP_SSL e EMAIL_IMAP_STARTTLS não podem estar ativos juntos")
        for name, value in required.items():
            if not value and name not in missing:
                missing.append(name)
        if missing:
            raise ValueError("variaveis obrigatorias ausentes: " + ", ".join(missing))


def build_service(settings: Settings) -> BackendService:
    path = Path(settings.database_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    store = SQLiteStore(path)
    hermes = HermesClient(settings.hermes_url, settings.hermes_api_key,
                          model=settings.hermes_model, dry_run=settings.force_dry_run)
    email_connector = (BrevoConnector(settings.brevo_api_key, settings.email_sender,
                                      sender_name=settings.email_sender_name,
                                      dry_run=settings.force_dry_run)
                       if settings.email_provider == "brevo" else
                       SMTPConnector(settings.smtp_host, settings.smtp_port, settings.smtp_username,
                                     settings.smtp_password, settings.email_sender,
                                     sender_name=settings.email_sender_name,
                                     starttls=settings.smtp_starttls, use_ssl=settings.smtp_ssl,
                                     dry_run=settings.force_dry_run))
    connectors = {
        "whatsapp": MetaConnector(settings.whatsapp_token, graph_url=settings.graph_url,
                                  dry_run=settings.force_dry_run),
        "instagram": MetaConnector(settings.instagram_token, graph_url=settings.graph_url,
                                   dry_run=settings.force_dry_run),
        "email": email_connector,
    }
    return BackendService(settings.tenant_id, store, hermes, connectors)


def build_application(settings: Settings, service: BackendService) -> WebhookApplication:
    config = AppConfig(
        settings.meta_app_secret, settings.meta_verify_token, settings.email_webhook_secret,
        brevo_signature_header=settings.email_signature_header,
        email_account_id=settings.email_account_id, email_provider=settings.email_provider,
    )
    return WebhookApplication(config, service)


def run_worker(operation: Callable[[], bool], stop: Event, poll_seconds: float,
               sleeper: Callable[[float], None] = sleep) -> None:
    while not stop.is_set():
        processed = operation()
        if not processed:
            sleeper(poll_seconds)


def _install_stop_handlers(stop: Event) -> None:
    def request_stop(_signum, _frame):
        stop.set()
    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)


def _parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Backend multicanal Hermes (homologacao)")
    parser.add_argument("command", choices=("server", "worker-inbound", "worker-outbound", "worker-email-imap"))
    return parser


def main(argv: list[str] | None = None, env: Mapping[str, str] = os.environ) -> int:
    args = _parser().parse_args(argv)
    try:
        settings = Settings.from_env(env)
        service = build_service(settings)
    except ValueError as exc:
        print(f"configuracao invalida: {exc}", file=sys.stderr)
        return 2
    stop = Event()
    _install_stop_handlers(stop)
    if args.command == "server":
        app = build_application(settings, service)
        with make_server(settings.host, settings.port, app) as server:
            server.timeout = 1
            while not stop.is_set():
                server.handle_request()
        return 0
    if args.command == "worker-email-imap":
        if not settings.imap_host or not settings.imap_username or not settings.imap_password:
            print("configuracao invalida: variaveis IMAP ausentes", file=sys.stderr)
            return 2
        operation = IMAPInbound(
            host=settings.imap_host, port=settings.imap_port,
            username=settings.imap_username, password=settings.imap_password,
            account_id=settings.email_account_id, mailbox=settings.imap_mailbox,
            use_ssl=settings.imap_ssl, starttls=settings.imap_starttls, sink=service,
        ).poll_once
    else:
        operation = (service.process_inbound_once if args.command == "worker-inbound"
                     else service.dispatch_once)
    run_worker(operation, stop, settings.poll_seconds)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
