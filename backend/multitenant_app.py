"""Gateway WSGI seguro para webhooks de multiplos clientes."""
from __future__ import annotations

import json
import re
from dataclasses import replace
from typing import Protocol
from urllib.parse import parse_qs

from adapters import verify_meta_challenge, verify_meta_signature, verify_shared_secret
from multicanal import NormalizedEnvelope

from .app import _email_envelope, _meta_envelopes
from .tenant_registry import SecretResolver, TenantBinding, TenantRegistry


class TenantEnvelopeSink(Protocol):
    def persist_for_tenant(
        self, binding: TenantBinding, envelopes: tuple[NormalizedEnvelope, ...]
    ) -> None: ...


_ENDPOINT = re.compile(r"^[A-Za-z0-9_-]{16,128}$")


class MultiTenantWebhookApplication:
    """Resolve tenant pelo path e valida segredo/conta antes da persistencia."""

    def __init__(self, registry: TenantRegistry, secrets: SecretResolver,
                 sink: TenantEnvelopeSink, *, max_body_bytes: int = 1_048_576) -> None:
        self.registry, self.secrets, self.sink = registry, secrets, sink
        self.max_body_bytes = max_body_bytes

    @staticmethod
    def _reply(start_response, status: str, body: bytes, content_type: str = "application/json"):
        start_response(status, [("Content-Type", content_type), ("Content-Length", str(len(body)))])
        return [body]

    def __call__(self, environ, start_response):
        path = environ.get("PATH_INFO", "")
        prefix = "/webhooks/v2/"
        endpoint_id = path[len(prefix):] if path.startswith(prefix) else ""
        if not _ENDPOINT.fullmatch(endpoint_id):
            return self._reply(start_response, "404 Not Found", b'{"error":"not_found"}')
        try:
            binding = self.registry.resolve(endpoint_id)
        except Exception:
            return self._reply(start_response, "503 Service Unavailable", b'{"error":"registry_unavailable"}')
        if binding is None:
            return self._reply(start_response, "404 Not Found", b'{"error":"not_found"}')

        method = environ.get("REQUEST_METHOD", "GET")
        if method == "GET" and binding.provider == "meta" and binding.verify_secret_ref:
            query = parse_qs(environ.get("QUERY_STRING", ""))
            try:
                expected = self.secrets.resolve(binding.verify_secret_ref)
            except Exception:
                return self._reply(start_response, "503 Service Unavailable", b'{"error":"secret_unavailable"}')
            challenge = verify_meta_challenge(
                query.get("hub.mode", [None])[0], query.get("hub.verify_token", [None])[0],
                query.get("hub.challenge", [None])[0], expected,
            )
            if challenge is None:
                return self._reply(start_response, "403 Forbidden", b'{"error":"forbidden"}')
            return self._reply(start_response, "200 OK", challenge.encode(), "text/plain")
        if method != "POST":
            return self._reply(start_response, "404 Not Found", b'{"error":"not_found"}')

        try:
            length = int(environ.get("CONTENT_LENGTH") or 0)
        except ValueError:
            return self._reply(start_response, "400 Bad Request", b'{"error":"bad_length"}')
        if length < 0 or length > self.max_body_bytes:
            return self._reply(start_response, "413 Payload Too Large", b'{"error":"too_large"}')
        raw = environ["wsgi.input"].read(length)
        try:
            secret = self.secrets.resolve(binding.signature_secret_ref)
        except Exception:
            return self._reply(start_response, "503 Service Unavailable", b'{"error":"secret_unavailable"}')
        if binding.provider == "meta":
            valid = verify_meta_signature(raw, environ.get("HTTP_X_HUB_SIGNATURE_256"), secret)
        else:
            header = binding.signature_header or "X-Webhook-Signature"
            key = "HTTP_" + header.upper().replace("-", "_")
            valid = verify_shared_secret(environ.get(key), secret)
        if not valid:
            return self._reply(start_response, "401 Unauthorized", b'{"error":"invalid_signature"}')

        try:
            payload = json.loads(raw)
            if not isinstance(payload, dict):
                raise ValueError("payload deve ser objeto")
            # Campos tenant_id/agent_id do payload sao deliberadamente ignorados.
            if binding.provider == "meta":
                envelopes = tuple(_meta_envelopes(payload))
            elif binding.channel == "email":
                envelopes = (_email_envelope(payload, binding.external_account_id, binding.provider),)
            else:
                raise ValueError("provedor/canal incompatível")
            if not envelopes:
                return self._reply(start_response, "200 OK", b'{"status":"ignored"}')
            if any(e.channel != binding.channel or e.provider != binding.provider or
                   e.account_id != binding.external_account_id for e in envelopes):
                return self._reply(start_response, "403 Forbidden", b'{"error":"binding_mismatch"}')
            # O data plane guarda somente a chave interna da conta. A identidade
            # externa nunca atravessa esta fronteira como FK confiavel.
            normalized = tuple(replace(
                envelope,
                account_id=binding.account_id,
                identity=replace(envelope.identity, account_id=binding.account_id),
            ) for envelope in envelopes)
            self.sink.persist_for_tenant(binding, normalized)
        except (json.JSONDecodeError, ValueError, TypeError, KeyError):
            return self._reply(start_response, "400 Bad Request", b'{"error":"invalid_payload"}')
        except Exception:
            return self._reply(start_response, "503 Service Unavailable", b'{"error":"persistence_failed"}')
        return self._reply(start_response, "200 OK", b'{"status":"persisted"}')
