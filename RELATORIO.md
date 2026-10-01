# Relatório — horários, bloqueios e follow-up

Branch de trabalho: `feat/items123-horarios-bloqueios-followup`  
Data da investigação: 2026-10-01  
Base: `main` em `ec45d20`, incorporando também o endurecimento ainda não
mergeado de `9c923f3`/`6e31743`.

Nenhuma alteração foi promovida para produção, para `main` ou para o Gramado.
Os únicos writes reais feitos durante os testes foram no Dr. Lucas, com valores
inócuos, restauração no `finally` e releitura final.

## ITEM 1 — Horários gerais e específicos usados pelo bot

### Confirmado com prova real — Dr. Lucas

- O horário geral existe, suporta várias faixas por dia e é a grade usada pelo
  runtime do Hermes. A Control API real e `/opt/data/agenda_config.json` dentro
  do container `hermes2_drlucas` devolveram o mesmo conteúdo: domingo/sábado
  fechados; segunda a quinta `08:00–11:45`; sexta `08:00–12:30`; slot de 15
  minutos; timezone `-03:00`.
- Foi criada uma rota HTTP temporária somente de diagnóstico dentro do container,
  ligada apenas em `127.0.0.1:18765`, sem editar arquivo e sem reiniciar serviço.
  Ela importou o `agenda_tools.py` ativo e executou
  `dentro_do_horario_de_atendimento()` no próprio processo do runtime:
  segunda `08:00–08:15` retornou permitido; segunda `12:00–12:15` retornou
  `fora_da_faixa_de_atendimento`; sábado retornou `dia_sem_atendimento`.
  Depois da única chamada, a rota encerrou; a checagem final encontrou zero
  processos de diagnóstico.
- O `agenda_tools.py` ativo carrega exatamente
  `/opt/data/agenda_config.json`, e `cmd_book` e `cmd_remarcar` chamam
  `dentro_do_horario_de_atendimento()` antes de gravar. Portanto foi provado
  que a Control API lê/escreve o mesmo arquivo que o bot usa para decidir.

### Limitação e risco de desincronia

Não foi possível consultar diretamente a linha `settings.availabilitySchedule`
do Postgres de produção: a credencial read-only disponível retornou
`permission denied`, o endpoint público do SAC exige autenticação e o CLI local
da Vercel está deslogado. Assim, a prova direta desta rodada é
“Control API = arquivo lido pelo bot”, não uma leitura independente da linha de
produção do SAC.

O caminho de escrita fica protegido pelo endurecimento incorporado nesta branch:
o PUT do SAC faz `GET Hermes → POST Hermes → GET Hermes`, só persiste no SAC
depois de confirmar exatamente grade, slot e timezone, e restaura o JSON remoto
se o banco falhar. Ainda há um risco arquitetural: edição fora do SAC diretamente
em `agenda_config.json` pode divergir do valor manual armazenado; não existe um
reconciliador contínuo de duas vias.

### Horário específico por data

É um gap real. Nem o modelo/API/UI do SAC, nem o JSON do Dr. Lucas, nem
`agenda_tools.py` possuem uma exceção parcial do tipo “24/12 funciona até 14h”.
Hoje existem somente:

- grade semanal recorrente;
- bloqueio da data inteira em `bloqueios.json`/`agenda_blocked_dates`;
- ocupações de horários vindas do calendário.

Não foi implementado porque não é uma mudança pequena e isolada: exige modelo e
migração, UI e contrato de API no SAC, payload persistente na Control API,
semântica no runtime do Hermes e precedência definida contra bloqueio integral e
eventos do Google Calendar. Fazer só o lado do SAC criaria novamente uma
configuração que o bot não consome.

### Confirmado somente por leitura — Gramado Plazza

