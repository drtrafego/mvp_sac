# SAC multi-tenant v2

O runtime v2 é separado da homologação SQLite. Ele não altera nem substitui
`backend.cli`, `compose.yaml` ou o banco legado.

## Pré-requisitos

- PostgreSQL 15+ com `002_sac_multiagent_v2.sql` aplicado e cada agente
  provisionado pela função da migration. Para preparar um banco novo do zero,
  veja "Ativação do banco novo" logo abaixo.
- Python 3.12 ou Docker Compose v2.
- TLS até o PostgreSQL e autenticação sem senha na variável de ambiente
  (certificado/identidade da plataforma recomendado).
- diretório de segredos montado somente para leitura. Cada `secret_ref` é um
  caminho relativo, sem `..` nem symlinks, para arquivo `chmod 600`, pertencente
  ao UID 10001 usado pelo contêiner.

## Ativação do banco novo: um comando, dois destinos

Os agentes continuam no Supabase existente, que é intocável. O SAC v2 e as
demais integrações vão para um **banco novo** — Neon ou um **segundo** projeto
Supabase. `scripts/preparar-banco-sac.py` serve aos dois sem retrabalho.

A connection string nunca vai na linha de comando: apareceria em `ps`, no
histórico do shell e no log do supervisor. Passe o **nome** da variável.

```sh
export SAC_DATABASE_URL='postgresql://...'   # cole a credencial aqui, uma vez
```

As três roles do SAC precisam existir antes; o script não cria role nem define
senha, de propósito. Uma vez por banco, com a role administrativa do provedor:

```sql
CREATE ROLE sac_owner  NOLOGIN;
CREATE ROLE sac_app    LOGIN PASSWORD '<gerada pelo cofre>';
CREATE ROLE sac_worker LOGIN PASSWORD '<gerada pelo cofre>';
CREATE ROLE sac_deployer NOLOGIN;           -- opcional, só para o --deployer-role
GRANT sac_owner, sac_app, sac_worker TO CURRENT_USER;  -- para poder dar OWNER a elas
```

O `GRANT ... TO CURRENT_USER` não é decoração: `sac_provision_agent` faz
`CREATE SCHEMA ... AUTHORIZATION sac_owner` e `ALTER TABLE ... OWNER TO`, e o
PostgreSQL exige que quem executa seja membro da role de destino.

Antes de qualquer coisa, rode sem `--aplicar`. Não abre transação de escrita e
imprime o mesmo relatório:

```sh
python3 scripts/preparar-banco-sac.py --destino neon --roles-sac sac_owner,sac_app,sac_worker
```

### Destino Neon

```sh
SAC_DATABASE_URL='postgresql://...' python3 scripts/preparar-banco-sac.py \
  --destino neon --aplicar \
  --deployer-role sac_deployer \
  --roles-sac sac_owner,sac_app,sac_worker
```

Fim. O Neon não tem PostgREST: o control plane só é alcançável por conexão
PostgreSQL autenticada, e `scripts/supabase-endurecer.sql` não se aplica.

### Destino Supabase (projeto NOVO, nunca o dos agentes)

```sh
SAC_DATABASE_URL='postgresql://...' python3 scripts/preparar-banco-sac.py \
  --destino supabase --aplicar \
  --deployer-role sac_deployer \
  --roles-sac sac_owner,sac_app,sac_worker
```

O comando termina em **código 3** de propósito, apontando os grants que a chave
`anon` herda por padrão. Só depois de dois passos manuais o banco fica pronto:

1. revisar e aplicar o endurecimento, que **não** é automático:

   ```sh
   psql -v ON_ERROR_STOP=1 "$SAC_DATABASE_URL" -f scripts/supabase-endurecer.sql
   ```

2. no painel do projeto novo, `Settings > API > Exposed schemas`, remover
   `public`. Isso não existe em SQL: é configuração do PostgREST guardada fora
   do banco.

Depois, rodar o comando de novo deve terminar em código 0 com
`grants expostos: nenhum`.

### O que o script faz e o que ele não faz

Ordem fixa: pré-requisitos → `002_sac_multiagent_v2.sql` → os GRANT de
`002_sac_roles.psql` → verificação → relatório. Reexecutar é seguro: a migration
é `CREATE ... IF NOT EXISTS` + `CREATE OR REPLACE FUNCTION`.

Ele **recusa antes de escrever qualquer coisa** se a role conectada não tiver
CREATEROLE (nem herdar de quem tenha), se o servidor for anterior ao
PostgreSQL 15, se faltar CREATE no banco, se já houver tabela homônima sem as
colunas desta migration, se o control plane estiver pela metade ou se algum
objeto pertencer a uma role fora do alcance de quem conectou. Meia migration é
pior que nenhuma.

