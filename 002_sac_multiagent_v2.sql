-- SAC multiagente v2 para PostgreSQL 15+.
-- Autocontida: nao depende de nenhuma tabela de CRM legada.
-- Aplicar primeiro em banco descartavel. Nao contem credenciais nem nomes de roles.
BEGIN;

CREATE OR REPLACE FUNCTION public.sac_secret_ref_valid(p_ref text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
RETURN p_ref IS NOT NULL
  AND p_ref ~ '^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*$'
  AND NOT ('..' = ANY (string_to_array(p_ref, '/')));

CREATE OR REPLACE FUNCTION public.sac_json_contains_secret_key(p_value jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog
AS $body$
DECLARE v_key text; v_child jsonb;
BEGIN
  IF p_value IS NULL THEN RETURN false; END IF;
  IF jsonb_typeof(p_value) = 'object' THEN
    FOR v_key, v_child IN SELECT key, value FROM jsonb_each(p_value)
    LOOP
      IF lower(v_key) ~ '(secret|token|password|passphrase|credential|authorization|auth|private[_-]?key|api[_-]?key)'
         OR public.sac_json_contains_secret_key(v_child) THEN RETURN true; END IF;
    END LOOP;
  ELSIF jsonb_typeof(p_value) = 'array' THEN
    FOR v_child IN SELECT value FROM jsonb_array_elements(p_value)
    LOOP
      IF public.sac_json_contains_secret_key(v_child) THEN RETURN true; END IF;
    END LOOP;
  END IF;
  RETURN false;
END;
$body$;

CREATE TABLE IF NOT EXISTS public.sac_tenants (
  id text PRIMARY KEY,
  display_name text NOT NULL,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('provisioning', 'active', 'suspended', 'disabled')),
  settings jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(settings) = 'object')
    CHECK (NOT public.sac_json_contains_secret_key(settings)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT sac_tenants_id_valid CHECK (id ~ '^[a-z][a-z0-9_-]{1,62}$'),
  CONSTRAINT sac_tenants_name_not_blank CHECK (btrim(display_name) <> '')
);

CREATE TABLE IF NOT EXISTS public.sac_agents (
  tenant_id text NOT NULL REFERENCES public.sac_tenants(id) ON DELETE RESTRICT,
  id text NOT NULL,
  display_name text NOT NULL,
  schema_name name NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'provisioning'
    CHECK (status IN ('provisioning', 'provisioned', 'active', 'suspended', 'disabled')),
  runtime_config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(runtime_config) = 'object')
    CHECK (NOT public.sac_json_contains_secret_key(runtime_config)),
  hermes_api_key_secret_ref text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT sac_agents_id_valid CHECK (id ~ '^[a-z][a-z0-9_-]{1,62}$'),
  CONSTRAINT sac_agents_name_not_blank CHECK (btrim(display_name) <> ''),
  CONSTRAINT sac_agents_hermes_ref_safe CHECK (
    hermes_api_key_secret_ref IS NULL OR public.sac_secret_ref_valid(hermes_api_key_secret_ref)
  ),
  CONSTRAINT sac_agents_active_configured CHECK (
    status <> 'active' OR (
      hermes_api_key_secret_ref IS NOT NULL
      AND jsonb_typeof(runtime_config -> 'hermes') = 'object'
      AND btrim(runtime_config #>> '{hermes,base_url}') <> ''
    )
  ),
  CONSTRAINT sac_agents_runtime_config_keys CHECK (
    runtime_config = '{}'::jsonb OR (
      runtime_config - 'hermes' = '{}'::jsonb
      AND jsonb_typeof(runtime_config -> 'hermes') = 'object'
      AND (runtime_config -> 'hermes') - ARRAY['base_url', 'model'] = '{}'::jsonb
    )
  ),
  CONSTRAINT sac_agents_schema_safe CHECK (
    schema_name::text ~ '^sac_[a-z][a-z0-9_]{1,58}$'
    AND schema_name::text !~ '^pg_'
  )
);

CREATE TABLE IF NOT EXISTS public.sac_channel_accounts (
  tenant_id text NOT NULL,
  agent_id text NOT NULL,
  id text NOT NULL,
  channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'email')),
  provider text NOT NULL,
  external_account_id text NOT NULL,
  public_endpoint_id text UNIQUE,
  signature_secret_ref text,
  verify_secret_ref text,
  signature_header text,
  access_token_secret_ref text,
  api_key_secret_ref text,
  smtp_username_secret_ref text,
  smtp_password_secret_ref text,
  imap_username_secret_ref text,
  imap_password_secret_ref text,
  display_name text,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'disabled', 'error')),
  config jsonb NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(config) = 'object')
    CHECK (NOT public.sac_json_contains_secret_key(config)),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, agent_id, id),
  FOREIGN KEY (tenant_id, agent_id)
    REFERENCES public.sac_agents(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT sac_channel_accounts_provider_not_blank CHECK (btrim(provider) <> ''),
  CONSTRAINT sac_channel_accounts_external_not_blank CHECK (btrim(external_account_id) <> ''),
  CONSTRAINT sac_channel_accounts_endpoint_safe CHECK (
    public_endpoint_id IS NULL OR public_endpoint_id ~ '^[A-Za-z0-9_-]{16,128}$'
  ),
  CONSTRAINT sac_channel_accounts_webhook_pair CHECK (
    (public_endpoint_id IS NULL) = (signature_secret_ref IS NULL)
  ),
  CONSTRAINT sac_channel_accounts_secret_refs_safe CHECK (
    (signature_secret_ref IS NULL OR public.sac_secret_ref_valid(signature_secret_ref))
    AND (verify_secret_ref IS NULL OR public.sac_secret_ref_valid(verify_secret_ref))
    AND (access_token_secret_ref IS NULL OR public.sac_secret_ref_valid(access_token_secret_ref))
    AND (api_key_secret_ref IS NULL OR public.sac_secret_ref_valid(api_key_secret_ref))
    AND (smtp_username_secret_ref IS NULL OR public.sac_secret_ref_valid(smtp_username_secret_ref))
    AND (smtp_password_secret_ref IS NULL OR public.sac_secret_ref_valid(smtp_password_secret_ref))
    AND (imap_username_secret_ref IS NULL OR public.sac_secret_ref_valid(imap_username_secret_ref))
    AND (imap_password_secret_ref IS NULL OR public.sac_secret_ref_valid(imap_password_secret_ref))
  ),
  CONSTRAINT sac_channel_accounts_verify_ref_not_blank CHECK (
    verify_secret_ref IS NULL OR btrim(verify_secret_ref) <> ''
  ),
  CONSTRAINT sac_channel_accounts_signature_header_safe CHECK (
    signature_header IS NULL OR signature_header ~ '^[A-Za-z][A-Za-z0-9-]{0,99}$'
  ),
  CONSTRAINT sac_channel_accounts_active_provider_config CHECK (
    status <> 'active' OR
    (provider = 'meta' AND channel IN ('whatsapp', 'instagram')
      AND access_token_secret_ref IS NOT NULL
      AND public_endpoint_id IS NOT NULL) OR
    (provider = 'brevo' AND channel = 'email' AND api_key_secret_ref IS NOT NULL) OR
    (provider = 'smtp' AND channel = 'email' AND smtp_password_secret_ref IS NOT NULL)
  ),
  CONSTRAINT sac_channel_accounts_public_config_keys CHECK (
    (provider = 'meta' AND config - ARRAY['graph_url'] = '{}'::jsonb) OR
    (provider = 'brevo' AND config - ARRAY['api_url', 'sender_email', 'sender_name'] = '{}'::jsonb) OR
    (provider = 'smtp' AND config - ARRAY[
      'host', 'port', 'sender_email', 'sender_name', 'starttls', 'ssl'
    ] = '{}'::jsonb) OR
    (provider NOT IN ('meta', 'brevo', 'smtp') AND config = '{}'::jsonb)
  ),
  CONSTRAINT sac_channel_accounts_external_uq
    UNIQUE (tenant_id, agent_id, channel, provider, external_account_id)
);

