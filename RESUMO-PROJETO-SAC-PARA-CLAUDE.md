# Projeto SAC multiagente — contexto para continuar o código

Data do handoff: 10/09/2026

## Objetivo do produto

Construir um SAC multicanal compartilhado para os agentes Hermes. WhatsApp
Cloud API, Instagram Direct e e-mail entram no mesmo atendimento e pipeline,
mantendo canal e origem de aquisição separados. Cada cliente/agente precisa ter
isolamento real de dados, credenciais e processamento.

Diretório principal:

`/opt/gastaomatos/renato/operacao/multicanal/`

O agente será iniciado em `/root`. Não procure o projeto ali e não crie uma
cópia. A primeira ação deve ser:

```bash
cd /opt/gastaomatos/renato/operacao/multicanal
```

Painel publicado:

`https://painel.casaldotrafego.com/sac/`

## Estado atual

- A arquitetura vendável é a v2 com PostgreSQL central como control plane e um
  schema mais uma role exclusivos por agente.
- A migration cria 17 tabelas por agente, com isolamento por tenant/agente,
  outbox, lease, retry, dead-letter, auditoria e eventos de domínio.
- A homologação executável provisionou cinco agentes: cinco schemas e 85
  tabelas. Gateway saudável em `127.0.0.1:8188`.
- O painel em `/sac/` está publicado atrás da autenticação existente. A parte
  genérica agora lê e escreve no gateway v2 com sessão de operador e auditoria;
  nenhuma escrita do painel enfileira envio externo. Os arquivos estáticos
  publicados ainda são a versão anterior: republicar exige autorização.
- O piloto AutonomIA exibe dados reais sanitizados, somente leitura, por uma API
  separada em `127.0.0.1:8189`. POST é bloqueado com 405.
- Snapshot validado do AutonomIA: 3.980 contatos abordados, 3.753 conversas e
  12.157 mensagens. O pool bruto de 42.306 linhas fica separado e não entra no
  SAC antes da abordagem.
- WhatsApp, Instagram e e-mail reais continuam desativados no SAC. Nenhum envio
  externo deve ser ligado por inferência.
- O primeiro agente desta evolução já está decidido: **AutonomIA**. Não pedir
  novamente qual cliente/agente será usado e não criar outro piloto.
- Existe configuração sem segredo para Isabella Franklin/Bella, mas ativação
  real depende das contas e credenciais corretas da cliente, callbacks públicos
  e homologação ponta a ponta. O domínio dela estava sem MX na última checagem.
- A base v2 passou por 125 testes da aplicação, seis testes legados dos workers,
  migration real em PostgreSQL 16 descartável e build da imagem como usuário
  não-root.

## Arquivos que são fonte da verdade

- `/opt/gastaomatos/renato/operacao/multicanal/README.md`: mapa geral e
  diferença entre legado SQLite, homologação e v2.
- `/opt/gastaomatos/renato/operacao/multicanal/SAC-V2-POSTGRES.md`: modelo de
  dados, isolamento e provisionamento.
- `/opt/gastaomatos/renato/operacao/multicanal/RUNBOOK-v2.md`: configuração,
  readiness e operação.
- `/opt/gastaomatos/renato/operacao/multicanal/README-integracoes.md`: contratos
  de WhatsApp, Instagram e e-mail.
- `/opt/gastaomatos/renato/operacao/multicanal/002_sac_multiagent_v2.sql`:
  control plane e data plane por agente.
- `/opt/gastaomatos/renato/operacao/multicanal/backend/runtime_v2.py`: servidor
  e runtime multiagente.
- `/opt/gastaomatos/renato/operacao/multicanal/backend/postgres_store.py`:
  persistência tenant-bound, outbox e filas.
- `/opt/gastaomatos/renato/operacao/multicanal/backend/sac_provisioner.py`:
  provisionamento idempotente.
- `/opt/gastaomatos/renato/operacao/multicanal/backend/multitenant_app.py` e
  `/opt/gastaomatos/renato/operacao/multicanal/backend/multitenant_service.py`:
  gateway e serviço multi-tenant.
- `/opt/gastaomatos/renato/operacao/multicanal/backend/autonomia_readonly.py` e
  `/opt/gastaomatos/renato/operacao/multicanal/backend/autonomia_snapshot.py`:
  piloto real somente leitura.
- `/opt/gastaomatos/renato/operacao/multicanal/compose.homologacao.yaml`:
  ambiente isolado que está em homologação.
- `/opt/gastaomatos/renato/operacao/multicanal/compose.v2.yaml` e
  `/opt/gastaomatos/renato/operacao/multicanal/Dockerfile.v2`: pacote destinado
  à produção.
- `/opt/gastaomatos/renato/operacao/multicanal/painel/`: frontend publicado.
- `/opt/gastaomatos/renato/operacao/multicanal/tests/`: regressões e testes de
  integração.

## Invariantes que não podem ser quebradas

1. Nunca confiar em `tenant_id` recebido de webhook. Resolver o agente por
   endpoint público opaco e cadastro do control plane.
2. Nunca guardar token, senha ou chave nos JSONs públicos ou no banco; somente
   referências para o cofre. Não imprimir segredos em logs ou health checks.
3. Não unir identidades de WhatsApp, Instagram e e-mail por nome. União exige
   evidência explícita e auditável.