Ele **não** cria role, **não** define senha, **não** provisiona agente, **não**
aplica o endurecimento do Supabase e **não** mexe em *Exposed schemas*. Crie
`sac_owner`, `sac_app` e `sac_worker` antes, pela política de senha do ambiente;
o relatório avisa quais ainda faltam. O provisionamento de cada agente continua
sendo `scripts/provision-sac-v2.py`, como em `SAC-V2-POSTGRES.md`.

Códigos de saída: `0` pronto, `1` falha operacional, `2` recusa de
pré-requisito (nada foi escrito), `3` aplicou mas a verificação reprovou.

Se a credencial vier por pooler transacional (porta 6543, host com `pooler.`,
ou `pgbouncer=true`), o script desliga prepared statements sozinho, igual ao
`runtime_v2`.

## Contrato do control plane

`sac_agents.runtime_config` contém apenas dados públicos:

```json
{"hermes":{"base_url":"https://hermes.example.com","model":"Hermes"}}
```

A chave fica em `sac_agents.hermes_api_key_secret_ref`.

Em `sac_channel_accounts`, `config` também contém somente dados públicos:

- Meta: `graph_url` opcional; token em `access_token_secret_ref`.
- Brevo: `sender_email`, `sender_name` e `api_url`; chave em
  `api_key_secret_ref`.
- SMTP: `host`, `port`, `sender_email`, `sender_name`, `starttls`, `ssl`;
  usuário e senha em `smtp_username_secret_ref` e
  `smtp_password_secret_ref`.

Segredos de entrada permanecem em `signature_secret_ref` e
`verify_secret_ref`. O endpoint público é `public_endpoint_id`. Nenhum desses
campos aceita o valor de tenant enviado pelo webhook.

## Preparação e validação

```sh
cp .env.v2.example .env.v2
chmod 600 .env.v2
docker compose -f compose.v2.yaml build
docker compose -f compose.v2.yaml run --rm sac-server \
  python -m backend.runtime_v2 check
```

O `check` retorna diferente de zero se o banco/tabelas não estiverem prontos,
se não houver agente ativo, se faltar configuração pública, se uma referência
não resolver ou se houver provedor ativo sem conector suportado. Ele não chama
Hermes, Meta, Brevo nem SMTP.

O padrão `READINESS_MODE=production` mantém essa verificação completa. Somente
a composição isolada `compose.homologacao.yaml` usa `READINESS_MODE=database`,
pois ela valida o control plane e os schemas sem fingir que canais externos
foram ativados. Esse modo não deve ser usado no Compose de produção.

## Painel do operador

O mesmo processo `server` publica a API do painel em `/api/v1/panel`. Ela fica
desligada até existir cadastro de operadores no cofre:

- `PANEL_OPERATORS_REF`: caminho relativo dentro de `SECRET_DIR` (por exemplo
  `painel/operadores.json`), arquivo regular, sem symlink, `chmod 600` e do UID
  usado pelo contêiner. Conteúdo: `{"operators":[{"id","displayName",
  "passwordHash","agents":[{"tenantId","agentId","write"}]}]}`. Só hash de
  senha, nunca a senha, nunca token.
- `PANEL_COOKIE_SECURE`: mantenha `true` em produção; só a homologação em
  loopback usa `false`.
- `PANEL_COOKIE_PATH`: prefixo por onde o navegador enxerga o painel (`/sac/`).
- `PANEL_SESSION_TTL_SECONDS` e `PANEL_SESSION_IDLE_SECONDS`: janela da sessão.

Sem `PANEL_OPERATORS_REF` a API responde 503 em tudo: ela falha fechada, nunca
abre por omissão. As sessões vivem apenas na memória do processo, então
reiniciar o server desloga todo mundo de propósito. Revogar um operador é
editar o cadastro no cofre: o arquivo é relido a cada login, sem reinício.

Escrita exige sessão, permissão de escrita no agente e o cabeçalho
`X-SAC-Panel-CSRF`, grava a trilha em `sac_audit_log` na mesma transação e não
enfileira nada em `sac_outbox`. Publique a API na mesma origem da página, sob o
prefixo do painel; o bloco nginx revisável está em
`homologacao/painel-sac-api.nginx.conf`. Não exponha `/webhooks/v2/`, `/livez`
ou `/readyz` por esse caminho.

## Analytics do painel

O mesmo processo `server` publica os relatórios agregados em
`/api/v1/panel/agents/<tenant>/<agente>/analytics/...`. São **sete relatórios,
todos GET e todos somente leitura**:

| Rota | O que responde |
| --- | --- |
| `analytics` | índice: janela resolvida e lista de relatórios (não toca o banco) |
| `analytics/overview` | volume, contatos únicos, novas × recorrentes, série diária, delta |
| `analytics/channels` | as mesmas métricas por WhatsApp, Instagram e e-mail, com participação |
| `analytics/origins` | aquisição por origem (`sac_origins`), agregada pelo slug de `origins.py` |
| `analytics/pipeline` | estoque, entradas/saídas, conversão e permanência por etapa |
| `analytics/response-times` | primeira resposta e resolução, com média, mediana e p90 |
| `analytics/health` | pendência em `sac_outbox`, DLQ, tentativas e idade do item mais velho |
| `analytics/operators` | ações por operador a partir de `sac_audit_log` |