-- Registro de versoes por control plane e por data plane provisionado.
CREATE TABLE IF NOT EXISTS public.sac_schema_migrations (
  tenant_id text NOT NULL DEFAULT '',
  agent_id text NOT NULL DEFAULT '',
  version text NOT NULL,
  description text NOT NULL,
  checksum text NOT NULL,
  applied_by text NOT NULL DEFAULT session_user,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, agent_id, version),
  CONSTRAINT sac_schema_migrations_scope_valid CHECK (
    (tenant_id = '' AND agent_id = '') OR (tenant_id <> '' AND agent_id <> '')
  ),
  CONSTRAINT sac_schema_migrations_version_not_blank CHECK (btrim(version) <> ''),
  CONSTRAINT sac_schema_migrations_checksum_not_blank CHECK (btrim(checksum) <> '')
);

INSERT INTO public.sac_schema_migrations
  (tenant_id, agent_id, version, description, checksum)
VALUES
  ('', '', '002', 'SAC multiagente v2 control plane', 'embedded:002_sac_multiagent_v2')
ON CONFLICT (tenant_id, agent_id, version) DO NOTHING;

-- Indices que servem o painel de analytics. Ficam numa funcao propria para
-- terem uma fonte unica: o provisionamento de um agente novo e o upgrade de um
-- agente ja instalado executam exatamente o mesmo texto. Todos sao aditivos e
-- idempotentes (IF NOT EXISTS); nenhum substitui ou remove indice existente.
--
-- Por que cada um existe:
--   sac_messages_window_idx        varredura por janela de tempo sobre toda a
--                                  tabela; o indice antigo comeca por thread_id
--                                  e nao serve para filtro so por occurred_at.
--                                  INCLUDE cobre direction/thread_id/status e
--                                  deixa a contagem em index-only scan.
--   sac_threads_created_idx        conversas novas por dia.
--   sac_threads_closed_idx         tempo de resolucao le so conversa fechada.
--   sac_contacts_created_idx       contatos novos por dia, ignorando merge.
--   sac_origins_created_idx        aquisicao por janela; o indice antigo comeca
--                                  por contact_id.
--   sac_pipeline_history_*         funil: varredura por janela e a particao por
--                                  contato usada no calculo de permanencia.
--   sac_outbox_health_idx          saude da fila sem tocar o volume publicado.
--   sac_dead_letters_failed_idx    idade e recorte da DLQ.
--   sac_audit_actor_idx            atividade por operador na janela.
CREATE OR REPLACE FUNCTION public.sac_analytics_index_ddl(p_schema name)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $function$
  SELECT pg_catalog.format($ddl$
    CREATE INDEX IF NOT EXISTS sac_messages_window_idx ON %1$I.sac_messages
      (occurred_at, direction) INCLUDE (thread_id, status);
    CREATE INDEX IF NOT EXISTS sac_threads_created_idx ON %1$I.sac_threads
      (created_at, channel);
    CREATE INDEX IF NOT EXISTS sac_threads_closed_idx ON %1$I.sac_threads
      (updated_at) WHERE status = 'closed';
    CREATE INDEX IF NOT EXISTS sac_contacts_created_idx ON %1$I.sac_contacts
      (created_at) WHERE merged_into IS NULL;
    CREATE INDEX IF NOT EXISTS sac_origins_created_idx ON %1$I.sac_origins
      (created_at, contact_id);
    CREATE INDEX IF NOT EXISTS sac_pipeline_history_timeline_idx
      ON %1$I.sac_pipeline_history (created_at, id);
    CREATE INDEX IF NOT EXISTS sac_pipeline_history_contact_idx
      ON %1$I.sac_pipeline_history (contact_id, created_at, id);
    CREATE INDEX IF NOT EXISTS sac_outbox_health_idx ON %1$I.sac_outbox
      (status, topic, created_at) WHERE status <> 'published';
    CREATE INDEX IF NOT EXISTS sac_dead_letters_failed_idx ON %1$I.sac_dead_letters
      (failed_at DESC, topic);
    CREATE INDEX IF NOT EXISTS sac_audit_actor_idx ON %1$I.sac_audit_log
      (occurred_at, actor_id, action);
  $ddl$, p_schema);
