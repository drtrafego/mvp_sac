-- =====================================================================
-- Endurecimento do control plane do SAC v2 num projeto SUPABASE.
--
-- NAO e aplicado por scripts/preparar-banco-sac.py, de proposito. So faz
-- sentido se o destino escolhido for Supabase; no Neon nao existe PostgREST
-- nem as roles anon/authenticated, e este arquivo vira no-op.
--
-- POR QUE ISTO EXISTE
-- -------------------
-- 002_sac_multiagent_v2.sql termina com REVOKE ... FROM PUBLIC. Isso resolve o
-- PostgreSQL padrao, mas NAO resolve o Supabase: o projeto ja vem com
--
--   ALTER DEFAULT PRIVILEGES IN SCHEMA public
--     GRANT ALL ON TABLES/FUNCTIONS/SEQUENCES TO anon, authenticated, service_role;
--
-- Essas concessoes sao EXPLICITAS para as roles nomeadas, e um REVOKE dirigido
-- a PUBLIC nao as remove. Como o schema `public` e exposto pela Data API por
-- padrao, sem este arquivo a chave `anon` (que e publica, vai no navegador)
-- conseguiria:
--   * SELECT em public.sac_agents -> le schema_name, runtime_config e as
--     colunas *_secret_ref de todos os clientes, ou seja, o mapa do banco;
--   * SELECT em public.sac_channel_accounts -> le public_endpoint_id, que e a
--     capacidade opaca de webhook de cada cliente;
--   * EXECUTE em public.sac_provision_agent / sac_install_agent_schema ->
--     ambas sao SECURITY DEFINER e criam schema, tabelas e GRANTs. Isso e
--     execucao de DDL arbitrario a partir de uma chave publica.
-- Qualquer um dos tres ja viola a invariante do SAC.
--
-- ONDE APLICAR
-- ------------
-- Somente no banco NOVO de integracoes (o segundo projeto Supabase, dedicado
-- ao SAC v2).
--
-- O QUE QUEBRA SE APLICAR NO LUGAR ERRADO
-- ---------------------------------------
-- Se rodar isto no projeto `mvp_agente_ia` (o dos agentes, em producao):
--   * as secoes 1 a 3 sao inofensivas la, porque nenhuma tabela sac_* existe
--     naquele banco e todo comando esta protegido por checagem de existencia;
--   * a SECAO 4 (REVOKE USAGE ON SCHEMA public) derruba a Data API inteira
--     daquele projeto: todo cliente que fala com o Supabase por chave anon ou
--     por usuario autenticado passa a receber "permission denied for schema
--     public". Nao rode a secao 4 fora do banco novo.
--   * a SECAO 5 (service_role) derruba Edge Functions e integracoes de servidor
--     que usam a service key.
-- As secoes 4 e 5 vem comentadas por isso. Descomente com intencao.
--
-- COMO APLICAR
-- ------------
--   psql -v ON_ERROR_STOP=1 "$SAC_DATABASE_URL" -f scripts/supabase-endurecer.sql
-- ou cole no SQL Editor do projeto novo. Rodar duas vezes e seguro.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- SECAO 1 - tirar as tabelas de controle do alcance das roles expostas.
-- Protege: leitura do mapa de agentes, dos schema_name, dos *_secret_ref e
-- dos public_endpoint_id por quem so tem a chave anon.
-- Nao afeta sac_app / sac_worker / sac_owner: elas recebem privilegio pela
-- propria migration e por GRANT nominal, nao por estas roles.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_role text;
  v_tabela text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    -- Guarda: no Neon (ou num Postgres puro) estas roles nao existem.
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role);
    FOREACH v_tabela IN ARRAY ARRAY[
      'sac_tenants', 'sac_agents', 'sac_channel_accounts', 'sac_schema_migrations'
    ] LOOP
      CONTINUE WHEN pg_catalog.to_regclass('public.' || v_tabela) IS NULL;
      EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM %I', v_tabela, v_role);
    END LOOP;
  END LOOP;
END;
$$;

