"""Configuracao de canais do painel: cadastro das contas e cofre de escrita.

Este modulo e a metade "sem HTTP e sem SQL" da tela de configuracao. Ele
concentra tres responsabilidades que nao podem morar na rota nem no store:

1. **Validacao do que o cliente manda.** ``public.sac_channel_accounts`` ja tem
   CHECK para tudo o que importa (chave com cara de segredo no ``config``,
   formato do ``public_endpoint_id``, par endpoint/assinatura, referencias
   obrigatorias por provedor). Aqui as mesmas regras sao aplicadas *antes* do
   INSERT para que erro de preenchimento vire 400 legivel em vez de 503 vindo
   de violacao de constraint. O banco continua sendo a autoridade: nada aqui
   afrouxa uma regra de la.

2. **O cofre e somente escrita.** ``SecretVault`` grava valor e responde
   ``presente | ausente | invalido``. Nao existe metodo que devolva o conteudo
   de um segredo: a leitura de valor pertence exclusivamente a
   ``DirectorySecretResolver``, usada pelo worker e pelo gateway. O estado e
   apurado so com ``lstat`` -- os bytes do arquivo nunca sao lidos aqui.

3. **A lista de pendencias.** ``account_checklist`` diz, por conta, o que ainda
   falta para o cliente poder ativar. Uma pendencia com ``blocks=True`` e
   exatamente uma condicao que faria ``status='active'`` ser recusado pelo
   banco ou faria a factory do worker falhar fechado.

Nenhuma funcao deste arquivo abre socket, chama provedor ou registra valor de
segredo em log, excecao ou auditoria.
"""
from __future__ import annotations

import errno
import os
import re
import secrets as _secrets
import stat
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

# ---------------------------------------------------------------- vocabulario

CHANNELS: tuple[str, ...] = ("whatsapp", "instagram", "email")
PROVIDERS: tuple[str, ...] = ("meta", "brevo", "smtp")
ACCOUNT_STATUS: tuple[str, ...] = ("active", "disabled")

# Combinacoes que a factory do worker sabe montar. Qualquer outra e recusada
# aqui para nao criar conta que nunca vai poder ser ativada.
PROVIDER_CHANNELS: Mapping[str, tuple[str, ...]] = {
    "meta": ("whatsapp", "instagram"),
    "brevo": ("email",),
    "smtp": ("email",),
}

# Espelha CONSTRAINT sac_channel_accounts_public_config_keys.
PROVIDER_CONFIG_KEYS: Mapping[str, tuple[str, ...]] = {
    "meta": ("graph_url",),
    "brevo": ("api_url", "sender_email", "sender_name"),
    "smtp": ("host", "port", "sender_email", "sender_name", "starttls", "ssl"),
}

# Nome exposto no JSON -> coluna do control plane. O cliente nunca fala em
# nome de coluna e nunca escolhe caminho de cofre.
SECRET_FIELDS: Mapping[str, str] = {
    "signature": "signature_secret_ref",
    "verify": "verify_secret_ref",
    "accessToken": "access_token_secret_ref",
    "apiKey": "api_key_secret_ref",
    "smtpUsername": "smtp_username_secret_ref",
    "smtpPassword": "smtp_password_secret_ref",
    "imapUsername": "imap_username_secret_ref",
    "imapPassword": "imap_password_secret_ref",
}

# Campos que fazem sentido por provedor/canal; o painel so mostra e so aceita
# gravacao nestes. Assinatura e verify existem sempre que houver webhook.
PROVIDER_SECRET_FIELDS: Mapping[str, tuple[str, ...]] = {
    "meta": ("signature", "verify", "accessToken"),
    "brevo": ("signature", "apiKey"),
    "smtp": ("signature", "smtpUsername", "smtpPassword",
             "imapUsername", "imapPassword"),
}

# Campos sem os quais o banco recusa status='active' ou a factory do worker
# falha fechada. Sao os unicos que geram pendencia com blocks=True.
BLOCKING_SECRET_FIELDS: Mapping[str, tuple[str, ...]] = {
    "meta": ("accessToken",),
    "brevo": ("apiKey",),
    "smtp": ("smtpPassword",),
}

