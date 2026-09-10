# Base Hermes multicanal

## SAC multiagente v2

A versão vendável e compartilhada está implementada separadamente da
homologação SQLite descrita abaixo. Ela usa PostgreSQL, resolve cada agente pelo
control plane e mantém um schema/role exclusivos por agente. Não confia em
`tenant_id` vindo de webhook e não guarda segredos no banco.

Arquivos de entrada:

- `002_sac_multiagent_v2.sql` e `002_sac_roles.psql`: control plane e 17
  tabelas autocontidas por agente;
- `backend/runtime_v2.py`: servidor, readiness e worker multiagente;
- `backend/postgres_store.py`: persistência tenant-bound, outbox, lease,
  retentativa e dead-letter;
- `backend/sac_provisioner.py` e `scripts/provision-sac-v2.py`:
  provisionamento idempotente;
- `Dockerfile.v2`, `compose.v2.yaml` e `RUNBOOK-v2.md`: execução operacional.

A migration e o provisionamento foram executados em PostgreSQL 16 descartável;
o pacote passou por 125 testes da aplicação, 6 testes legados dos workers,
validação das duas migrations, compilação e build/import da imagem como usuário
não-root. Nada foi aplicado no banco real. Para ativação, siga
`SAC-V2-POSTGRES.md` e `RUNBOOK-v2.md`.

Kit isolado de produção para preparar um cliente com atendimento por WhatsApp
Cloud API, Instagram Direct e e-mail. Não contém chaves reais e não executa
migration nem chamada externa.

## O que está pronto

- `multicanal/core.py`: envelope normalizado, identidade por canal e dedupe.
- `envelope.schema.json`: contrato do evento normalizado.
- `adapters.py`: assinatura e challenge Meta, segredo compartilhado e dedupe.
- `.env.example` e `config.example.json`: parâmetros sem credenciais reais.
- `.env.isabella.example` e `config.isabella.json`: ativos não secretos já
  identificados da Isabella; campos não confirmados continuam vazios/desativados.
- `healthcheck.py`: checagem offline que mostra apenas estado, nunca valores.
- `migration_multicanal.sql`: migration aditiva parametrizada por `<schema>`.
- `001_multicanal_down.sql`: rollback das estruturas novas.
- `MIGRATION_MULTICANAL.md`: ordem de revisão e aplicação da migration.
- `README-integracoes.md`: endpoints, variáveis e critérios de aceite dos canais.
- `backend/app.py`: webhooks HTTP assinados para Meta e e-mail neutro
  (`/webhooks/email`; `/webhooks/brevo` é alias legado).
- `backend/store.py`: persistência SQLite transacional, contatos, conversas,
  pipeline, deduplicação e outbox durável.
- `backend/service.py`: workers separados para Hermes e entrega nos canais;
  o webhook confirma logo após persistir.
- `backend/connectors.py`: conectores de saída Meta, Brevo, SMTP e cliente Hermes,
  todos em dry-run automático enquanto faltarem credenciais.
- `backend/imap_inbound.py`: coleta IMAP com SSL/STARTTLS, persistindo antes de
  marcar a mensagem como lida.
- `backend/cli.py`: composition root para executar servidor HTTP, workers do
  Hermes/saída e coletor IMAP como processos separados, com encerramento por
  SIGTERM/SIGINT.

Canal de conversa e origem de aquisição são campos diferentes. Identidades de
canais distintos nunca são unidas por nome; o vínculo entre elas precisa de
evidência explícita e auditável.

## Validação local

Execute nesta pasta:

```sh
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s backend -p 'test*.py' -v
python3 validate_migration.py
python3 healthcheck.py --json
```

## Execução local isolada

Copie os nomes necessários de `.env.isabella.example` para o ambiente do
processo. O CLI não lê arquivo `.env` automaticamente, para não misturar
credenciais de clientes. Durante homologação mantenha `DRY_RUN=true`.

Execute em três terminais, a partir desta pasta:

```sh
python3 -m backend.cli server
python3 -m backend.cli worker-inbound
python3 -m backend.cli worker-outbound
# quando a entrada de e-mail for IMAP:
python3 -m backend.cli worker-email-imap
```

O servidor escuta em `127.0.0.1:8080` por padrão. O primeiro worker consome os
eventos persistidos, entrega o contexto ao Hermes e grava a decisão no CRM. O
segundo entrega as respostas ao canal. Ambos encerram de modo gracioso com
SIGTERM ou Ctrl+C.

## Homologação executável e painel provisório

`compose.homologacao.yaml` sobe um PostgreSQL 16 exclusivo e o gateway v2 em
`127.0.0.1:8188`. A inicialização provisiona cinco clientes em schemas e roles
separados, sem tocar no PostgreSQL, no frontend ou nos agentes em produção. O
worker e a entrega externa ficam ausentes de propósito.

O painel em `painel/` não simula mais atendimento. Ele lê duas fontes:

- **gateway SAC v2** (`/api/v1/panel/...`): agentes, conversas, mensagens,
  pipeline e origens vindos do PostgreSQL, com sessão de operador e escrita
  auditada;
- **exportação do piloto AutonomIA** (`painel/autonomia.json`): somente leitura,
  sem sessão e sem nenhum controle de escrita.

O `localStorage` guarda apenas preferência de navegação (fonte, canal e origem
selecionadas). Se o gateway cair, o painel avisa em destaque e para: nenhuma
conversa é preenchida por simulação.

Na VPS, `scripts/publicar-painel-homologacao.sh` publica os arquivos estáticos
como uma pasta isolada do painel já protegido, sem reconstruir nem reiniciar o
frontend principal: `https://painel.casaldotrafego.com/sac/`. A API do painel
precisa de um bloco `location /sac/api/` no nginx; ele está pronto e revisável
em `homologacao/painel-sac-api.nginx.conf` e **não** foi aplicado.

