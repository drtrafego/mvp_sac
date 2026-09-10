"""Clientes de saída com transporte injetável e dry-run seguro por padrão."""

from __future__ import annotations

import json
import smtplib
from dataclasses import dataclass
from email.message import EmailMessage
from hashlib import sha256
from typing import Any, Callable, Mapping, Optional, Protocol
from urllib.request import Request, urlopen


@dataclass(frozen=True)
class HttpResponse:
    status: int
    body: bytes = b""


class Transport(Protocol):
    def __call__(self, method: str, url: str, headers: Mapping[str, str], body: bytes) -> HttpResponse: ...


def _http(method: str, url: str, headers: Mapping[str, str], body: bytes) -> HttpResponse:
    request = Request(url, data=body, headers=dict(headers), method=method)
    with urlopen(request, timeout=15) as response:  # pragma: no cover - integração explícita
        return HttpResponse(response.status, response.read())


def _json(response: HttpResponse) -> Mapping[str, Any]:
    if response.status < 200 or response.status >= 300:
        raise RuntimeError(f"provedor respondeu HTTP {response.status}")
    if not response.body:
        return {}
    value = json.loads(response.body)
    return value if isinstance(value, Mapping) else {}


@dataclass(frozen=True)
class SendResult:
    provider_id: str
    dry_run: bool = False


