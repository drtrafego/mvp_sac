-- Aplicar no banco de homologação via migração revisada, nunca diretamente em produção.
CREATE TABLE IF NOT EXISTS inbound_event_dedupe (
    tenant_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    channel TEXT NOT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    processed_at TIMESTAMPTZ,
    PRIMARY KEY (tenant_id, dedupe_key)
);

CREATE INDEX IF NOT EXISTS inbound_event_dedupe_received_at_idx
    ON inbound_event_dedupe (received_at);