# Campos que ``ProductionWorkerFactory.build`` resolve no cofre sempre que a
# coluna estiver preenchida, para toda conta com ``status='active'``. Se um
# deles apontar para arquivo que nao existe, o build levanta e o agente
# **inteiro** cai de ``/readyz`` -- nao so aquela conta. Por isso referencia
# preenchida sem arquivo bloqueia a ativacao tanto quanto referencia faltando.
# ``imapUsername``/``imapPassword`` ficam de fora: a factory nao os le.
WORKER_RESOLVED_SECRET_FIELDS: tuple[str, ...] = (
    "signature", "verify", "accessToken", "apiKey", "smtpUsername", "smtpPassword")

BLOCKING_CONFIG_KEYS: Mapping[str, tuple[str, ...]] = {
    "meta": (),
    "brevo": ("sender_email",),
    "smtp": ("host", "sender_email"),
}

WEBHOOK_PATH_PREFIX = "/webhooks/v2/"
DEFAULT_SIGNATURE_HEADER = "X-Webhook-Signature"

# Espelha public.sac_secret_ref_valid.
_SECRET_REF = re.compile(r"^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$")
_SIGNATURE_HEADER = re.compile(r"^[A-Za-z][A-Za-z0-9-]{0,99}$")
_ENDPOINT_ID = re.compile(r"^[A-Za-z0-9_-]{16,128}$")
_EXTERNAL_ID = re.compile(r"^[\x21-\x7e][\x20-\x7e]{0,190}$")
# Espelha public.sac_json_contains_secret_key.
_SECRET_KEY = re.compile(
    r"(secret|token|password|passphrase|credential|authorization|auth"
    r"|private[_-]?key|api[_-]?key)")

MAX_REF_CHARS = 512
MAX_SECRET_BYTES = 16_384
MIN_SECRET_BYTES = 4
MAX_DISPLAY_CHARS = 200


