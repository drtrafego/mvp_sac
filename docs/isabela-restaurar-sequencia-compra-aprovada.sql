-- Isabela (company 2, slug isabela-fanini): voltar a sequência da COMPRA APROVADA
-- para os templates nomeados aprovados na Meta. NÃO foi executado por quem escreveu.
-- Rodar só depois do deploy desta branch e com ok do Gastão; conferir os SELECTs antes do UPDATE/INSERT.
--
-- Estado achado na auditoria (12/11/2026): só `coringa_bela_contexto_atendimento_v2` estava ativa na
-- sequência, com variáveis {bloco_1..4} que o cron não interpola. O webhook então pulava a compra com
-- `sequencia_isabela_sem_template_aprovado_configurado`.
--
-- Templates conferidos na Meta (readback 12/11/2026, pt_BR, APPROVED, parâmetros NOMEADOS):
--   1. boas_vindas_despertar_pos_compra  MARKETING  {{customer_name}}  (delay 0)
--   2. formulario_desafio_d1             MARKETING  {{customer_name}}  (delay 1440 = D+1)
--   3. acompanhamento_desafio_d10        UTILITY    {{customer_name}}  (delay 14400 = D+10)
-- NÃO usar *_20261031 (isabela_formulario_d1_20261031_corrigida é POSITIONAL e traz "[nome ]" literal).

-- 1) Leitura: sequência e mensagens atuais
SELECT s.id AS sequence_id, s.event_type, s.is_active, m.id AS message_id, m."order", m.delay_minutes,
       m.template_name, m.template_variables_map, m.is_active AS msg_active
FROM recovery_sequences s
LEFT JOIN sequence_messages m ON m.sequence_id = s.id
WHERE s.company_id = 2 AND s.event_type = 'compra_aprovada'
ORDER BY m."order", m.id;

-- 2) Leitura: os três templates precisam existir sincronizados como APPROVED (senão: "Sincronizar templates" no SAC)
SELECT name, language, status, category FROM meta_message_templates
WHERE company_id = 2 AND name IN ('boas_vindas_despertar_pos_compra', 'formulario_desafio_d1', 'acompanhamento_desafio_d10');

-- 3) Escrita (uma transação): desativa as mensagens atuais e cria as três nomeadas
BEGIN;

UPDATE sequence_messages SET is_active = false
WHERE sequence_id = (SELECT id FROM recovery_sequences WHERE company_id = 2 AND event_type = 'compra_aprovada')
  AND is_active = true;

INSERT INTO sequence_messages (sequence_id, "order", delay_minutes, message_type, template_name, template_language, template_variables_map, is_active)
SELECT s.id, v."order", v.delay_minutes, 'template', v.template_name, 'pt_BR', '{"customer_name": "{nome}"}'::jsonb, true
FROM recovery_sequences s
CROSS JOIN (VALUES
  (1, 0,     'boas_vindas_despertar_pos_compra'),
  (2, 1440,  'formulario_desafio_d1'),
  (3, 14400, 'acompanhamento_desafio_d10')
) AS v("order", delay_minutes, template_name)
WHERE s.company_id = 2 AND s.event_type = 'compra_aprovada';

UPDATE recovery_sequences SET is_active = true, updated_at = now()
WHERE company_id = 2 AND event_type = 'compra_aprovada';

-- Conferir antes de confirmar: exatamente 3 linhas ativas, na ordem 1, 2, 3
SELECT m."order", m.delay_minutes, m.template_name, m.template_variables_map
FROM sequence_messages m JOIN recovery_sequences s ON s.id = m.sequence_id
WHERE s.company_id = 2 AND s.event_type = 'compra_aprovada' AND m.is_active = true
ORDER BY m."order";

COMMIT;  -- ou ROLLBACK; se a conferência acima não bater