-- Reforco: PUBLIC de novo, para o caso de alguem ter concedido depois da
-- migration. Repetir REVOKE e barato e idempotente.
DO $$
DECLARE v_tabela text;
BEGIN
  FOREACH v_tabela IN ARRAY ARRAY[
    'sac_tenants', 'sac_agents', 'sac_channel_accounts', 'sac_schema_migrations'
  ] LOOP
    CONTINUE WHEN pg_catalog.to_regclass('public.' || v_tabela) IS NULL;
    EXECUTE pg_catalog.format('REVOKE ALL ON TABLE public.%I FROM PUBLIC', v_tabela);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- SECAO 2 - tirar as funcoes do alcance das roles expostas.
-- Protege: sac_provision_agent e sac_install_agent_schema sao SECURITY
-- DEFINER e executam DDL; sac_activate_agent liga um agente no scheduler;
-- sac_apply_analytics_indexes tambem e SECURITY DEFINER e executa DDL (CREATE
-- INDEX) no schema de um agente; sac_analytics_index_ddl devolve o texto dessa
-- DDL. sac_secret_ref_valid e sac_json_contains_secret_key nao sao perigosas
-- em si, mas nao ha motivo para estarem publicadas numa API HTTP.
-- Nao afeta o deployer: 002_sac_roles.psql concede EXECUTE nominalmente e
-- este arquivo nao mexe nessa role.
-- ---------------------------------------------------------------------
DO $$
DECLARE
  v_role text;
  v_func record;
BEGIN
  FOR v_func IN
    SELECT p.oid::pg_catalog.regprocedure AS assinatura
      FROM pg_catalog.pg_proc p
      JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('sac_provision_agent', 'sac_install_agent_schema',
                         'sac_activate_agent', 'sac_secret_ref_valid',
                         'sac_json_contains_secret_key',
                         'sac_apply_analytics_indexes', 'sac_analytics_index_ddl')
  LOOP
    EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM PUBLIC', v_func.assinatura);
    FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
      CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role);
      EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %s FROM %I',
                                v_func.assinatura, v_role);
    END LOOP;
  END LOOP;
END;
$$;

-- Impede que o proximo objeto criado em public nasca ja concedido a anon.
-- Vale so para objetos futuros criados PELA role indicada em FOR ROLE; por
-- isso os REVOKE acima continuam necessarios para o que ja existe.
DO $$
DECLARE v_role text;
BEGIN
  FOREACH v_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    CONTINUE WHEN NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = v_role);
    EXECUTE pg_catalog.format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      'REVOKE ALL ON TABLES FROM %I', current_user, v_role);
    EXECUTE pg_catalog.format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      'REVOKE ALL ON FUNCTIONS FROM %I', current_user, v_role);
    EXECUTE pg_catalog.format(
      'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public '
      'REVOKE ALL ON SEQUENCES FROM %I', current_user, v_role);
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- SECAO 3 - RLS de negacao total nas tabelas de controle.
-- Protege: e a segunda tranca. Se um GRANT reaparecer por engano (restore,
-- script de terceiro, "GRANT ALL ON ALL TABLES IN SCHEMA public"), o RLS sem
-- policy continua devolvendo zero linha para anon e authenticated.
--
-- ENABLE, e NAO force. A diferenca importa:
--   * ENABLE aplica RLS a todo mundo MENOS o dono da tabela e quem tem
--     BYPASSRLS. anon e authenticated nao sao nenhum dos dois: ficam barrados.
--   * FORCE aplicaria tambem ao dono. O control plane e escrito por
--     public.sac_provision_agent, que e SECURITY DEFINER e roda como o dono
--     dos objetos. Com FORCE e zero policy, o proprio provisionamento passaria
--     a falhar por "new row violates row-level security policy" no primeiro
--     INSERT em sac_tenants. Por isso FORCE fica comentado ali embaixo.
-- Limite honesto: RLS nao alcanca quem tem BYPASSRLS. No Supabase, `postgres`
-- e `service_role` tem. Logo esta secao COMPLEMENTA a secao 1; nao substitui.
-- ---------------------------------------------------------------------
DO $$
DECLARE v_tabela text;
BEGIN
  FOREACH v_tabela IN ARRAY ARRAY[
    'sac_tenants', 'sac_agents', 'sac_channel_accounts', 'sac_schema_migrations'
  ] LOOP
    CONTINUE WHEN pg_catalog.to_regclass('public.' || v_tabela) IS NULL;
    EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_tabela);
    -- NAO habilite FORCE sem antes criar uma policy para o dono:
    -- EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_tabela);
  END LOOP;