class ConfigError(ValueError):
    """Erro de preenchimento com codigo estavel para o frontend."""

    def __init__(self, code: str, *, field: str | None = None,
                 message: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.field = field
        self.message = message or code


class VaultUnavailable(Exception):
    """Cofre existe mas nao aceita escrita agora (read-only, permissao, espaco).

    Vira 409 na rota: e uma condicao de infraestrutura que o operador consegue
    entender e reportar, nao um 500 anonimo.
    """

    def __init__(self, code: str, *, message: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.message = message or code


# ------------------------------------------------------------- identificadores


def new_account_id() -> str:
    """Chave interna da conta. Opaca e gerada no servidor, como o endpoint."""
    return "ch_" + _secrets.token_hex(8)


def new_endpoint_id() -> str:
    """Capacidade publica opaca; 32 chars dentro de ``[A-Za-z0-9_-]{16,128}``.

    Confere o resultado contra o mesmo formato do CHECK do banco e do gateway:
    um id que nao case ali viraria conta com webhook irresolvivel.
    """
    endpoint = _secrets.token_urlsafe(24)
    if not _ENDPOINT_ID.fullmatch(endpoint):  # pragma: no cover - defesa extra
        raise ConfigError("endpoint_invalido",
                          message="identificador publico gerado fora do formato")
    return endpoint


def derive_secret_ref(tenant_id: str, agent_id: str, account_id: str, field: str) -> str:
    """Caminho do segredo no cofre, sempre derivado, nunca recebido do cliente.

    Deriva de valores que o servidor controla: tenant e agente vem do control
    plane e o id da conta e gerado aqui. Por isso o resultado ja nasce dentro
    do ``SECRET_DIR`` e no formato de ``sac_secret_ref_valid``; a validacao em
    ``SecretVault`` continua existindo para a referencia que veio do banco
    (uma conta pode ter sido provisionada por SQL, fora do painel).
    """
    column = SECRET_FIELDS.get(field)
    if column is None:
        raise ConfigError("campo_de_segredo_invalido", field=field,
                          message="campo de segredo desconhecido")
    ref = f"{tenant_id}/{agent_id}/{account_id}/{column[:-len('_secret_ref')]}"
    if not _SECRET_REF.fullmatch(ref) or any(
            part in ("", ".", "..") for part in ref.split("/")):
        raise ConfigError("secret_ref_invalido", field=field,
                          message="referencia derivada invalida")
    return ref


def webhook_location(base_url: str, endpoint_id: str | None) -> tuple[str | None, str | None]:
    """(url completa, caminho) para colar no provedor; sem base, so o caminho."""
    if not endpoint_id:
        return None, None
    path = WEBHOOK_PATH_PREFIX + endpoint_id
    base = str(base_url or "").strip().rstrip("/")
    return (f"{base}{path}" if base else None), path


def normalize_webhook_base(raw: str) -> str:
    """Base publica do webhook: HTTPS, salvo loopback explicito de homologacao."""
    base = str(raw or "").strip().rstrip("/")
    if not base:
        return ""
    lowered = base.lower()
    loopback = lowered.startswith(("http://127.0.0.1", "http://localhost"))
    if not lowered.startswith("https://") and not loopback:
        raise ValueError("base do webhook deve ser https")
    if any(char.isspace() for char in base):
        raise ValueError("base do webhook invalida")
    return base


# ------------------------------------------------------------------ validacao


def _text(value: Any, field: str, *, limit: int, required: bool) -> str | None:
    if value is None:
        if required:
            raise ConfigError("campo_obrigatorio", field=field,
                              message=f"{field} e obrigatorio")
        return None
    if not isinstance(value, str):
        raise ConfigError("campo_invalido", field=field,
                          message=f"{field} deve ser texto")
    clean = value.strip()
    if not clean:
        if required:
            raise ConfigError("campo_obrigatorio", field=field,
                              message=f"{field} e obrigatorio")
        return None
    if len(clean) > limit or "\x00" in clean:
        raise ConfigError("campo_invalido", field=field,
                          message=f"{field} fora do tamanho aceito")
    return clean


def contains_secret_key(value: Any) -> bool:
    """Mesma varredura recursiva de ``sac_json_contains_secret_key``."""
    if isinstance(value, Mapping):
        for key, child in value.items():
            if _SECRET_KEY.search(str(key).lower()) or contains_secret_key(child):
                return True
    elif isinstance(value, (list, tuple)):
        return any(contains_secret_key(child) for child in value)
    return False


def _https(value: Any, key: str) -> str:
    text = _text(value, key, limit=500, required=True) or ""
    if not text.lower().startswith("https://"):
        raise ConfigError("config_invalida", field=key,
                          message=f"{key} deve comecar com https://")
    return text


def _bool(value: Any, key: str) -> bool:
    if isinstance(value, bool):
        return value
    raise ConfigError("config_invalida", field=key,
                      message=f"{key} deve ser booleano")


def _port(value: Any, key: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ConfigError("config_invalida", field=key,
                          message=f"{key} deve ser inteiro")
    if not 1 <= value <= 65535:
        raise ConfigError("config_invalida", field=key,
                          message=f"{key} fora do intervalo de portas")
    return value


def _email(value: Any, key: str) -> str:
    text = _text(value, key, limit=320, required=True) or ""
    local, _, domain = text.partition("@")
    if not local or not domain or "." not in domain or any(c.isspace() for c in text):
        raise ConfigError("config_invalida", field=key,
                          message=f"{key} nao parece um e-mail")
    return text


def validate_config(provider: str, config: Any) -> dict[str, Any]:
    """Config publica: so as chaves do provedor, tipada, e sem cara de segredo."""
    if config is None:
        config = {}
    if not isinstance(config, Mapping):
        raise ConfigError("config_invalida", field="config",
                          message="config deve ser objeto")
    allowed = PROVIDER_CONFIG_KEYS.get(provider, ())
    unknown = sorted(set(map(str, config)) - set(allowed))
    if unknown:
        raise ConfigError("config_chave_desconhecida", field=unknown[0],
                          message=f"chave nao aceita para {provider}: {unknown[0]}")
    if contains_secret_key(config):
        # Cinto e suspensorio: o banco tambem recusa, mas aqui vira 400 claro.
        raise ConfigError("config_com_segredo", field="config",
                          message="config publica nao aceita chave de segredo")
    clean: dict[str, Any] = {}
    for key, value in config.items():
        key = str(key)
        if key in ("graph_url", "api_url"):
            clean[key] = _https(value, key)
        elif key == "sender_email":
            clean[key] = _email(value, key)
        elif key in ("sender_name", "host"):
            clean[key] = _text(value, key, limit=200, required=True)
        elif key == "port":
            clean[key] = _port(value, key)
        elif key in ("starttls", "ssl"):
            clean[key] = _bool(value, key)
        else:  # pragma: no cover - allowed ja filtrou
            raise ConfigError("config_chave_desconhecida", field=key)
    if provider == "smtp":
        starttls = bool(clean.get("starttls", True))
        use_ssl = bool(clean.get("ssl", False))
        if starttls == use_ssl:
            raise ConfigError("config_invalida", field="starttls",
                              message="SMTP usa exatamente um de STARTTLS ou SSL")
    return clean


def reject_server_owned(payload: Mapping[str, Any]) -> None:
    """Campos que so o servidor escreve. Recusa explicita, nunca silenciosa."""
    if "publicEndpointId" in payload or "public_endpoint_id" in payload:
        raise ConfigError("endpoint_nao_aceito", field="publicEndpointId",
                          message="public_endpoint_id e gerado pelo servidor")
    if "id" in payload or "accountId" in payload:
        raise ConfigError("id_nao_aceito", field="id",
                          message="o id da conta e gerado pelo servidor")
    for key in payload:
        lowered = str(key).lower()
        if lowered in ("tenantid", "agentid", "schemaname", "schema_name"):
            continue  # ignorados de proposito; o escopo vem da sessao
        if "secretref" in lowered.replace("_", "") or _SECRET_KEY.search(lowered):
            raise ConfigError("segredo_nao_aceito", field=str(key),
                              message="valor de segredo nao entra por esta rota")


@dataclass(frozen=True)
class AccountDraft:
    channel: str
    provider: str
    external_account_id: str
    display_name: str | None
    signature_header: str | None
    status: str
    config: dict[str, Any]


def validate_new_account(payload: Mapping[str, Any]) -> AccountDraft:
    """Conta nova: sempre nasce ``disabled``, sem endpoint e sem referencia."""
    reject_server_owned(payload)
    channel = _text(payload.get("channel"), "channel", limit=32, required=True)
    provider = _text(payload.get("provider"), "provider", limit=32, required=True)
    if channel not in CHANNELS:
        raise ConfigError("canal_invalido", field="channel",
                          message=f"canal deve ser um de {', '.join(CHANNELS)}")
    if provider not in PROVIDERS:
        raise ConfigError("provedor_invalido", field="provider",
                          message=f"provedor deve ser um de {', '.join(PROVIDERS)}")
    if channel not in PROVIDER_CHANNELS[provider]:
        raise ConfigError("provedor_incompativel", field="provider",
                          message=f"{provider} nao atende o canal {channel}")
    status = _text(payload.get("status"), "status", limit=16, required=False) or "disabled"
    if status not in ACCOUNT_STATUS:
        raise ConfigError("status_invalido", field="status",
                          message="status deve ser active ou disabled")
    if status == "active":
        # Conta nova nao tem referencia nenhuma: ativar aqui seria violar o
        # CHECK do banco. O caminho e criar, gravar segredo e so entao ativar.
        raise ConfigError("ativacao_com_pendencia", field="status",
                          message="conta nova nasce desativada; ative depois de "
                                  "gravar as referencias obrigatorias")
    external = _text(payload.get("externalAccountId"), "externalAccountId",
                     limit=190, required=True) or ""
    if not _EXTERNAL_ID.fullmatch(external):
        raise ConfigError("campo_invalido", field="externalAccountId",
                          message="externalAccountId tem caracteres nao aceitos")
    return AccountDraft(channel, provider, external,
                        _text(payload.get("displayName"), "displayName",
                              limit=MAX_DISPLAY_CHARS, required=False),
                        _signature_header(payload.get("signatureHeader")),
                        "disabled", validate_config(provider, payload.get("config")))


def _signature_header(value: Any) -> str | None:
    header = _text(value, "signatureHeader", limit=100, required=False)
    if header is not None and not _SIGNATURE_HEADER.fullmatch(header):
        raise ConfigError("campo_invalido", field="signatureHeader",
                          message="signatureHeader fora do formato aceito")
    return header


def validate_account_changes(account: Mapping[str, Any],
                             payload: Mapping[str, Any]) -> dict[str, Any]:
    """Edicao parcial. ``channel`` e ``provider`` sao imutaveis de proposito.

    Trocar o canal ou o provedor de uma conta ja usada mudaria o sentido de
    identidades, threads e referencias de cofre ja gravadas. Quem precisa
    trocar cria outra conta e desativa esta.
    """
    reject_server_owned(payload)
    for immutable in ("channel", "provider"):
        if immutable in payload and str(payload[immutable]) != str(account.get(immutable)):
            raise ConfigError("campo_imutavel", field=immutable,
                              message=f"{immutable} nao pode ser alterado; "
                                      "crie outra conta")
    provider = str(account.get("provider") or "")
    changes: dict[str, Any] = {}
    if "displayName" in payload:
        changes["display_name"] = _text(payload.get("displayName"), "displayName",
                                        limit=MAX_DISPLAY_CHARS, required=False)
    if "externalAccountId" in payload:
        external = _text(payload.get("externalAccountId"), "externalAccountId",
                         limit=190, required=True) or ""
        if not _EXTERNAL_ID.fullmatch(external):
            raise ConfigError("campo_invalido", field="externalAccountId",
                              message="externalAccountId tem caracteres nao aceitos")
        changes["external_account_id"] = external
    if "signatureHeader" in payload:
        changes["signature_header"] = _signature_header(payload.get("signatureHeader"))
    if "config" in payload:
        changes["config"] = validate_config(provider, payload.get("config"))
    if "status" in payload:
        status = _text(payload.get("status"), "status", limit=16, required=True)
        if status not in ACCOUNT_STATUS:
            raise ConfigError("status_invalido", field="status",
                              message="status deve ser active ou disabled")
        changes["status"] = status
    if not changes:
        raise ConfigError("nada_para_alterar", field=None,
                          message="nenhum campo alteravel foi enviado")
    return changes


def secret_fields_for(provider: str) -> tuple[str, ...]:
    return PROVIDER_SECRET_FIELDS.get(provider, ())


def validate_secret_field(provider: str, field: str) -> str:
    """Nome do campo -> coluna, restrito ao que o provedor usa."""
    column = SECRET_FIELDS.get(field)
    if column is None or field not in secret_fields_for(provider):
        raise ConfigError("campo_de_segredo_invalido", field=field,
                          message="campo de segredo nao existe para este provedor")
    return column


def validate_secret_value(value: Any) -> bytes:
    """Valida o valor sem nunca devolve-lo em mensagem de erro.

    Nem o valor nem o tamanho exato aparecem no texto do erro: o codigo diz
    apenas que o valor esta fora da faixa aceita.
    """
    if not isinstance(value, str):
        raise ConfigError("valor_invalido", field="value",
                          message="valor do segredo deve ser texto")
    clean = value.strip()
    if "\x00" in clean:
        raise ConfigError("valor_invalido", field="value",
                          message="valor do segredo tem byte nulo")
    raw = clean.encode("utf-8")
    if not MIN_SECRET_BYTES <= len(raw) <= MAX_SECRET_BYTES:
        raise ConfigError("valor_invalido", field="value",
                          message="valor do segredo fora do tamanho aceito")
    return raw


# --------------------------------------------------------------------- cofre


class SecretVault:
    """Escrita atomica e privada de segredos dentro do ``SECRET_DIR``.

    Nao existe metodo de leitura de valor. ``state`` responde so com o estado
    apurado por ``lstat``; os bytes do arquivo nunca sao abertos aqui.
    """

    def __init__(self, root: str | Path, *, max_bytes: int = MAX_SECRET_BYTES,
                 file_mode: int = 0o600, dir_mode: int = 0o700) -> None:
        self.root = Path(root).resolve(strict=True)
        if not self.root.is_dir():
            raise ValueError("diretorio de segredos invalido")
        self.max_bytes = int(max_bytes)
        self.file_mode = int(file_mode)
        self.dir_mode = int(dir_mode)

    # -- caminho

    def target(self, secret_ref: str) -> Path:
        """Valida a referencia e devolve o caminho absoluto dentro da raiz.

        Recusa: vazio, longo demais, fora do formato de ``sac_secret_ref_valid``,
        com ``..``/``.``/segmento vazio, caminho absoluto e symlink em qualquer
        componente do caminho.
        """
        ref = str(secret_ref or "")
        if not ref or len(ref) > MAX_REF_CHARS:
            raise ConfigError("secret_ref_invalido",
                              message="referencia de segredo vazia ou longa demais")
        if not _SECRET_REF.fullmatch(ref):
            # O formato ja recusa caminho absoluto, barra invertida e espaco.
            raise ConfigError("secret_ref_invalido",
                              message="referencia de segredo fora do formato aceito")
        parts = ref.split("/")
        if any(part in ("", ".", "..") for part in parts):
            raise ConfigError("secret_ref_invalido",
                              message="referencia de segredo com segmento relativo")
        current = self.root
        for part in parts:
            current = current / part
            try:
                info = current.lstat()
            except FileNotFoundError:
                break  # o resto do caminho ainda nao existe
            except OSError:
                raise ConfigError("secret_ref_invalido",
                                  message="referencia de segredo inacessivel")
            if stat.S_ISLNK(info.st_mode):
                raise ConfigError("secret_ref_symlink",
                                  message="symlink nao e aceito no caminho do segredo")
        target = self.root.joinpath(*parts)
        if not target.is_relative_to(self.root):  # pragma: no cover - defesa extra
            raise ConfigError("secret_ref_fora_do_cofre",
                              message="referencia aponta para fora do cofre")
        return target

    # -- estado

    def state(self, secret_ref: str | None) -> str:
        """``presente``, ``ausente`` ou ``invalido``; nunca abre o arquivo."""
        if not secret_ref:
            return "ausente"
        try:
            target = self.target(secret_ref)
        except ConfigError:
            return "invalido"
        try:
            info = target.lstat()
        except FileNotFoundError:
            return "ausente"
        except OSError:
            return "invalido"
        if stat.S_ISLNK(info.st_mode) or not stat.S_ISREG(info.st_mode):
            return "invalido"
        if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
            return "invalido"
        if not 1 <= info.st_size <= self.max_bytes:
            return "invalido"
        return "presente"

    # -- escrita

    def write(self, secret_ref: str, value: str) -> None:
        """Grava o valor com 0600, dono do processo e troca atomica.

        Sequencia: diretorios intermediarios com 0700 -> arquivo temporario no
        *mesmo* diretorio (mkstemp ja nasce 0600) -> fchmod explicito -> write
        -> fsync -> ``os.replace`` -> fsync do diretorio. Leitor concorrente ve
        o arquivo antigo ou o novo, nunca um truncado.
        """
        target = self.target(secret_ref)
        payload = validate_secret_value(value)
        parent = target.parent
        handle = -1
        temporary = ""
        try:
            self._ensure_directories(parent)
            handle, temporary = tempfile.mkstemp(prefix=".sac-secret-", dir=str(parent))
            os.fchmod(handle, self.file_mode)
            written = os.write(handle, payload)
            if written != len(payload):  # pragma: no cover - write curto e raro
                raise VaultUnavailable("cofre_escrita_incompleta",
                                       message="gravacao incompleta no cofre")
            os.fsync(handle)
            info = os.fstat(handle)
            if info.st_uid != os.geteuid():  # pragma: no cover - depende do FS
                raise VaultUnavailable("cofre_dono_incorreto",
                                       message="arquivo criado com dono inesperado")
            os.close(handle)
            handle = -1
            os.replace(temporary, target)
            temporary = ""
        except OSError as exc:
            raise self._unavailable(exc) from None
        finally:
            if handle >= 0:
                os.close(handle)
            if temporary:
                try:
                    os.unlink(temporary)
                except OSError:
                    pass
        self._fsync_directory(parent)

    def _ensure_directories(self, parent: Path) -> None:
        if parent == self.root:
            return
        parent.mkdir(mode=self.dir_mode, parents=True, exist_ok=True)
        current = self.root
        for part in parent.relative_to(self.root).parts:
            current = current / part
            info = current.lstat()
            if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
                raise ConfigError("secret_ref_symlink",
                                  message="caminho do segredo nao e diretorio proprio")
            if info.st_mode & (stat.S_IRWXG | stat.S_IRWXO):
                os.chmod(current, self.dir_mode)

    @staticmethod
    def _fsync_directory(parent: Path) -> None:
        try:
            descriptor = os.open(str(parent), os.O_RDONLY)
        except OSError:  # pragma: no cover - plataforma sem fsync de diretorio
            return
        try:
            os.fsync(descriptor)
        except OSError:  # pragma: no cover
            pass
        finally:
            os.close(descriptor)

    @staticmethod
    def _unavailable(exc: OSError) -> VaultUnavailable:
        """Traduz errno para codigo estavel; ``str(exc)`` nunca vai para a rota."""
        if exc.errno == errno.EROFS:
            return VaultUnavailable(
                "cofre_somente_leitura",
                message="SECRET_DIR esta montado somente leitura; "
                        "nenhum segredo foi gravado")
        if exc.errno in (errno.EACCES, errno.EPERM):
            return VaultUnavailable(
                "cofre_sem_permissao",
                message="o processo nao tem permissao de escrita no SECRET_DIR")
        if exc.errno in (errno.ENOSPC, errno.EDQUOT):
            return VaultUnavailable("cofre_sem_espaco",
                                    message="sem espaco disponivel no SECRET_DIR")
        return VaultUnavailable("cofre_indisponivel",
                                message="o cofre nao aceitou a gravacao")


class SecretWriteQuota:
    """Teto de tentativas de gravacao por sessao.

    Conta tentativa, nao sucesso: uma sessao roubada gasta o mesmo orcamento
    errando o caminho ou o valor. Vive so na memoria do processo, como a
    propria sessao.
    """

    def __init__(self, *, max_writes: int = 20, window_seconds: float = 3600.0,
                 clock: Callable[[], float] = time.monotonic) -> None:
        if max_writes < 1 or window_seconds <= 0:
            raise ValueError("limites de gravacao invalidos")
        self.max_writes = int(max_writes)
        self.window_seconds = float(window_seconds)
        self._clock = clock
        self._used: dict[str, tuple[int, float]] = {}

    def _current(self, key: str) -> tuple[int, float]:
        now = self._clock()
        count, until = self._used.get(key, (0, 0.0))
        if not until or until <= now:
            return 0, now + self.window_seconds
        return count, until

    def remaining(self, key: str) -> int:
        count, _ = self._current(key)
        return max(0, self.max_writes - count)

    def consume(self, key: str) -> bool:
        """Gasta uma tentativa; ``False`` quando o orcamento acabou."""
        count, until = self._current(key)
        if count >= self.max_writes:
            return False
        self._used[key] = (count + 1, until)
        return True


# ---------------------------------------------------------------- pendencias


_SECRET_LABEL: Mapping[str, str] = {
    "signature": "segredo de assinatura do webhook",
    "verify": "verify token do cadastro do webhook",
    "accessToken": "token de acesso da Meta",
    "apiKey": "chave de API da Brevo",
    "smtpUsername": "usuario SMTP",
    "smtpPassword": "senha SMTP",
    "imapUsername": "usuario IMAP",
    "imapPassword": "senha IMAP",
}


def _pendencia(code: str, message: str, *, field: str | None = None,
               secret_ref: str | None = None, blocks: bool = False) -> dict[str, Any]:
    return {"code": code, "field": field, "secretRef": secret_ref,
            "blocks": bool(blocks), "message": message}


def account_checklist(account: Mapping[str, Any],
                      state_of: Callable[[str | None], str]) -> dict[str, Any]:
    """O que falta nesta conta para o cliente poder ativar.

    ``blocks=True`` marca exatamente o que impede ``status='active'`` (CHECK do
    banco) ou faria a factory do worker recusar a conta. O resto e pendencia
    operacional: sem ela o canal ate ativa, mas nao recebe mensagem.
    """
    provider = str(account.get("provider") or "")
    channel = str(account.get("channel") or "")
    refs = dict(account.get("secretRefs") or {})
    config = dict(account.get("config") or {})
    pendencias: list[dict[str, Any]] = []

    if provider not in PROVIDERS or channel not in PROVIDER_CHANNELS.get(provider, ()):
        pendencias.append(_pendencia(
            "provedor_incompativel",
            f"o provedor {provider or '(vazio)'} nao atende o canal "
            f"{channel or '(vazio)'}; nenhum conector sabe entregar por ele",
            field="provider", blocks=True))
        return {"accountId": account.get("id"), "channel": channel, "provider": provider,
                "status": account.get("status"), "canActivate": False,
                "pendencias": pendencias}

    blocking = BLOCKING_SECRET_FIELDS.get(provider, ())
    for field in secret_fields_for(provider):
        ref = refs.get(field)
        state = state_of(ref)
        if state == "presente":
            continue
        required = field in blocking
        # Referencia ja preenchida e promessa: a factory vai resolve-la em toda
        # ativacao. Promessa quebrada derruba o agente inteiro, entao bloqueia.
        blocks = required or (bool(ref) and field in WORKER_RESOLVED_SECRET_FIELDS)
        if not ref and not required:
            if field in ("signature", "verify"):
                if not account.get("publicEndpointId"):
                    continue  # a pendencia de endpoint ja cobre este caso
            elif field in ("imapUsername", "imapPassword"):
                # So cobra IMAP se o par ja foi comecado; caixa de entrada por
                # IMAP e opcional quando a entrada vem por webhook.
                if not (refs.get("imapUsername") or refs.get("imapPassword")):
                    continue
            else:
                continue  # o conector aceita SMTP sem usuario, por exemplo
        label = _SECRET_LABEL.get(field, field)
        if state == "invalido":
            pendencias.append(_pendencia(
                "segredo_invalido",
                f"a referencia do {label} existe mas o arquivo no cofre esta "
                "inacessivel ou com permissao aberta",
                field=field, secret_ref=ref, blocks=blocks))
        else:
            pendencias.append(_pendencia(
                "segredo_ausente", f"falta gravar o {label}",
                field=field, secret_ref=ref, blocks=blocks))

    if not account.get("publicEndpointId"):
        inbound_blocks = provider == "meta"
        pendencias.append(_pendencia(
            "endpoint_nao_gerado",
            "gere o endpoint publico para obter a URL de webhook do provedor",
            field="publicEndpointId", blocks=inbound_blocks))

    for key in BLOCKING_CONFIG_KEYS.get(provider, ()):
        if not str(config.get(key) or "").strip():
            pendencias.append(_pendencia(
                "config_incompleta", f"preencha {key} na configuracao do canal",
                field=key, blocks=True))

    can_activate = not any(item["blocks"] for item in pendencias)
    return {"accountId": account.get("id"), "channel": channel, "provider": provider,
            "status": account.get("status"), "canActivate": can_activate,
            "pendencias": pendencias}


def agent_checklist(accounts: Iterable[Mapping[str, Any]],
                    state_of: Callable[[str | None], str]) -> dict[str, Any]:
    """Checklist do agente inteiro, mais os canais ainda sem nenhuma conta."""
    rows = [account_checklist(account, state_of) for account in accounts]
    configured = {str(row["channel"]) for row in rows}
    ready = any(row["canActivate"] for row in rows)
    return {"accounts": rows,
            "channelsWithoutAccount": [c for c in CHANNELS if c not in configured],
            "ready": ready}