4. Persistir antes de responder 2xx e deduplicar por canal mais ID externo.
5. Manter workers separados por tópico, lease, ACK, retry e DLQ.
6. `DRY_RUN=true` prevalece sobre qualquer credencial. Produção deve falhar
   fechada quando falta configuração.
7. Não tocar nos agentes atuais, callbacks reais ou banco de produção sem ordem
   explícita. Não enviar mensagens de teste para contatos reais.
8. O piloto AutonomIA é somente leitura. Lead bruto só entra no SAC depois de
   ser abordado.
9. O caminho v2/PostgreSQL é o produto. Não ampliar o SQLite legado como se ele
   fosse a arquitetura final.

## O que ainda falta para virar produção

- Evoluir primeiro o agente AutonomIA; essa escolha já foi feita pelo Gastão.
- Materializar segredos em cofre/diretório privado, com rotação e escopo mínimo.
- Publicar endpoint HTTPS de webhook e configurar callbacks/assinaturas Meta e
  e-mail.
- Homologar entrada, resposta, dedupe, reinício, timeout, retry/DLQ e avanço de
  pipeline em contas sandbox antes de qualquer contato real.
- ~~Ligar o painel genérico ao backend real~~: feito. O painel lê agentes,
  conversas, mensagens, pipeline e origens do gateway v2 e usa `localStorage`
  apenas para preferência de navegação. Com o gateway fora do ar ele avisa e
  para, sem simular.
- ~~Definir autenticação/autorização por operador e trilha de auditoria das
  ações de escrita no painel~~: feito. Sessão server-side com cadastro no cofre
  (`PANEL_OPERATORS_REF`), permissão de escrita por agente, CSRF e registro em
  `sac_audit_log` com valor antes/depois. Falta publicar o `location /sac/api/`
  no nginx (bloco pronto em `homologacao/painel-sac-api.nginx.conf`).
- Escolher o destino do publisher de eventos internos; o padrão atual apenas
  confirma a cópia local do outbox.
- Migrar e rotacionar credenciais que ainda estejam embutidas no despachador do
  AutonomIA antes de ampliar acesso.
- O DNS `sac.casaldotrafego.com` é opcional enquanto `/sac/` atende, mas pode ser
  criado quando houver decisão de endereço definitivo.

## Próxima implementação solicitada pelo Gastão

Implementar no AutonomIA entrada de contatos por dois caminhos:

1. **Planilha:** importar CSV e XLSX com prévia antes da confirmação, mapeamento
   de colunas, normalização de nome/telefone/e-mail, origem e campanha,
   deduplicação, idempotência e relatório de inseridos, atualizados, repetidos e
   rejeitados por linha. A interface deve ficar no painel `/sac/` e a gravação
   deve passar pelo backend v2, nunca somente por `localStorage`.
2. **Webhook de plataformas:** criar entrada extensível e autenticada para
   empresas como Hotmart e Kiwify. Resolver o agente por endpoint opaco, validar
   a assinatura conforme a documentação oficial de cada provedor, deduplicar
   pelo ID externo do evento, aceitar replay com segurança e mapear contato,
   produto/oferta, status, origem de aquisição e campanha sem guardar payload
   bruto nos logs.

Não criar uma integração rígida que só aceite Hotmart/Kiwify: separar contrato
normalizado e adapters por provedor. Segredos ficam apenas em referências ao
cofre. Callback real e envio externo continuam desligados até autorização.

A regra do AutonomIA continua valendo: base bruta de mineração fica separada e
só entra no SAC depois da abordagem. Importação de compradores/leads de
plataformas deve registrar claramente origem, evento e política de entrada; não
misturar silenciosamente esses contatos com o pool bruto de mineração.

Critério de pronto desta frente:

- upload com prévia, confirmação e relatório de erros funciona no painel;
- reimportar a mesma planilha não duplica contatos;
- evento de webhook repetido três vezes produz um único efeito;
- assinatura ausente ou inválida retorna erro sem gravar;
- Hotmart e Kiwify têm fixtures e testes offline representativos;
- contatos aparecem no agente AutonomIA com canal/origem/campanha corretos;
- isolamento entre agentes, auditoria, retry/DLQ e testes existentes permanecem
  verdes;
- nenhuma chamada, callback ou mensagem real é disparada durante os testes.

## Como começar sem refazer trabalho

1. Ler os quatro documentos-fonte acima e inspecionar o estado atual antes de
   editar.
2. Começar pela importação de contatos por planilha e webhook no AutonomIA,
   seguindo o escopo e os critérios acima.
3. Rodar a suíte existente antes e depois da mudança.
4. Manter homologação isolada e canais em dry-run até existir autorização
   explícita para ativação.
5. Entregar uma fatia testável com endereço, autenticação, dados representativos
   e fluxo principal validado. Teste unitário verde sozinho não significa
   sistema pronto.

Comandos de validação local:

```bash
cd /opt/gastaomatos/renato/operacao/multicanal
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s backend -p 'test*.py' -v
python3 validate_migration.py
python3 validate_sac_v2.py
docker compose -p sac-homologacao -f compose.homologacao.yaml ps
curl --fail http://127.0.0.1:8188/livez
curl --fail http://127.0.0.1:8188/readyz
```

Importante: preserve mudanças existentes no diretório. Antes de alterar um
arquivo, verifique o diff e não apague trabalho de outro agente.