No container de produção do Gramado não existe uma função com o nome
`dentro_do_horario_de_atendimento()`. O equivalente real fica em
`/opt/data/reservas_tools.py`: `_preflight_capacidade()` chama
`GET /api/v1/slots` imediatamente antes do `POST /api/v1/reservas`, exige o
horário exato com `disponivel=true`, respeita a `grade` devolvida pela API e
falha fechado quando a leitura falha ou o horário fica fora da grade. O POST da
reserva continua sendo a barreira atômica final.

A fonte de verdade do Gramado é, portanto, a API de reservas. O arquivo gravado
pelo `/api/agenda-config` do painel antigo não tem consumidor nesse fluxo e não
há endpoint real de escrita da grade. A tela e o PUT do SAC permanecem
somente leitura/`409`; nenhum write, restart ou POST foi feito no servidor do
Gramado.

### Implementado para o executor de follow-up do SAC

O executor já adiava jobs fora das múltiplas faixas semanais e em datas
bloqueadas por empresa. Foi corrigida uma lacuna: ele aceitava
`availabilityScheduleManual=true` mesmo no Gramado, onde esse override não pode
ser escrito na fonte real. Agora:

- Dr. Lucas pode usar a grade manual somente porque há write-through confirmado;
- Gramado prefere sempre o snapshot nativo da fonte real enquanto não existir
  escrita real;
- os bloqueios continuam separados por `companyId` e o próximo intervalo é
  calculado no timezone da própria empresa.

Há teste unitário da seleção para os dois clientes e teste de contrato provando
que o cron seleciona o `companySlug` antes de tomar essa decisão.

## ITEM 2 — Bloqueios de data respeitados pelo bot

### Implementado

O sync de bloqueio do Dr. Lucas recebeu o mesmo padrão transacional do horário:

1. relê `/api/agenda-bloqueios` e guarda o estado anterior;
2. chama `/api/agenda-bloquear` ou `/api/agenda-desbloquear`;
3. relê e exige presença+motivo exatos, ou ausência exata;
4. em divergência, falha e restaura o estado remoto anterior;
5. se a escrita local no SAC falhar depois do Hermes, restaura também o Hermes.

POST e DELETE não afirmam sucesso quando a releitura remota não confirma. O
comportamento de fontes combinadas foi preservado: remover
`google_calendar+bot_bloqueios` tira apenas a parcela do bot e mantém o bloqueio
do Google; `google_calendar` puro não toca o Hermes.

### Prova real ponta a ponta — Dr. Lucas

Foi adicionado e executado `scripts/hermes-blocked-date.live-smoke.ts`. Ele usa
as rotas reais do Next (`POST` e `DELETE`), Postgres descartável com schema real,
Control API real do Dr. Lucas e um processo Python novo dentro do container
ativo importando o `agenda_tools.py` real.

Resultado com a data inócua `2099-12-31` e motivo único de smoke:

- POST da rota do SAC: HTTP 201;
- linha e auditoria gravadas no banco isolado;
- GET da Control API confirmou data e motivo;
- `eh_bloqueado()` e `motivo_bloqueio()` do bot retornaram o bloqueio e o motivo;
- DELETE da rota do SAC: HTTP 200;
- banco isolado ficou sem a linha;
- GET da Control API confirmou ausência;
- novo processo do bot retornou `false` e motivo vazio;
- `finally` restaurou e releu a ausência original exata.

O teste foi executado duas vezes com sucesso. A conferência posterior encontrou
a data ausente na Control API, zero containers de smoke e zero processos de
diagnóstico. A consulta read-only disponível também confirmou contagem zero para
essa data na tabela de produção, embora o smoke nunca tenha usado o banco de
produção.

### O bot realmente consulta o bloqueio

Confirmado, não inferido. O `agenda_tools.py` ativo carrega
`/opt/data/bloqueios.json`; listagem de slots, criação e remarcação consultam
`eh_bloqueado()`/`motivo_bloqueio()`. Além da leitura do código, o smoke acima
provou que um bloqueio criado pela rota do SAC é visto por uma importação nova do
runtime antes da remoção e deixa de ser visto depois dela.

