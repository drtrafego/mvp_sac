#!/usr/bin/env python3
"""Valida invariantes da migration SAC v2 sem abrir conexao com banco."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parent
SQL_PATH = ROOT / "002_sac_multiagent_v2.sql"
ROLES_PATH = ROOT / "002_sac_roles.psql"
sql = SQL_PATH.read_text(encoding="utf-8")
roles = ROLES_PATH.read_text(encoding="utf-8")

assert re.search(r"(?m)^BEGIN;$", sql)
assert re.search(r"(?m)^COMMIT;$", sql)
assert "crm_leads" not in sql.lower()
assert not re.search(r"(?i)references\s+[^;]*(?<!sac_)leads\b", sql)

control = {"sac_tenants", "sac_agents", "sac_channel_accounts", "sac_schema_migrations"}
created_control = set(re.findall(r"CREATE TABLE IF NOT EXISTS public\.(sac_\w+)", sql))
assert created_control == control, (created_control, control)
for token in (
    "public_endpoint_id text UNIQUE", "signature_secret_ref text",
    "verify_secret_ref text", "signature_header text", "external_account_id text NOT NULL",
    "runtime_config jsonb NOT NULL", "hermes_api_key_secret_ref text",
    "access_token_secret_ref text", "api_key_secret_ref text",
    "smtp_username_secret_ref text", "smtp_password_secret_ref text",
    "imap_username_secret_ref text", "imap_password_secret_ref text",
    "sac_json_contains_secret_key", "sac_secret_ref_valid",
):
    assert token in sql, token

required_plane = {
    "sac_contacts", "sac_identities", "sac_threads", "sac_messages",
    "sac_inbound_events", "sac_domain_events", "sac_outbox",
    "sac_dead_letters", "sac_pipeline_history", "sac_tags",
    "sac_contact_tags", "sac_audit_log",
    "sac_origins", "sac_contact_points", "sac_profile_fields", "sac_contact_merges",
    "sac_crm_actions",
}
created_plane = set(re.findall(r"CREATE TABLE %1\$I\.(sac_\w+)", sql))
assert created_plane == required_plane, (created_plane, required_plane)

for table in required_plane:
    match = re.search(rf"CREATE TABLE %1\$I\.{table} \((.*?)(?=\n    \);)", sql, re.S)
    assert match, table
    block = match.group(1)
    assert "tenant_id text NOT NULL DEFAULT %2$L" in block, table
    assert "agent_id text NOT NULL DEFAULT %3$L" in block, table
    assert "CHECK (tenant_id = %2$L AND agent_id = %3$L)" in block, table

for table in ("sac_identities", "sac_threads", "sac_messages", "sac_dead_letters"):
    match = re.search(rf"CREATE TABLE %1\$I\.{table} \((.*?)(?=\n    \);)", sql, re.S)
    assert "FOREIGN KEY (tenant_id, agent_id," in match.group(1), table

for token in (
    "SECURITY DEFINER", "SET search_path = pg_catalog, public",
    "format('CREATE SCHEMA %I AUTHORIZATION %I'", "pg_advisory_xact_lock",
    "FOR UPDATE SKIP LOCKED", "lease_token", "leased_until", "max_attempts",
    "available_at", "sac_fail_outbox", "sac_dead_letters_append_only",
    "sac_audit_log_append_only", "REVOKE ALL", "FROM PUBLIC",
    "outbox.lease_exhausted", "WHERE topic = 'outbound.send'",
    "idempotency_key text NOT NULL",
    "ALTER TABLE %I.%I OWNER TO %I", "ALTER SEQUENCE %I.sac_audit_log_id_seq OWNER TO %I",
):
    assert token in sql, token

# Nenhum segredo, role concreta ou SQL destrutivo na migration UP.
assert not re.search(r"(?i)(password\s+['\"]|api[_-]?key\s*=|bearer\s+[a-z0-9])", sql)
assert not re.search(r"(?im)^\s*(DROP\s+(TABLE|SCHEMA)|TRUNCATE|DELETE\s+FROM)\b", sql)
assert "%I" in roles and ":'sac_deployer_role'" in roles
assert "GRANT EXECUTE" in roles and "CREATE ROLE" not in roles.upper()

print(
    f"OK: {len(control)} tabelas de controle; {len(required_plane)} tabelas por agente; "
    "tenant-bound, lease/retry/DLQ/auditoria e grants seguros; zero conexoes"
)
