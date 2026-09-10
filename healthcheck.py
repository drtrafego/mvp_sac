#!/usr/bin/env python3
"""Validação offline de configuração. Nunca imprime valores de ambiente."""
from __future__ import annotations

import argparse
import json
import os
import re
import sys

REQUIRED = {
    "common": ["PUBLIC_WEBHOOK_BASE_URL", "TENANT_ID", "DEDUPE_TTL_DAYS"],
    "hermes": ["HERMES_BASE_URL", "HERMES_API_KEY", "HERMES_MODEL"],
    "meta": ["META_APP_ID", "META_APP_SECRET", "META_VERIFY_TOKEN", "META_GRAPH_API_VERSION"],
    "whatsapp": ["WHATSAPP_ACCESS_TOKEN", "WHATSAPP_PHONE_NUMBER_ID", "WHATSAPP_BUSINESS_ACCOUNT_ID"],
    "instagram": ["INSTAGRAM_ACCESS_TOKEN", "INSTAGRAM_ACCOUNT_ID", "INSTAGRAM_PAGE_ID"],
}

EMAIL_COMMON = ["EMAIL_PROVIDER", "EMAIL_ACCOUNT_ID", "EMAIL_WEBHOOK_SECRET",
                "EMAIL_SIGNATURE_HEADER", "EMAIL_SENDER"]
EMAIL_PROVIDERS = {
    "brevo": ["BREVO_API_KEY"],
    "smtp": ["EMAIL_SMTP_HOST", "EMAIL_SMTP_PORT", "EMAIL_USERNAME", "EMAIL_PASSWORD"],
}


def status(name: str, value: str | None) -> str:
    if not value:
        return "ausente"
    if name == "PUBLIC_WEBHOOK_BASE_URL" and not re.fullmatch(r"https://[^\s/]+(?:/.*)?", value):
        return "inválido"
    if name == "EMAIL_SENDER" and not re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value):
        return "inválido"
    if name == "EMAIL_PROVIDER" and value.casefold() not in EMAIL_PROVIDERS:
        return "inválido"
    if name == "DEDUPE_TTL_DAYS" and (not value.isdigit() or int(value) < 30):
        return "inválido"
    if name.endswith(("SECRET", "TOKEN", "API_KEY")) and len(value) < 12:
        return "inválido"
    return "presente"


def inspect_env() -> dict[str, dict[str, str]]:
    result = {
        group: {name: status(name, os.getenv(name)) for name in names}
        for group, names in REQUIRED.items()
    }
    provider = (os.getenv("EMAIL_PROVIDER") or "").casefold()
    names = EMAIL_COMMON + EMAIL_PROVIDERS.get(provider, [])
    result["email"] = {name: status(name, os.getenv(name)) for name in names}
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()
    result = inspect_env()
    ready = all(v == "presente" for group in result.values() for v in group.values())
    document = {"ready": ready, "checks": result}
    if args.json:
        print(json.dumps(document, ensure_ascii=False, indent=2, sort_keys=True))
    else:
        print("pronto" if ready else "configuração incompleta")
        for group, checks in result.items():
            print(f"{group}: " + ", ".join(f"{key}={value}" for key, value in checks.items()))
    return 0 if ready else 1


if __name__ == "__main__":
    sys.exit(main())