END;
$$;
-- Nenhuma POLICY e criada de proposito: sem policy, RLS nega tudo para quem
-- nao e dono. Criar uma policy permissiva aqui reabriria o que a secao 1
-- fechou.

COMMIT;

-- =====================================================================
-- SECAO 4 - OPCIONAL E AGRESSIVA: tirar o schema public das roles expostas.
--
-- Protege: fecha a categoria inteira, nao so as tabelas sac_*. Depois disto,
-- nenhum objeto novo em public fica alcancavel por chave anon, mesmo que
-- alguem esqueca um GRANT.
--
-- O QUE QUEBRA: toda a Data API deste projeto para chave anon e usuario
-- autenticado. Se este banco for exclusivo do SAC v2 (que fala PostgreSQL
-- direto, com roles proprias), nada quebra. Se houver QUALQUER front-end ou
-- Edge Function usando supabase-js contra este projeto, ele para na hora.
-- NAO rode no projeto mvp_agente_ia.
--
-- Descomente com intencao:
-- REVOKE USAGE ON SCHEMA public FROM anon, authenticated;
-- REVOKE CREATE ON SCHEMA public FROM anon, authenticated;
-- =====================================================================

-- =====================================================================
-- SECAO 5 - OPCIONAL: tirar tambem a service_role.
--
-- Protege: a service key ignora RLS (BYPASSRLS) e, por padrao, tem privilegio
-- sobre tudo em public. Se ela vazar de um servidor, o control plane inteiro
-- vai junto. O SAC nao usa service_role para nada: ele conecta com sac_app e
-- sac_worker.
--
-- O QUE QUEBRA: qualquer Edge Function, cron do Supabase ou integracao de
-- servidor deste projeto que use a service key sobre as tabelas sac_*.
--
-- Descomente com intencao:
-- REVOKE ALL ON public.sac_tenants, public.sac_agents,
--   public.sac_channel_accounts, public.sac_schema_migrations FROM service_role;
-- =====================================================================

-- =====================================================================
-- SECAO 6 - O QUE NAO DA PARA FAZER POR SQL (obrigatorio, no painel)
--
-- Nenhum comando SQL tira `public` da lista de schemas expostos: isso e
-- configuracao do PostgREST guardada pelo control plane do Supabase, fora do
-- banco. Enquanto `public` estiver exposto, a Data API continua tentando
-- publicar tudo que estiver la, e voce depende apenas dos GRANTs acima.
--
-- No painel do projeto NOVO:
--   1. Settings > API (ou Project Settings > Data API) > "Exposed schemas";
--   2. remova `public` da lista;
--   3. deixe apenas o que voce realmente quer publicar (idealmente nada, se o
--      SAC for o unico usuario deste banco);
--   4. salve e aguarde o reload do PostgREST.
--
-- Depois disso, recarregue o cache de schema do PostgREST:
--   NOTIFY pgrst, 'reload schema';
--
-- CONFERENCIA (deve devolver ZERO linha):
--   SELECT g.grantee, g.table_name, g.privilege_type
--     FROM information_schema.role_table_grants g
--    WHERE g.table_schema = 'public'
--      AND g.table_name LIKE 'sac\_%'
--      AND g.grantee IN ('PUBLIC', 'anon', 'authenticated');
--
-- A mesma conferencia e feita automaticamente por
--   python3 scripts/preparar-banco-sac.py --destino supabase
-- na secao "grants expostos" do relatorio.
-- =====================================================================