### API do painel e identidade do operador

`backend/panel_api.py` publica, sob `/api/v1/panel`, sessão (`POST/GET/DELETE
/session`), leitura (`/agents`, `/agents/<tenant>/<agente>/conversations`,
`.../conversations/<id>/messages`, `.../pipeline`, `.../origins`, `.../audit`) e
três escritas (`.../contacts/<id>/stage`, `.../conversations/<id>/notes`,
`.../conversations/<id>/assignment`).

Regras que o código garante e os testes cobrem:

- o par tenant/agente do caminho só vale se a sessão o autorizar; o
  `schema_name` sai sempre de `public.sac_agents`, nunca do pedido HTTP;
- nenhuma consulta seleciona coluna `*_secret_ref`, e nenhuma resposta carrega
  hash, token ou senha;
- escrita exige sessão, permissão de escrita no agente e o cabeçalho
  `X-SAC-Panel-CSRF`; cada uma grava em `sac_audit_log` com operador, momento e
  valor antes/depois, na mesma transação;
- **escrita do painel nunca toca `sac_outbox`**: não existe caminho daqui para
  envio externo.

O cadastro de operadores mora no cofre (`SECRET_DIR`), guarda apenas hash
PBKDF2-SHA256 e é relido a cada login. Gere uma entrada com
`scripts/painel-operador.py` (a senha nunca aparece na linha de comando nem na
saída). Sem `PANEL_OPERATORS_REF` o painel responde 503 — ele falha fechado.

Para exercitar o conjunto localmente, com a mesma topologia de `/sac/` (página e
API na mesma origem):

```sh
python3 scripts/painel-dev-proxy.py --port 8190 &
NODE_PATH=$(npm root -g) node tests/panel_autonomia_e2e.cjs
PANEL_OPERATOR=gastao PANEL_PASSWORD=... node tests/panel_backend_e2e.cjs
```

```sh
docker compose -p sac-homologacao -f compose.homologacao.yaml up -d --build
curl --fail http://127.0.0.1:8188/livez
curl --fail http://127.0.0.1:8188/readyz
```

Sem `HERMES_API_KEY`, os tokens Meta ou as credenciais completas de e-mail, o
respectivo cliente entra automaticamente em dry-run. `DRY_RUN=true` prevalece
sobre todas as chaves. A saída de e-mail aceita `EMAIL_PROVIDER=brevo` ou
`EMAIL_PROVIDER=smtp`. A entrada aceita webhook assinado ou IMAP; para iniciar o
coletor IMAP no Compose, defina as variáveis `EMAIL_IMAP_*` e use
`COMPOSE_PROFILES=imap`. Segredos vazios também fazem os webhooks rejeitarem as
requisições, em vez de aceitá-las sem assinatura.

O health check retorna falha enquanto as credenciais estiverem ausentes. Isso é
esperado neste kit e permite saber exatamente o que falta antes da ativação.

## Subida com Docker Compose

O pacote executa servidor, worker de entrada e worker de saída em processos
independentes, compartilhando somente o volume durável do SQLite. A conexão usa
WAL e `busy_timeout`, apropriados para esta instalação pequena de processo único
por função.

```sh
cp .env.isabella.example .env.isabella
# preencher .env.isabella sem versioná-lo
docker compose build
docker compose up -d
docker compose ps
curl --fail http://127.0.0.1:8080/health
```

O Compose define `STRICT_CONFIG=true`. Assim, com `DRY_RUN=false`, qualquer
segredo ou conector obrigatório ausente impede os processos de iniciar e informa
apenas o nome da variável ausente. Enquanto `DRY_RUN=true`, o conjunto sobe para
homologação sem fazer chamadas externas. A porta fica publicada apenas no
loopback do host; o proxy HTTPS deve encaminhar os webhooks para ela.

Antes de cada entrega, execute `./scripts/check.sh`. Para backup consistente com
os processos ativos, use:

```sh
mkdir -p backups
./scripts/backup-sqlite.sh var/isabella-multicanal.sqlite3 backups
```

No Docker, obtenha o caminho do volume com `docker volume inspect`; não copie o
arquivo SQLite diretamente enquanto os workers estiverem ativos. Restauração é
uma operação manual: pare os três serviços, preserve o volume atual, restaure o
backup e só então inicie novamente.

Para ativar, altere `DRY_RUN=false`, preencha todas as variáveis indicadas no
arquivo de exemplo e rode `docker compose up -d`. Depois configure no provedor:

- Meta callback: `https://HOST/webhooks/meta`, usando `META_VERIFY_TOKEN`;
- e-mail callback: `https://HOST/webhooks/email`, usando o cabeçalho definido em
  `EMAIL_SIGNATURE_HEADER`;
- monitoramento: `GET /health` deve responder HTTP 200.

Os logs vão para stdout/stderr e podem ser lidos com
`docker compose logs --tail=200 server worker-inbound worker-outbound`. Não há
segredos gravados na imagem; `.env.isabella` é excluído do contexto de build.

## O que falta para ativar uma cliente

1. Preencher conta do Instagram, App/WABA/número do WhatsApp e a caixa/provedor
   de e-mail real. Para Isabella, veja `EMAIL-ISABELLA.md`.
2. Revisar a migration substituindo `<schema>` e aplicá-la primeiro em
   homologação.
3. Homologar um contato real por canal, replay, restart, timeout e movimentação
   automática sem regressão.

Os adaptadores e o backend estão implementados em homologação. A integração ainda
não está ativa em produção: faltam credenciais, provisionamento e testes reais dos
três canais.
