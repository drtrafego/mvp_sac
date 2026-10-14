CREATE INDEX IF NOT EXISTS agent_activity_logs_company_created_at_idx
ON agent_activity_logs (company_id, created_at);