### Gramado

Não foi promovido nem forçado qualquer sync. O Gramado não tem endpoint de
escrita real equivalente. Datas/horários disponíveis são decididos pelo
`GET /api/v1/slots` da API real de reservas no preflight. O SAC segue somente
leitura; criar um arquivo paralelo no painel não faria a Gabi respeitá-lo.

## ITEM 3 — Follow-up de confirmação de agendamento

### O que o `mvp_agente_ia` realmente implementava

O projeto existe em `/home/claude/mvp_agente_ia`. Os commits relevantes são
`b92698e` (“follow-up automático configurável — lead que parou no meio”),
`b2bbc92` (“follow-up contextual”) e `a8fbcb8` (“tempos, janela e intervalo”).
O card atual diz que o agente lê a conversa, escreve o lembrete e retoma de onde
parou; a execução foi movida do Next para o motor do VPS.

Conclusão: aquele item de backlog não era lembrete de consulta e também não era
confirmação técnica de que a reserva foi persistida. Era retomada contextual de
uma conversa comercial abandonada.

Isso é confirmado também pelos executores atuais fora do SAC:

- Dr. Lucas: `/opt/gastaomatos/hermes/followup/followup_agent.py` retoma a
  conversa e para após agendamento confirmado;
- Gramado: `/opt/data/followup_gramadoplazza.py` retoma chats em que a Gabi não
  fechou reserva e para quando existe reserva real.

Esses executores externos ainda usam janelas próprias/fixas e não consultam a
grade/bloqueios do SAC. A proteção implementada no cron desta branch cobre os
jobs de `messageJobs` executados pelo SAC, não muda magicamente esses dois
processos externos.

### `followUpDate`/`followUpNote` não são a mesma coisa

São campos manuais e genéricos do CRM/pipeline em `recoveryLeads`, editados e
exibidos nos cards. O cron não os lê e eles não representam consulta/reserva.
As `recoverySequences`/`messageJobs` do SAC formam ainda um terceiro conceito:
sequências automáticas ligadas a eventos de recuperação de venda.

### Decisão de implementação

Não foi criado um disparo de “confirmação de agendamento”, porque a investigação
eliminou a premissa do backlog e não encontrou uma especificação que escolha
entre estas três funcionalidades distintas:

1. retomada contextual de conversa parada, que é o legado real;
2. lembrete/confirmação de presença X horas antes da consulta/reserva;
3. confirmação técnica imediata de que a criação foi persistida.

Para implementar 2 ou 3 sem especulação ainda é preciso decidir com
Gastão/Renato: qual evento/fonte canônica fornece a consulta dos dois clientes,
antecedência, texto e canal, regras de opt-out/repetição, estados de
cancelamento/remarcação e o que conta como confirmação. Para o Gramado também é
obrigatório manter qualquer implementação isolada, sem promoção, até autorização.

## Verificações e entrega

- `pnpm test:agenda-followup-policy`: 26 testes/contratos relevantes passaram
  (13 política, 4 rota de horário, 2 DELETE de bloqueio, 7 Control API).
- `pnpm test:native-availability-sync`: 8/8 passaram.
- `pnpm test:agenda-slot-validation`: 6/6 passaram.
- `pnpm exec tsc --noEmit`: passou.
- ESLint dos arquivos funcionais alterados: passou. O lint incluindo
  `src/lib/db/index.ts` ainda acusa cinco usos antigos de `any`, anteriores e
  fora desta mudança; neste arquivo só foram corrigidos comentários.
- `git diff --check`: passou.

O `.git` compartilhado está montado somente leitura e não permitiu criar o
sequencer/commit nesta worktree. A entrega foi materializada em
`items123-horarios-bloqueios-followup.bundle`, na raiz, com a branch e os commits
verificáveis, sem push ou merge.
