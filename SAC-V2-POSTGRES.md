# SAC multiagente v2 no PostgreSQL

Esta versão não reaproveita tabelas antigas. O control plane fica em `public`
e cada agente recebe um schema `sac_*` próprio, com `tenant_id` e `agent_id`
fixados por `DEFAULT` e `CHECK` em todas as tabelas. As relações usam FKs
compostas para impedir vínculos entre escopos.

## Arquivos

- `002_sac_multiagent_v2.sql`: control plane, provisionador transacional, data
  plane, outbox com lease/retry/DLQ, auditoria e grants mínimos.
- `002_sac_roles.psql`: grant opcional ao deployer, com identificador citado
  por `format('%I')`; não cria roles e não recebe senha.
- `validate_sac_v2.py`: validação estática sem conexão.
- `tests/test_sac_v2_migration.py`: contrato offline consumido pelo backend.

## Aplicação segura

Crie previamente três roles por política da infraestrutura: owner sem login,
app e worker. A migration revoga acesso de `PUBLIC`; não traz nomes, senhas ou
credenciais embutidas. Depois, conceda o provisionador a uma role de deploy:

    psql -v ON_ERROR_STOP=1 -f 002_sac_multiagent_v2.sql
    psql -v ON_ERROR_STOP=1 -v sac_deployer_role=sac_deployer -f 002_sac_roles.psql

Provisione um agente com identificadores já revisados:

    SELECT public.sac_provision_agent(
      'cliente', 'Cliente', 'agente', 'Agente', 'sac_cliente_agente',
      'sac_owner', 'sac_app', 'sac_worker',
      '{"hermes":{"base_url":"https://hermes.interno","model":"Hermes"}}'::jsonb,
      'cliente/agente/hermes-api-key'
    );

O schema deve começar por `sac_`. A função valida tenant, agente, schema e
existência das roles; serializa provisionamentos concorrentes; recusa schema já
existente; e faz tudo na mesma transação. Não se deve montar esse `SELECT` por
concatenação de entrada HTTP.

## Provisionador operacional

O caminho recomendado é `scripts/provision-sac-v2.py`. Ele usa um manifesto
sem segredos como `config.sac-v2.example.json`; deriva um nome de schema
determinístico e sem colisão quando ele for omitido, mas aceita um schema `sac_*`
explícito e validado; confirma o agente no cadastro `public.agents`; não aceita DSN na
linha de comando; e nunca imprime a URL do banco ou exceções do driver.

O dry-run é o padrão e não abre conexão. Ele exige um inventário exportado para
provar que o agente existe e imprime um plano psql autocontido e revisável:

    python3 scripts/provision-sac-v2.py \
      --manifest config.sac-v2.example.json \
      --registry-json agentes-sem-segredos.json \
      --dry-run --output /tmp/plano-sac-v2.sql

Consultar o estado é somente leitura. A URL fica em variável de ambiente:

    SAC_DATABASE_URL='postgresql://...' \
      python3 scripts/provision-sac-v2.py \
      --manifest config.sac-v2.example.json --status

Aplicação exige duas autorizações independentes e uma confirmação que precisa
coincidir literalmente com `tenant_id/agent_id`:

    SAC_DATABASE_URL='postgresql://...' \
      python3 scripts/provision-sac-v2.py \
      --manifest config.sac-v2.example.json \
      --apply-control-plane --apply-agent \
      --confirm cliente-exemplo/agente-exemplo

Se o control plane já existir, omita `--apply-control-plane`. Reexecutar um
agente totalmente pronto é no-op. Estado parcial, schema divergente ou agente
ausente no cadastro central falham fechados e não são “consertados” apagando
dados. O comando `--status` informa separadamente cadastro, control plane,
linha do agente, schema, configuração pública, canais ativos, versão e
quantidade das 17 tabelas esperadas.

`runtime_config` do agente contém apenas `hermes.base_url` e `hermes.model`;
a chave fica em `hermes_api_key_secret_ref`. Segredos de canais não pertencem
a `config`: as colunas `signature_secret_ref`, `verify_secret_ref`,
`access_token_secret_ref`, `api_key_secret_ref`, `smtp_username_secret_ref`,
`smtp_password_secret_ref`, `imap_username_secret_ref` e
`imap_password_secret_ref` guardam somente referências para um secret manager.
O banco rejeita recursivamente chaves como token, password, passphrase, auth,
credential, private_key e api_key dentro dos JSONs públicos.
`public_endpoint_id` é uma capacidade pública opaca e globalmente única;
`id` é a chave interna da conta e `external_account_id` é o identificador dado
pelo provedor. `sac_channel_accounts` deve ser preenchida pelo control plane
antes de identidades e threads do canal. O registry combina essa tabela com
`sac_agents` para obter `schema_name`, sem confiar no payload do webhook.

Configuração pública aceita pela factory:

- Meta/WhatsApp ou Instagram: `config.graph_url`; exige
  `access_token_secret_ref` e, para inbound, endpoint + assinatura.
- Brevo/e-mail: `config.api_url`, `sender_email` e `sender_name`; exige
  `api_key_secret_ref`.
- SMTP/e-mail: `config.host`, `port`, `sender_email`, `sender_name`, `starttls`
  e `ssl`; usuário e senha ficam nas colunas de referência ao cofre.

O provisionamento termina com o agente em `provisioned`, fora do scheduler.
Depois de cadastrar ao menos uma conta ativa e materializar os arquivos do
cofre com permissão privada, ative-o explicitamente:

    SELECT public.sac_activate_agent('cliente', 'agente');

A função recusa ativação sem Hermes e sem conta ativa. A factory também falha
fechado para provider/canal desconhecido ou referência ausente. No status do
CLI, `ready` significa estrutura íntegra; `operational_ready` acrescenta
configuração do Hermes e pelo menos uma conta ativa.

Não há rollback automático destrutivo: cada schema contém dados de clientes e
só pode ser removido após exportação, retenção e autorização explícita. O
registro `public.sac_schema_migrations` permite evoluções futuras por agente.

## Entrega e idempotência

O outbox separa três classes sem competição entre workers:
`message.received`, `outbound.send` e os demais tópicos internos de CRM/domínio.
Os tópicos internos passam por um publisher injetável com lease, ACK, retry e
DLQ. Sem publisher externo configurado, o sink local padrão apenas confirma a
cópia do outbox: o evento original continua preservado, de forma append-only,
em `sac_domain_events`. Portanto não há envio de dados para fora por padrão.

O envio a Meta, Brevo ou SMTP oferece semântica **at-least-once**, não
exactly-once. Se o provedor aceitar a mensagem e o processo cair antes do ACK,
o lease expira e a tentativa pode ser repetida. A mitigação é manter a chave
idempotente do outbox por mensagem, configurar leases acima do timeout do
provedor e, quando o conector/provedor suportar, encaminhar a mesma chave como
idempotency key. Para canais sem deduplicação do provedor, duplicidade residual
deve ser tratada como possibilidade operacional e monitorada pelos contadores
de retry/DLQ.

## Validação

    python3 validate_sac_v2.py
    python3 -m unittest tests.test_sac_v2_migration -v
    python3 -m unittest tests.test_sac_provisioner -v

Além disso, a migration foi executada em PostgreSQL 16 descartável, incluindo
provisionamento, propriedade das 17 tabelas/sequência/funções pela role owner,
bloqueio de segredo em JSON, ativação controlada, isolamento de tenant,
permissões da role app e os ciclos de ACK, retry e DLQ. Nenhuma escrita foi
feita no banco real.