$function$;

-- Aplica os indices de analytics a um agente ja provisionado. E aditivo: nao
-- cria, altera nem remove tabela, coluna ou dado. Reexecutar e no-op.
CREATE OR REPLACE FUNCTION public.sac_apply_analytics_indexes(
  p_tenant_id text,
  p_agent_id text
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_schema name;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~ '^[a-z][a-z0-9_-]{1,62}$' THEN
    RAISE EXCEPTION 'tenant_id invalido' USING ERRCODE = '22023';
  END IF;
  IF p_agent_id IS NULL OR p_agent_id !~ '^[a-z][a-z0-9_-]{1,62}$' THEN
    RAISE EXCEPTION 'agent_id invalido' USING ERRCODE = '22023';
  END IF;

  SELECT schema_name INTO v_schema FROM public.sac_agents
   WHERE tenant_id = p_tenant_id AND id = p_agent_id;
  IF v_schema IS NULL THEN
    RAISE EXCEPTION 'agente nao cadastrado no control plane' USING ERRCODE = '23503';
  END IF;
  IF pg_catalog.to_regnamespace(v_schema::text) IS NULL THEN
    RAISE EXCEPTION 'schema do agente nao existe' USING ERRCODE = '42P01';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id || ':' || p_agent_id, 20260909)
  );
  EXECUTE public.sac_analytics_index_ddl(v_schema);

  INSERT INTO public.sac_schema_migrations
    (tenant_id, agent_id, version, description, checksum)
  VALUES (p_tenant_id, p_agent_id, '002.1', 'Indices de analytics do painel',
          'embedded:002_sac_analytics_indexes')
  ON CONFLICT (tenant_id, agent_id, version) DO NOTHING;
END;
$function$;

