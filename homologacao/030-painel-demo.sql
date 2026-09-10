-- Dados de demonstracao do painel, SOMENTE para a composicao isolada
-- `compose.homologacao.yaml`. Idempotente: reexecutar nao duplica nada.
--
-- Deliberadamente NAO toca o agente AutonomIA: o piloto continua sendo lido
-- pela API somente leitura, a partir das replicas de producao. Aqui so entram
-- os agentes genericos, que sao o alvo desta frente.
--
-- As contas de canal ficam com status 'disabled': o painel exercita leitura,
-- pipeline, nota e atribuicao sem que exista qualquer caminho de envio.
DO $seed$
DECLARE
  v record;
  v_i int;
  v_contact text;
  v_identity text;
  v_thread text;
  v_message text;
  v_stages text[] := ARRAY['novo_contato','em_atendimento','qualificado','agendado'];
  v_names text[] := ARRAY['Ana Ribeiro','Bruno Correia','Carla Moretti','Diego Lisboa'];
  v_origins jsonb[] := ARRAY[
    '{"platform":"Kiwify","source":"carrinho abandonado","channel":"whatsapp","campaign":"black-friday"}'::jsonb,
    '{"platform":"Meta","source":"anuncio","channel":"instagram","campaign":"institucional"}'::jsonb,
    '{"source":"indicacao"}'::jsonb,
    NULL
  ];
BEGIN
  FOR v IN SELECT * FROM (VALUES
    ('dr-lucas','sac_dr_lucas','whatsapp','meta','whatsapp-homologacao','5511990001000'),
    ('casal-do-trafego','sac_casal_trafego','instagram','meta','instagram-homologacao','17841400000000001'),
    ('gramado-plazza','sac_gramado_plazza','whatsapp','meta','whatsapp-homologacao','5554990002000'),
    ('bella-franklin','sac_bella_franklin','instagram','meta','instagram-homologacao','17841400715053999')
  ) AS t(tenant, schema_name, channel, provider, account_id, external_account)
  LOOP
    INSERT INTO public.sac_channel_accounts
      (tenant_id, agent_id, id, channel, provider, external_account_id, display_name, status)
    VALUES (v.tenant, 'atendimento', v.account_id, v.channel, v.provider,
            v.external_account, 'Homologacao do painel (sem entrega externa)', 'disabled')
    ON CONFLICT DO NOTHING;

    FOR v_i IN 1..4 LOOP
      v_contact  := 'ct_demo_' || v_i;
      v_identity := 'id_demo_' || v_i;
      v_thread   := 'cv_demo_' || v_i;
      v_message  := 'msg_demo_' || v_i;

      EXECUTE format(
        'INSERT INTO %I.sac_contacts (tenant_id,agent_id,id,display_name,pipeline_stage) '
        'VALUES (%L,%L,%L,%L,%L) ON CONFLICT DO NOTHING',
        v.schema_name, v.tenant, 'atendimento', v_contact, v_names[v_i], v_stages[v_i]);

      EXECUTE format(
        'INSERT INTO %I.sac_identities '
        '(tenant_id,agent_id,id,contact_id,channel,account_id,external_user_id,display_name) '
        'VALUES (%L,%L,%L,%L,%L,%L,%L,%L) ON CONFLICT DO NOTHING',
        v.schema_name, v.tenant, 'atendimento', v_identity, v_contact, v.channel,
        v.account_id, 'externo-' || v_i, v_names[v_i]);

      EXECUTE format(
        'INSERT INTO %I.sac_threads '
        '(tenant_id,agent_id,id,identity_id,channel,account_id,external_thread_id,status,updated_at) '
        'VALUES (%L,%L,%L,%L,%L,%L,%L,%L,now() - (%L || '' hours'')::interval) ON CONFLICT DO NOTHING',
        v.schema_name, v.tenant, 'atendimento', v_thread, v_identity, v.channel,
        v.account_id, 'externo-' || v_i, 'open', v_i::text);

      EXECUTE format(
        'INSERT INTO %I.sac_messages '
        '(tenant_id,agent_id,id,thread_id,direction,provider_event_id,occurred_at,body,status) '
        'VALUES (%L,%L,%L,%L,%L,%L,now() - (%L || '' hours'')::interval,%L::jsonb,%L) '
        'ON CONFLICT DO NOTHING',
        v.schema_name, v.tenant, 'atendimento', v_message || '_in', v_thread, 'inbound',
        'demo-in-' || v_i, v_i::text,
        json_build_object('text', 'Mensagem de homologacao ' || v_i || ' de ' || v_names[v_i])::text,
        'received');

      EXECUTE format(
        'INSERT INTO %I.sac_messages '
        '(tenant_id,agent_id,id,thread_id,direction,provider_event_id,occurred_at,body,status) '
        'VALUES (%L,%L,%L,%L,%L,%L,now() - (%L || '' minutes'')::interval,%L::jsonb,%L) '
        'ON CONFLICT DO NOTHING',
        v.schema_name, v.tenant, 'atendimento', v_message || '_out', v_thread, 'outbound',
        'demo-out-' || v_i, (v_i * 30)::text,
        json_build_object('text', 'Resposta registrada em homologacao, sem entrega externa.')::text,
        'sent');

      IF v_origins[v_i] IS NOT NULL THEN
        EXECUTE format(
          'INSERT INTO %I.sac_origins (tenant_id,agent_id,id,contact_id,message_id,data) '
          'VALUES (%L,%L,%L,%L,%L,%L::jsonb) ON CONFLICT DO NOTHING',
          v.schema_name, v.tenant, 'atendimento', 'src_demo_' || v_i, v_contact,
          v_message || '_in', v_origins[v_i]::text);
      END IF;
    END LOOP;
  END LOOP;
END
$seed$;
