-- Carrinho abandonado fica no CRM como contato/estado, sem abordagem.
-- Esta migração cancela somente jobs de envio ainda pendentes; não apaga
-- recovery_leads, pedidos, tags, mensagens ou qualquer histórico.
UPDATE message_jobs AS jobs
SET
  status = 'cancelled',
  error = COALESCE(jobs.error, 'Carrinho abandonado não cria mensagens'),
  processing_started_at = NULL
FROM recovery_leads AS leads
WHERE jobs.lead_id = leads.id
  AND leads.event_type = 'carrinho_abandonado'
  AND jobs.status IN ('pending', 'processing');