-- Instala um data plane em schema ja reservado no control plane. SECURITY
-- DEFINER e search_path fechado evitam sequestro de objetos. Todo identificador
-- dinamico passa por format(%I); tenant/agente passam por format(%L).
CREATE OR REPLACE FUNCTION public.sac_install_agent_schema(
  p_tenant_id text,
  p_agent_id text,
  p_schema_name name,
  p_owner_role name,
  p_app_role name,
  p_worker_role name
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
DECLARE
  v_schema text := p_schema_name::text;
  v_owner oid;
  v_app oid;
  v_worker oid;
  v_sql text;
  v_object text;
BEGIN
  IF p_tenant_id IS NULL OR p_tenant_id !~ '^[a-z][a-z0-9_-]{1,62}$' THEN
    RAISE EXCEPTION 'tenant_id invalido' USING ERRCODE = '22023';
  END IF;
  IF p_agent_id IS NULL OR p_agent_id !~ '^[a-z][a-z0-9_-]{1,62}$' THEN
    RAISE EXCEPTION 'agent_id invalido' USING ERRCODE = '22023';
  END IF;
  IF v_schema IS NULL OR v_schema !~ '^sac_[a-z][a-z0-9_]{1,58}$' OR v_schema ~ '^pg_' THEN
    RAISE EXCEPTION 'schema_name invalido' USING ERRCODE = '22023';
  END IF;

  SELECT oid INTO v_owner FROM pg_catalog.pg_roles WHERE rolname = p_owner_role::text;
  SELECT oid INTO v_app FROM pg_catalog.pg_roles WHERE rolname = p_app_role::text;
  SELECT oid INTO v_worker FROM pg_catalog.pg_roles WHERE rolname = p_worker_role::text;
  IF v_owner IS NULL OR v_app IS NULL OR v_worker IS NULL THEN
    RAISE EXCEPTION 'owner_role, app_role e worker_role devem existir' USING ERRCODE = '42704';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.sac_agents
     WHERE tenant_id = p_tenant_id AND id = p_agent_id AND schema_name = p_schema_name
  ) THEN
    RAISE EXCEPTION 'agente/schema nao reservado no control plane' USING ERRCODE = '23503';
  END IF;

  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_tenant_id || ':' || p_agent_id, 20260909)
  );

  IF pg_catalog.to_regnamespace(v_schema) IS NOT NULL THEN
    RAISE EXCEPTION 'schema % ja existe; provisionamento recusado', v_schema
      USING ERRCODE = '42P06';
  END IF;

  EXECUTE pg_catalog.format('CREATE SCHEMA %I AUTHORIZATION %I', v_schema, p_owner_role);

  v_sql := pg_catalog.format($ddl$
    CREATE TABLE %1$I.sac_contacts (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      display_name text,
      pipeline_stage text NOT NULL DEFAULT 'new',
      merged_into text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      UNIQUE (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(id) <> ''),
      CHECK (merged_into IS NULL OR merged_into <> id),
      FOREIGN KEY (tenant_id, agent_id, merged_into)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE %1$I.sac_identities (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      contact_id text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'email')),
      account_id text NOT NULL,
      external_user_id text NOT NULL,
      display_name text,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(external_user_id) <> ''),
      FOREIGN KEY (tenant_id, agent_id, contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, agent_id, account_id)
        REFERENCES public.sac_channel_accounts(tenant_id, agent_id, id) ON DELETE RESTRICT,
      UNIQUE (tenant_id, agent_id, channel, account_id, external_user_id)
    );

    CREATE TABLE %1$I.sac_threads (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      identity_id text NOT NULL,
      channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'email')),
      account_id text NOT NULL,
      external_thread_id text NOT NULL,
      status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'waiting', 'closed')),
      assigned_to text,
      bot_paused boolean NOT NULL DEFAULT false,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(external_thread_id) <> ''),
      FOREIGN KEY (tenant_id, agent_id, identity_id)
        REFERENCES %1$I.sac_identities(tenant_id, agent_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, agent_id, account_id)
        REFERENCES public.sac_channel_accounts(tenant_id, agent_id, id) ON DELETE RESTRICT,
      UNIQUE (tenant_id, agent_id, identity_id, channel, account_id, external_thread_id)
    );

    CREATE TABLE %1$I.sac_inbound_events (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      dedupe_key text NOT NULL,
      provider_event_id text,
      channel text NOT NULL CHECK (channel IN ('whatsapp', 'instagram', 'email')),
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      received_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      processed_at timestamptz,
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(dedupe_key) <> ''),
      CHECK (processed_at IS NULL OR processed_at >= received_at),
      UNIQUE (tenant_id, agent_id, dedupe_key)
    );

    CREATE TABLE %1$I.sac_messages (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      thread_id text NOT NULL,
      event_id text,
      direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      provider_event_id text,
      occurred_at timestamptz NOT NULL,
      body jsonb NOT NULL CHECK (jsonb_typeof(body) = 'object'),
      status text NOT NULL DEFAULT 'received'
        CHECK (status IN ('received', 'queued', 'sent', 'delivered', 'read', 'failed')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      FOREIGN KEY (tenant_id, agent_id, thread_id)
        REFERENCES %1$I.sac_threads(tenant_id, agent_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, agent_id, event_id)
        REFERENCES %1$I.sac_inbound_events(tenant_id, agent_id, id) ON DELETE RESTRICT,
      CHECK (provider_event_id IS NULL OR btrim(provider_event_id) <> '')
    );

    CREATE TABLE %1$I.sac_origins (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      contact_id text NOT NULL,
      message_id text NOT NULL,
      data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      FOREIGN KEY (tenant_id, agent_id, contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, agent_id, message_id)
        REFERENCES %1$I.sac_messages(tenant_id, agent_id, id) ON DELETE RESTRICT,
      UNIQUE (tenant_id, agent_id, message_id)
    );

    CREATE TABLE %1$I.sac_domain_events (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      event_type text NOT NULL,
      aggregate_id text NOT NULL,
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(event_type) <> '' AND btrim(aggregate_id) <> '')
    );

    CREATE TABLE %1$I.sac_outbox (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      topic text NOT NULL,
      aggregate_id text NOT NULL,
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'retry', 'processing', 'published', 'dead')),
      attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      max_attempts integer NOT NULL DEFAULT 6 CHECK (max_attempts > 0),
      available_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      lease_token text,
      leased_until timestamptz,
      published_at timestamptz,
      last_error text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(topic) <> '' AND btrim(aggregate_id) <> ''),
      CHECK ((status = 'processing') = (lease_token IS NOT NULL AND leased_until IS NOT NULL)),
      CHECK (published_at IS NULL OR status = 'published')
    );

    CREATE TABLE %1$I.sac_dead_letters (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      outbox_id text NOT NULL,
      topic text NOT NULL,
      aggregate_id text NOT NULL,
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      attempts integer NOT NULL CHECK (attempts > 0),
      last_error text NOT NULL,
      failed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      UNIQUE (tenant_id, agent_id, outbox_id),
      FOREIGN KEY (tenant_id, agent_id, outbox_id)
        REFERENCES %1$I.sac_outbox(tenant_id, agent_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE %1$I.sac_pipeline_history (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      contact_id text NOT NULL,
      from_stage text,
      to_stage text NOT NULL,
      actor text NOT NULL,
      reason text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(to_stage) <> '' AND btrim(actor) <> ''),
      FOREIGN KEY (tenant_id, agent_id, contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE RESTRICT
    );

    CREATE TABLE %1$I.sac_tags (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      name text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(name) <> ''),
      UNIQUE (tenant_id, agent_id, name)
    );

    CREATE TABLE %1$I.sac_contact_tags (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      contact_id text NOT NULL,
      tag_id text NOT NULL,
      source text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, contact_id, tag_id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(source) <> ''),
      FOREIGN KEY (tenant_id, agent_id, contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE CASCADE,
      FOREIGN KEY (tenant_id, agent_id, tag_id)
        REFERENCES %1$I.sac_tags(tenant_id, agent_id, id) ON DELETE CASCADE
    );

    CREATE TABLE %1$I.sac_contact_points (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      contact_id text NOT NULL,
      kind text NOT NULL CHECK (kind IN ('email', 'phone', 'instagram', 'whatsapp', 'other')),
      value text NOT NULL,
      normalized_value text NOT NULL,
      source text NOT NULL,
      verified_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(normalized_value) <> '' AND btrim(source) <> ''),
      FOREIGN KEY (tenant_id, agent_id, contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE CASCADE,
      UNIQUE (tenant_id, agent_id, kind, normalized_value)
    );

    CREATE TABLE %1$I.sac_profile_fields (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      contact_id text NOT NULL,
      field_name text NOT NULL,
      value jsonb NOT NULL,
      source text NOT NULL,
      confidence numeric(4,3) NOT NULL DEFAULT 1 CHECK (confidence BETWEEN 0 AND 1),
      observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(field_name) <> '' AND btrim(source) <> ''),
      FOREIGN KEY (tenant_id, agent_id, contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE CASCADE,
      UNIQUE (tenant_id, agent_id, contact_id, field_name, source)
    );

    CREATE TABLE %1$I.sac_contact_merges (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      source_contact_id text NOT NULL,
      target_contact_id text NOT NULL,
      actor text NOT NULL,
      reason text NOT NULL,
      snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (source_contact_id <> target_contact_id),
      CHECK (btrim(actor) <> '' AND btrim(reason) <> ''),
      FOREIGN KEY (tenant_id, agent_id, source_contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE RESTRICT,
      FOREIGN KEY (tenant_id, agent_id, target_contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE RESTRICT,
      UNIQUE (tenant_id, agent_id, source_contact_id)
    );

    CREATE TABLE %1$I.sac_crm_actions (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id text NOT NULL,
      contact_id text,
      action text NOT NULL,
      idempotency_key text NOT NULL,
      actor text NOT NULL,
      payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(payload) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(action) <> '' AND btrim(actor) <> ''),
      CHECK (btrim(idempotency_key) <> ''),
      FOREIGN KEY (tenant_id, agent_id, contact_id)
        REFERENCES %1$I.sac_contacts(tenant_id, agent_id, id) ON DELETE RESTRICT,
      UNIQUE (tenant_id, agent_id, action, idempotency_key)
    );

    CREATE TABLE %1$I.sac_audit_log (
      tenant_id text NOT NULL DEFAULT %2$L,
      agent_id text NOT NULL DEFAULT %3$L,
      id bigint GENERATED ALWAYS AS IDENTITY,
      actor_type text NOT NULL CHECK (actor_type IN ('user', 'agent', 'worker', 'system')),
      actor_id text,
      action text NOT NULL,
      object_type text NOT NULL,
      object_id text,
      data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, id),
      CHECK (tenant_id = %2$L AND agent_id = %3$L),
      CHECK (btrim(action) <> '' AND btrim(object_type) <> '')
    );

    CREATE INDEX sac_contacts_stage_idx ON %1$I.sac_contacts(pipeline_stage, updated_at DESC);
    CREATE INDEX sac_threads_status_idx ON %1$I.sac_threads(status, updated_at DESC);
    CREATE INDEX sac_messages_timeline_idx ON %1$I.sac_messages(thread_id, occurred_at, id);
    CREATE INDEX sac_origins_contact_idx ON %1$I.sac_origins(contact_id, created_at, id);
    CREATE UNIQUE INDEX sac_messages_provider_uq ON %1$I.sac_messages
      (tenant_id, agent_id, thread_id, provider_event_id, direction)
      WHERE provider_event_id IS NOT NULL;
    CREATE INDEX sac_inbound_unprocessed_idx ON %1$I.sac_inbound_events(received_at)
      WHERE processed_at IS NULL;
    CREATE INDEX sac_domain_events_timeline_idx ON %1$I.sac_domain_events(created_at, id);
    CREATE INDEX sac_outbox_claim_idx ON %1$I.sac_outbox(available_at, created_at)
      WHERE status IN ('pending', 'retry', 'processing');
    CREATE UNIQUE INDEX sac_outbox_outbound_idempotency_uq ON %1$I.sac_outbox
      (tenant_id, agent_id, topic, aggregate_id) WHERE topic = 'outbound.send';
    CREATE INDEX sac_audit_timeline_idx ON %1$I.sac_audit_log(occurred_at DESC, id DESC);
  $ddl$, v_schema, p_tenant_id, p_agent_id);
  EXECUTE v_sql;

  -- Indices de analytics pela mesma fonte usada no upgrade de agente antigo.
  EXECUTE public.sac_analytics_index_ddl(v_schema);

  -- Relogio de updated_at sem depender do search_path da sessao.
  EXECUTE pg_catalog.format($fn$
    CREATE FUNCTION %1$I.sac_touch_updated_at() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
    BEGIN NEW.updated_at := clock_timestamp(); RETURN NEW; END
    $body$;
    CREATE TRIGGER sac_contacts_touch BEFORE UPDATE ON %1$I.sac_contacts
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_touch_updated_at();
    CREATE TRIGGER sac_threads_touch BEFORE UPDATE ON %1$I.sac_threads
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_touch_updated_at();
    CREATE TRIGGER sac_outbox_touch BEFORE UPDATE ON %1$I.sac_outbox
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_touch_updated_at();
  $fn$, v_schema);

  -- Logs de dominio, DLQ e auditoria sao append-only.
  EXECUTE pg_catalog.format($fn$
    CREATE FUNCTION %1$I.sac_reject_mutation() RETURNS trigger
    LANGUAGE plpgsql SET search_path = pg_catalog AS $body$
    BEGIN
      RAISE EXCEPTION '%% e append-only', TG_TABLE_NAME USING ERRCODE = '55000';
    END
    $body$;
    CREATE TRIGGER sac_domain_events_append_only BEFORE UPDATE OR DELETE ON %1$I.sac_domain_events
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_reject_mutation();
    CREATE TRIGGER sac_dead_letters_append_only BEFORE UPDATE OR DELETE ON %1$I.sac_dead_letters
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_reject_mutation();
    CREATE TRIGGER sac_audit_log_append_only BEFORE UPDATE OR DELETE ON %1$I.sac_audit_log
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_reject_mutation();
    CREATE TRIGGER sac_contact_merges_append_only BEFORE UPDATE OR DELETE ON %1$I.sac_contact_merges
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_reject_mutation();
    CREATE TRIGGER sac_crm_actions_append_only BEFORE UPDATE OR DELETE ON %1$I.sac_crm_actions
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_reject_mutation();
    CREATE TRIGGER sac_origins_append_only BEFORE UPDATE OR DELETE ON %1$I.sac_origins
      FOR EACH ROW EXECUTE FUNCTION %1$I.sac_reject_mutation();
  $fn$, v_schema);

  -- Claim atomico com SKIP LOCKED. O token impede ACK/NACK por outro worker.
  EXECUTE pg_catalog.format($fn$
    CREATE FUNCTION %1$I.sac_claim_outbox(
      p_worker text, p_limit integer DEFAULT 20, p_lease interval DEFAULT interval '2 minutes'
    ) RETURNS SETOF %1$I.sac_outbox
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE v_expired %1$I.sac_outbox%%ROWTYPE;
    BEGIN
      IF p_worker IS NULL OR btrim(p_worker) = '' OR p_limit NOT BETWEEN 1 AND 500
         OR p_lease <= interval '0 seconds' OR p_lease > interval '1 hour' THEN
        RAISE EXCEPTION 'parametros de lease invalidos' USING ERRCODE = '22023';
      END IF;

      -- Um worker que morre na ultima tentativa nao pode deixar item preso
      -- para sempre em processing. O proximo claim conclui a ida para a DLQ.
      FOR v_expired IN
        SELECT * FROM %1$I.sac_outbox
         WHERE status = 'processing' AND leased_until <= clock_timestamp()
           AND attempts >= max_attempts
         FOR UPDATE SKIP LOCKED
      LOOP
        INSERT INTO %1$I.sac_dead_letters
          (tenant_id, agent_id, id, outbox_id, topic, aggregate_id, payload,
           attempts, last_error)
        VALUES (%2$L, %3$L, 'dlq_' || v_expired.id, v_expired.id,
                v_expired.topic, v_expired.aggregate_id, v_expired.payload,
                v_expired.attempts, coalesce(v_expired.last_error, 'lease expirou na ultima tentativa'))
        ON CONFLICT (tenant_id, agent_id, outbox_id) DO NOTHING;
        UPDATE %1$I.sac_outbox SET status = 'dead', lease_token = NULL,
          leased_until = NULL,
          last_error = coalesce(last_error, 'lease expirou na ultima tentativa')
         WHERE id = v_expired.id;
        INSERT INTO %1$I.sac_audit_log
          (actor_type, actor_id, action, object_type, object_id, data)
        VALUES ('worker', p_worker, 'outbox.lease_exhausted', 'outbox',
                v_expired.id, jsonb_build_object('attempts', v_expired.attempts));
      END LOOP;

      RETURN QUERY
      WITH candidates AS (
        SELECT tenant_id, agent_id, id
          FROM %1$I.sac_outbox
         WHERE ((status IN ('pending', 'retry') AND available_at <= clock_timestamp())
             OR (status = 'processing' AND leased_until <= clock_timestamp()))
           AND attempts < max_attempts
         ORDER BY available_at, created_at
         FOR UPDATE SKIP LOCKED
         LIMIT p_limit
      )
      UPDATE %1$I.sac_outbox o
         SET status = 'processing', attempts = attempts + 1,
             lease_token = p_worker || ':' || md5(random()::text || clock_timestamp()::text || o.id),
             leased_until = clock_timestamp() + p_lease, last_error = NULL
        FROM candidates c
       WHERE (o.tenant_id, o.agent_id, o.id) = (c.tenant_id, c.agent_id, c.id)
      RETURNING o.*;
    END
    $body$;
  $fn$, v_schema, p_tenant_id, p_agent_id);

  EXECUTE pg_catalog.format($fn$
    CREATE FUNCTION %1$I.sac_ack_outbox(p_id text, p_lease_token text) RETURNS boolean
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE v_changed boolean;
    BEGIN
      UPDATE %1$I.sac_outbox
         SET status = 'published', published_at = clock_timestamp(),
             lease_token = NULL, leased_until = NULL, last_error = NULL
       WHERE tenant_id = %2$L AND agent_id = %3$L AND id = p_id
         AND status = 'processing' AND lease_token = p_lease_token
         AND leased_until > clock_timestamp()
      RETURNING true INTO v_changed;
      RETURN coalesce(v_changed, false);
    END
    $body$;
  $fn$, v_schema, p_tenant_id, p_agent_id);

  -- NACK reprograma com backoff limitado ou move para DLQ na mesma transacao.
  EXECUTE pg_catalog.format($fn$
    CREATE FUNCTION %1$I.sac_fail_outbox(
      p_id text, p_lease_token text, p_error text, p_retry_delay interval DEFAULT interval '1 minute'
    ) RETURNS text
    LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $body$
    DECLARE v_row %1$I.sac_outbox%%ROWTYPE;
    BEGIN
      IF p_error IS NULL OR btrim(p_error) = '' OR p_retry_delay < interval '0 seconds'
         OR p_retry_delay > interval '24 hours' THEN
        RAISE EXCEPTION 'parametros de falha invalidos' USING ERRCODE = '22023';
      END IF;
      SELECT * INTO v_row FROM %1$I.sac_outbox
       WHERE tenant_id = %2$L AND agent_id = %3$L AND id = p_id
         AND status = 'processing' AND lease_token = p_lease_token
       FOR UPDATE;
      IF NOT FOUND THEN RETURN 'not_owned'; END IF;

      IF v_row.attempts >= v_row.max_attempts THEN
        UPDATE %1$I.sac_outbox SET status = 'dead', lease_token = NULL,
          leased_until = NULL, last_error = left(p_error, 4000) WHERE id = p_id;
        INSERT INTO %1$I.sac_dead_letters
          (tenant_id, agent_id, id, outbox_id, topic, aggregate_id, payload, attempts, last_error)
        VALUES (%2$L, %3$L, 'dlq_' || p_id, p_id, v_row.topic, v_row.aggregate_id,
                v_row.payload, v_row.attempts, left(p_error, 4000));
        INSERT INTO %1$I.sac_audit_log
          (actor_type, actor_id, action, object_type, object_id, data)
        VALUES ('worker', split_part(p_lease_token, ':', 1), 'outbox.dead_lettered',
                'outbox', p_id, jsonb_build_object('attempts', v_row.attempts));
        RETURN 'dead';
      END IF;

      UPDATE %1$I.sac_outbox SET status = 'retry', lease_token = NULL,
        leased_until = NULL, available_at = clock_timestamp() + p_retry_delay,
        last_error = left(p_error, 4000) WHERE id = p_id;
      RETURN 'retry';
    END
    $body$;
  $fn$, v_schema, p_tenant_id, p_agent_id);

  -- CREATE dentro de SECURITY DEFINER pertence ao dono da funcao, nao ao dono
  -- do schema. Transfere cada objeto explicitamente para a role owner.
  FOREACH v_object IN ARRAY ARRAY[
    'sac_contacts', 'sac_identities', 'sac_threads', 'sac_inbound_events',
    'sac_messages', 'sac_origins', 'sac_domain_events', 'sac_outbox',
    'sac_dead_letters', 'sac_pipeline_history', 'sac_tags', 'sac_contact_tags',
    'sac_contact_points', 'sac_profile_fields', 'sac_contact_merges',
    'sac_crm_actions', 'sac_audit_log'
  ]
  LOOP
    EXECUTE pg_catalog.format('ALTER TABLE %I.%I OWNER TO %I',
                              v_schema, v_object, p_owner_role);
  END LOOP;
  EXECUTE pg_catalog.format('ALTER SEQUENCE %I.sac_audit_log_id_seq OWNER TO %I',
                            v_schema, p_owner_role);
  EXECUTE pg_catalog.format('ALTER FUNCTION %I.sac_touch_updated_at() OWNER TO %I',
                            v_schema, p_owner_role);
  EXECUTE pg_catalog.format('ALTER FUNCTION %I.sac_reject_mutation() OWNER TO %I',
                            v_schema, p_owner_role);
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.sac_claim_outbox(text,integer,interval) OWNER TO %I',
    v_schema, p_owner_role
  );
  EXECUTE pg_catalog.format('ALTER FUNCTION %I.sac_ack_outbox(text,text) OWNER TO %I',
                            v_schema, p_owner_role);
  EXECUTE pg_catalog.format(
    'ALTER FUNCTION %I.sac_fail_outbox(text,text,text,interval) OWNER TO %I',
    v_schema, p_owner_role
  );

  -- Sem CREATE para app/worker; migrations continuam sob o owner/deployer.
  EXECUTE pg_catalog.format('REVOKE ALL ON SCHEMA %I FROM PUBLIC', v_schema);
  EXECUTE pg_catalog.format('GRANT USAGE ON SCHEMA %I TO %I, %I', v_schema, p_app_role, p_worker_role);
  EXECUTE pg_catalog.format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I', v_schema, p_app_role);
  EXECUTE pg_catalog.format(
    'GRANT DELETE ON %I.sac_contact_points, %I.sac_profile_fields, %I.sac_contact_tags TO %I',
    v_schema, v_schema, v_schema, p_app_role
  );
  EXECUTE pg_catalog.format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', v_schema, p_app_role);
  EXECUTE pg_catalog.format('GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA %I TO %I', v_schema, p_worker_role);
  EXECUTE pg_catalog.format('GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA %I TO %I', v_schema, p_worker_role);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.sac_claim_outbox(text, integer, interval) FROM PUBLIC', v_schema);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.sac_ack_outbox(text, text) FROM PUBLIC', v_schema);
  EXECUTE pg_catalog.format('REVOKE ALL ON FUNCTION %I.sac_fail_outbox(text, text, text, interval) FROM PUBLIC', v_schema);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %I.sac_claim_outbox(text, integer, interval) TO %I', v_schema, p_worker_role);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %I.sac_ack_outbox(text, text) TO %I', v_schema, p_worker_role);
  EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION %I.sac_fail_outbox(text, text, text, interval) TO %I', v_schema, p_worker_role);

  INSERT INTO public.sac_schema_migrations
    (tenant_id, agent_id, version, description, checksum)
  VALUES (p_tenant_id, p_agent_id, '002', 'SAC multiagente v2 data plane',
          'embedded:002_sac_multiagent_v2'),
         (p_tenant_id, p_agent_id, '002.1', 'Indices de analytics do painel',
          'embedded:002_sac_analytics_indexes')
  ON CONFLICT (tenant_id, agent_id, version) DO NOTHING;

  UPDATE public.sac_agents SET status = 'provisioned', updated_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id AND id = p_agent_id;