Autorização é idêntica à do resto do painel: sessão obrigatória, tenant
resolvido no control plane, agente não autorizado responde **404** e a loja nem
chega a ser aberta.

### Janela de tempo

- `?periodo=` aceita `1d`, `7d`, `14d`, `30d`, `60d`, `90d`, `180d`, `365d`.
  O padrão, sem parâmetro nenhum, é **30d**.
- `?de=YYYY-MM-DD&ate=YYYY-MM-DD` são **dias locais inclusivos**. Não combine
  com `periodo`: a resposta é 400.
- Teto absoluto de **366 dias** (`PANEL_ANALYTICS_MAX_DAYS` só abaixa). Janela
  maior, data inválida, período desconhecido ou intervalo invertido devolvem
  `400 {"error":"invalid_window","maxDays":366}`. Não existe caminho em que o
  cliente peça uma varredura completa da base.
- Toda resposta ecoa `window`, incluindo `previous`, os instantes UTC
  (`startsAt` inclusivo, `endsAt` exclusivo) e o fuso usado.

### Fuso horário

A agregação diária sai no fuso do cliente, não em UTC — uma mensagem das 23h de
Brasília pertence ao dia local, não ao dia seguinte. O padrão é
`America/Sao_Paulo`, configurável por `PANEL_ANALYTICS_TZ` e sobreponível por
pedido com `?fuso=`. Fuso desconhecido é 400; fuso inválido na configuração
falha no arranque do processo, não no primeiro pedido do cliente.

### Cache e limite de custo

- `PANEL_ANALYTICS_CACHE_SECONDS` (padrão **60**, 1..3600): validade do cache em
  memória, por `(tenant, agente, relatório, de, ate, fuso)`. A resposta traz
  `cache: {"hit":bool,"ttlSeconds":int}` e `generatedAt` do cálculo.
- Cache é do processo: reiniciar o server esvazia, e nada vai para disco.
- Só o cache não basta, porque variar `de`/`ate` erra o cache de propósito. Há
  um orçamento de **30 cálculos novos por agente por minuto**; ao estourar, a
  rota devolve `429 {"error":"analytics_busy"}` em vez de mais uma consulta.

### Garantias

Nenhum relatório escreve: o cursor de analytics termina sempre em `rollback` e
nenhuma consulta usa `INSERT`, `UPDATE`, `DELETE` ou `FOR UPDATE`. `sac_outbox`
é apenas contada. Nenhuma resposta carrega `*_secret_ref`, token, corpo de
mensagem, `last_error` de outbox/DLQ, telefone ou e-mail: rótulo de origem
passa por máscara antes de sair, e a trilha de auditoria devolve contagem por
ação, nunca o `data` da ação.

Duas aproximações merecem ser conhecidas antes de interpretar o número:

- **Resolução** usa `sac_threads.updated_at` para recortar a janela e mede da
  primeira à última mensagem da conversa fechada. Não existe coluna `closed_at`
  no schema; `updated_at` é mantido por gatilho e equivale ao último toque.
- **Permanência por etapa** só conta intervalo fechado (etapa da qual o contato
  já saiu, por `sac_pipeline_history`). Quem ainda está parado na etapa fica de
  fora, para a média não virar um número que só cresce.

### Índices em agente já provisionado

Os índices de analytics são aditivos e idempotentes. Agente novo já nasce com
eles. Para um agente instalado antes desta versão, reaplique a migration
(`CREATE OR REPLACE`, seguro de repetir) e depois rode, uma vez por agente:

```sql
SELECT public.sac_apply_analytics_indexes('cliente', 'agente');
```

A função valida tenant/agente, resolve `schema_name` no control plane, serializa
com advisory lock, executa só `CREATE INDEX IF NOT EXISTS` e registra a versão
`002.1` em `public.sac_schema_migrations`. Reexecutar é no-op. Ela não cria,
altera nem remove tabela, coluna ou dado. Em base grande, considere rodar as
mesmas criações com `CREATE INDEX CONCURRENTLY` fora de transação: a função usa
a forma bloqueante, adequada a agente novo ou a janela de manutenção.

## Execução

```sh
docker compose -f compose.v2.yaml up -d
curl --fail http://127.0.0.1:8080/livez
curl --fail http://127.0.0.1:8080/readyz
```

Publique apenas o server atrás de proxy HTTPS. O worker não expõe porta. Cada
webhook usa `https://sac.example.com/webhooks/v2/<public_endpoint_id>`.

Para interromper sem perder leases:

```sh
docker compose -f compose.v2.yaml stop
```

Jobs interrompidos voltam a ficar elegíveis quando o lease expira. Falhas são
retentadas até o limite do store e depois seguem para dead-letter.
