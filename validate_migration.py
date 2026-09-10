#!/usr/bin/env python3
"""Validação estática: não conecta nem executa SQL."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
up = (ROOT / "migration_multicanal.sql").read_text()
down = (ROOT / "001_multicanal_down.sql").read_text()

assert "<schema>" in up and "<schema>" in down
assert re.search(r"(?im)^BEGIN;", up) and re.search(r"(?im)^COMMIT;", up)
assert re.search(r"(?im)^BEGIN;", down) and re.search(r"(?im)^COMMIT;", down)
assert not re.search(r"(?im)^\s*(TRUNCATE|DELETE\s+FROM|DROP\s+COLUMN|DROP\s+TABLE)", up)
assert up.count("UPDATE OR DELETE") == 3 and up.count("append_only") >= 3
assert "target.position > current.position" in up
assert "ON CONFLICT (organization_id, idempotency_key)" in up

tables = set(re.findall(r"CREATE TABLE <schema>\.(\w+)", up))
dropped = set(re.findall(r"DROP TABLE IF EXISTS <schema>\.(\w+)", down))
assert tables == dropped, ("rollback incompleto", tables - dropped, dropped - tables)

required = {
    "contact_identities", "conversation_threads", "conversation_messages",
    "contact_origins", "multichannel_events", "pipeline_automation_rules",
    "contact_points", "contact_profile_fields", "contact_tags",
    "contact_tag_assignments", "contact_merges",
}
assert required <= tables

# Toda tabela tenant-aware deve carregar organization_id e as relações usam chave composta.
for name in required:
    block = re.search(rf"CREATE TABLE <schema>\.{name} \((.*?)\n\);", up, re.S)
    assert block and "organization_id" in block.group(1), name
assert up.count("FOREIGN KEY (organization_id,") >= 8

# Paridade mínima com o CRM avançado da homologação SQLite.
for token in (
    "merged_into_lead_id", "normalized_value", "confidence BETWEEN 0 AND 1",
    "contact_points_identity_uq", "contact_tags_name_uq", "contact_merges_source_once_uq",
    "source_lead_id <> target_lead_id", "contact_merges_append_only",
):
    assert token in up, token
assert "DROP COLUMN IF EXISTS merged_into_lead_id" in down
assert down.index("DROP TABLE IF EXISTS <schema>.contact_merges") < down.index("DROP COLUMN IF EXISTS merged_into_lead_id")

print(f"OK: {len(tables)} tabelas; UP aditivo; DOWN completo; sem conexão com banco")