END;
$function$;

-- Reserva control plane e instala o schema numa unica transacao. Se qualquer
-- DDL falhar, tenant/agente/schema voltam juntos.
CREATE OR REPLACE FUNCTION public.sac_provision_agent(
  p_tenant_id text,
  p_tenant_name text,
  p_agent_id text,
  p_agent_name text,
  p_schema_name name,
  p_owner_role name,
  p_app_role name,
  p_worker_role name,
  p_runtime_config jsonb DEFAULT '{}'::jsonb,
  p_hermes_api_key_secret_ref text DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF p_tenant_name IS NULL OR btrim(p_tenant_name) = ''
     OR p_agent_name IS NULL OR btrim(p_agent_name) = '' THEN
    RAISE EXCEPTION 'nomes nao podem ser vazios' USING ERRCODE = '22023';
  END IF;
  IF p_runtime_config IS NULL OR jsonb_typeof(p_runtime_config) <> 'object'
     OR public.sac_json_contains_secret_key(p_runtime_config) THEN
    RAISE EXCEPTION 'runtime_config deve conter somente configuracao publica'
      USING ERRCODE = '22023';
  END IF;
  IF p_hermes_api_key_secret_ref IS NOT NULL
     AND NOT public.sac_secret_ref_valid(p_hermes_api_key_secret_ref) THEN
    RAISE EXCEPTION 'hermes_api_key_secret_ref invalida' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.sac_tenants(id, display_name, status)
  VALUES (p_tenant_id, p_tenant_name, 'provisioning')
  ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name;

  INSERT INTO public.sac_agents
    (tenant_id, id, display_name, schema_name, status, runtime_config,
     hermes_api_key_secret_ref)
  VALUES
    (p_tenant_id, p_agent_id, p_agent_name, p_schema_name, 'provisioning',
     p_runtime_config, p_hermes_api_key_secret_ref);

  PERFORM public.sac_install_agent_schema(
    p_tenant_id, p_agent_id, p_schema_name, p_owner_role, p_app_role, p_worker_role
  );

  UPDATE public.sac_tenants SET status = 'active', updated_at = clock_timestamp()
   WHERE id = p_tenant_id AND status = 'provisioning';
END;
$function$;

-- Ativacao separada: schema pronto nao entra no scheduler antes de Hermes e ao
-- menos uma conta terem configuracao valida por referencias ao cofre.
CREATE OR REPLACE FUNCTION public.sac_activate_agent(p_tenant_id text, p_agent_id text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.sac_agents
     WHERE tenant_id = p_tenant_id AND id = p_agent_id
       AND status IN ('provisioned', 'suspended')
       AND hermes_api_key_secret_ref IS NOT NULL
       AND jsonb_typeof(runtime_config -> 'hermes') = 'object'
       AND btrim(runtime_config #>> '{hermes,base_url}') <> ''
  ) THEN
    RAISE EXCEPTION 'agente nao provisionado ou Hermes incompleto' USING ERRCODE = '23514';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.sac_channel_accounts
     WHERE tenant_id = p_tenant_id AND agent_id = p_agent_id AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'agente sem conta ativa configurada' USING ERRCODE = '23514';
  END IF;
  UPDATE public.sac_agents SET status = 'active', updated_at = clock_timestamp()
   WHERE tenant_id = p_tenant_id AND id = p_agent_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.sac_install_agent_schema(text, text, name, name, name, name) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sac_provision_agent(text, text, text, text, name, name, name, name, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sac_activate_agent(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sac_apply_analytics_indexes(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.sac_analytics_index_ddl(name) FROM PUBLIC;
REVOKE ALL ON public.sac_channel_accounts FROM PUBLIC;
REVOKE ALL ON public.sac_agents FROM PUBLIC;
REVOKE ALL ON public.sac_tenants FROM PUBLIC;
REVOKE ALL ON public.sac_schema_migrations FROM PUBLIC;

COMMIT;