class HermesClient:
    """Chama o Hermes mantendo uma sessão determinística por conversa."""

    def __init__(self, base_url: str, api_key: Optional[str], *, model: str = "Hermes", dry_run: bool = False,
                 transport: Transport = _http) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.model = model
        self.dry_run = dry_run or not bool(api_key)
        self.transport = transport

    @staticmethod
    def session_id(tenant_id: str, channel: str, conversation_id: str) -> str:
        basis = "session-id\x1f" + "\x1f".join((tenant_id, channel, conversation_id))
        return sha256(basis.encode()).hexdigest()

    @staticmethod
    def session_key(tenant_id: str, channel: str, conversation_id: str) -> str:
        basis = "session-key\x1f" + "\x1f".join((tenant_id, channel, conversation_id))
        return sha256(basis.encode()).hexdigest()

    def reply(self, *, tenant_id: str, channel: str, conversation_id: str,
              text: str, context: Optional[Mapping[str, Any]] = None) -> Mapping[str, Any]:
        session = self.session_id(tenant_id, channel, conversation_id)
        session_key = self.session_key(tenant_id, channel, conversation_id)
        if self.dry_run:
            return {"text": text, "tags": [], "data": {}, "pipeline_stage": None,
                    "session_id": session, "session_key": session_key, "dry_run": True}
        instruction = (
            "Você é o Hermes, agente central de atendimento e CRM. Responda SOMENTE com JSON válido "
            "no formato {text:string,tags:string[],data:object,pipeline_stage:string|null,subject:string|null}. "
            "Use somente fatos explícitos; não invente dados. pipeline_stage pode ser novo_contato, "
            "em_atendimento, qualificado, agendado, fechado ou null."
        )
        user_payload = {"incoming_message": text, "crm_context": dict(context or {})}
        body = json.dumps({"model": self.model, "messages": [
            {"role": "system", "content": instruction},
            {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
        ], "response_format": {"type": "json_object"}}, ensure_ascii=False).encode()
        response = self.transport("POST", f"{self.base_url}/v1/chat/completions", {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
            "X-Hermes-Session-Id": session,
            "X-Hermes-Session-Key": session_key,
        }, body)
        result = _json(response)
        choices = result.get("choices") or []
        answer = ((choices[0].get("message") or {}).get("content")
                  if choices and isinstance(choices[0], Mapping) else None)
        if not isinstance(answer, str):
            raise RuntimeError("Hermes retornou resposta vazia")
        try:
            decision = json.loads(answer)
        except json.JSONDecodeError as exc:
            raise RuntimeError("Hermes retornou JSON invalido") from exc
        if not isinstance(decision, dict) or not isinstance(decision.get("text", ""), str):
            raise RuntimeError("Hermes retornou decisao invalida")
        if not isinstance(decision.get("tags", []), list) or not isinstance(decision.get("data", {}), dict):
            raise RuntimeError("Hermes retornou acoes CRM invalidas")
        decision.update({"session_id": session, "session_key": session_key, "raw": result})
        return decision


class MetaConnector:
    def __init__(self, access_token: Optional[str], *, graph_url: str = "https://graph.facebook.com/v23.0",
                 dry_run: bool = False, transport: Transport = _http) -> None:
        self.access_token = access_token
        self.graph_url = graph_url.rstrip("/")
        self.dry_run = dry_run or not bool(access_token)
        self.transport = transport

    def send(self, *, channel: str, account_id: str, recipient_id: str, text: str) -> SendResult:
        if channel not in {"whatsapp", "instagram"}:
            raise ValueError("canal Meta inválido")
        if self.dry_run:
            return SendResult(f"dry-run:{channel}", True)
        if channel == "whatsapp":
            payload = {"messaging_product": "whatsapp", "to": recipient_id,
                       "type": "text", "text": {"body": text}}
        else:
            payload = {"recipient": {"id": recipient_id}, "message": {"text": text}}
        response = self.transport("POST", f"{self.graph_url}/{account_id}/messages", {
            "Authorization": f"Bearer {self.access_token}", "Content-Type": "application/json",
        }, json.dumps(payload, ensure_ascii=False).encode())
        result = _json(response)
        ids = result.get("messages") or []
        provider_id = (ids[0].get("id") if ids and isinstance(ids[0], Mapping) else None) or result.get("message_id") or result.get("id")
        return SendResult(str(provider_id or "accepted"))

    def instagram_profile(self, scoped_user_id: str) -> Mapping[str, Any]:
        """Campos públicos permitidos para a pessoa que iniciou a conversa.

        O caller deve aplicar a janela/permissões da Meta; e-mail e telefone não
        fazem parte deste contrato e jamais são inferidos.
        """
        if not scoped_user_id.strip():
            raise ValueError("Instagram-scoped user id obrigatorio")
        if self.dry_run:
            return {"id": scoped_user_id, "dry_run": True}
        response = self.transport(
            "GET",
            f"{self.graph_url}/{scoped_user_id}?fields=id,name,username,profile_pic",
            {"Authorization": f"Bearer {self.access_token}"}, b"",
        )
        result = dict(_json(response))
        allowed = {key: result[key] for key in ("id", "name", "username", "profile_pic") if key in result}
        if str(allowed.get("id", scoped_user_id)) != scoped_user_id:
            raise RuntimeError("perfil Instagram divergente")
        return allowed


class BrevoConnector:
    def __init__(self, api_key: Optional[str], sender_email: Optional[str], *, sender_name: str = "Hermes",
                 api_url: str = "https://api.brevo.com/v3", dry_run: bool = False,
                 transport: Transport = _http) -> None:
        self.api_key, self.sender_email, self.sender_name = api_key, sender_email, sender_name
        self.api_url = api_url.rstrip("/")
        self.dry_run = dry_run or not bool(api_key and sender_email)
        self.transport = transport

    def send(self, *, recipient_id: str, text: str, subject: str = "Mensagem") -> SendResult:
        if self.dry_run:
            return SendResult("dry-run:email", True)
        payload = {"sender": {"email": self.sender_email, "name": self.sender_name},
                   "to": [{"email": recipient_id}], "subject": subject, "textContent": text}
        response = self.transport("POST", f"{self.api_url}/smtp/email", {
            "api-key": str(self.api_key), "Content-Type": "application/json",
        }, json.dumps(payload, ensure_ascii=False).encode())
        result = _json(response)
        return SendResult(str(result.get("messageId") or "accepted"))


class SMTPConnector:
    """Saída de e-mail provider-neutral via SMTP autenticado."""

    def __init__(self, host: Optional[str], port: int, username: Optional[str], password: Optional[str],
                 sender_email: Optional[str], *, sender_name: str = "Hermes", starttls: bool = True,
                 use_ssl: bool = False, dry_run: bool = False,
                 smtp_factory: Callable[..., Any] | None = None) -> None:
        self.host, self.port, self.username, self.password = host, port, username, password
        if starttls and use_ssl:
            raise ValueError("SMTP SSL e STARTTLS não podem estar ativos juntos")
        self.sender_email, self.sender_name, self.starttls, self.use_ssl = sender_email, sender_name, starttls, use_ssl
        self.dry_run = dry_run or not bool(host and sender_email)
        self.smtp_factory = smtp_factory or (smtplib.SMTP_SSL if use_ssl else smtplib.SMTP)

    def send(self, *, recipient_id: str, text: str, subject: str = "Mensagem") -> SendResult:
        if self.dry_run:
            return SendResult("dry-run:email", True)
        message = EmailMessage()
        message["From"] = f"{self.sender_name} <{self.sender_email}>"
        message["To"] = recipient_id
        message["Subject"] = subject
        message.set_content(text)
        with self.smtp_factory(self.host, self.port, timeout=15) as smtp:
            if self.starttls:
                smtp.starttls()
            if self.username:
                smtp.login(self.username, self.password or "")
            refused = smtp.send_message(message)
        if refused:
            raise RuntimeError("SMTP recusou um ou mais destinatarios")
        return SendResult(str(message["Message-ID"] or "accepted"))
