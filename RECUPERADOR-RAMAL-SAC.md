# Recuperador de vendas como ramal do SAC

Documento de decisão. Escrito em 10/09/2026 a partir da documentação dos dois
lados: `memory.md` do RecuperaVendas (615 linhas, atualizada em 13/05/2026) e
`SAC-V2-POSTGRES.md` / `README-integracoes.md` deste repositório. Nenhum código
foi alterado nos dois sistemas para produzi-lo.

Revisado em 10/09/2026 com uma descoberta sobre o banco dos agentes que muda o
desenho da fronteira — veja a seção logo abaixo do resumo dos dois lados.
Continua valendo: nada foi alterado no banco dos agentes nem no recuperador.

## Os dois lados, em uma frase cada

**RecuperaVendas** (`recuperar.casaldotrafego.com`, Next.js + Neon + Vercel):
recebe evento de checkout por webhook, cria `recovery_lead`, agenda
`message_jobs` e um cron externo de 5 em 5 minutos envia por WhatsApp. Já tem o
que interessa: 4 plataformas (Hotmart, Kiwify, Greenn, Zouti), 6 tipos de
evento, cancelamento de fila quando a compra entra e atribuição de qual mensagem
converteu.

**SAC v2** (este repositório, PostgreSQL com schema e role por agente): recebe
mensagem de qualquer canal, persiste antes de responder 2xx, e entrega por
outbox com lease, retentativa, dead-letter e auditoria.

Os dois resolvem metades diferentes do mesmo problema. O recuperador sabe
*quando* falar; o SAC sabe *como* falar sem duplicar, perder ou mentir no
histórico.

## Descoberta que muda o desenho: o lado do agente já isola por schema

Este documento nasceu supondo que o banco dos agentes fosse uma base plana e
que a integração precisaria de estrutura nova lá dentro. **Não precisa.** O
banco dos agentes (o Supabase `mvp_agente_ia`, em produção) **já provisiona um
schema por cliente**, com tabelas `conversations` e `messages`, pela função
`public.provision_agent_schema`. O schema `gramadoplazza` já existe assim.

Ou seja: os dois lados já usam o mesmo padrão de isolamento — schema por
cliente, control plane em `public`, dado do cliente fora dele. O SAC v2 chegou
a esse desenho por conta própria, e o lado do agente já estava nele. Isso muda
três coisas:

1. **Não há tabela nova a criar no banco dos agentes. Nunca.** A integração é
   por **leitura** (o SAC lê `<cliente>.conversations` / `<cliente>.messages`)
   ou por **evento publicado** (o lado do agente publica; o SAC consome). Toda
   escrita do SAC acontece no banco novo de integrações. Criar tabela, coluna,
   índice, trigger ou RLS no banco dos agentes está fora de cogitação: aquele
   banco roda outro sistema em produção e a alteração de estrutura foi proibida
   explicitamente.
2. **A tradução de identidade fica mais barata.** Como cada cliente já tem
   schema próprio dos dois lados, o par `tenant_id`/`agent_id` do SAC mapeia
   para um nome de schema do lado do agente sem precisar de tabela de-para
   compartilhada. O mapa mora no control plane do SAC
   (`public.sac_agents.schema_name`), não no banco dos agentes.
3. **O risco de "consulta cruzada" some.** Como não há junção entre os dois
   bancos, nenhuma consulta do SAC pode, por acidente, misturar dado de dois
   clientes por causa de um `WHERE` esquecido: o isolamento é físico, por
   schema e por conexão, nos dois lados.

O que continua valendo do lado do agente: nada de segredo em coluna
(item 1 abaixo), e a leitura precisa de uma role de leitura própria, com
`USAGE` só nos schemas acordados e `SELECT` só em `conversations` e `messages`.
Essa role é criada no banco dos agentes por quem tem autoridade lá, e é a
**única** concessão que a integração pede naquele banco.

## Onde eles se chocam

Quatro pontos. Nenhum é impeditivo, mas todos precisam de decisão antes de
ligar o primeiro cliente.

### 1. Segredo no banco

O recuperador guarda credencial em coluna de tabela: `settings.hotmartClientSecret`,
`settings.metaAccessToken`, `settings.uazapiInstanceToken`, `settings.greennApiKey`.

O SAC proíbe isso por invariante — no banco só entra **referência** para o cofre.
Enquanto as duas bases não estiverem sob a mesma regra, unificar acesso amplia o
raio de exposição em vez de reduzir. É também o item que já estava na lista de
pendências do SAC ("migrar e rotacionar credenciais embutidas antes de ampliar
acesso").

**Consequência prática:** o SAC não deve ler `settings` do recuperador. Se
precisar de credencial de WhatsApp de um cliente, ela é recadastrada no cofre do
SAC e rotacionada no recuperador.

### 2. Fila sem lease

`message_jobs` tem `status` (`pending|sent|failed|cancelled`) e `scheduledFor`,
e o cron busca `status=pending AND scheduledFor <= agora`. Não há lease, ACK,
retentativa com recuo nem dead-letter.

Isso funciona porque hoje existe **um** cron. Se dois dispararem juntos — uma
retentativa da Vercel, um cron duplicado, uma janela de deploy — os dois pegam a
mesma linha e o lead recebe a mensagem duas vezes. O SAC v2 já resolve isso com
lease e ACK.

### 3. Tenant por slug adivinhável

A URL de webhook é `/api/webhooks/<plataforma>/<slug>`, e o `slug` é derivado do
nome ou e-mail da empresa no primeiro login. O SAC exige endpoint público
**opaco**, justamente para o endereço não ser adivinhável.

O token de webhook é que protege de fato, então não é um buraco aberto — mas é
uma camada a menos, e enumerar empresas por tentativa de slug é trivial.

### 4. Identidade por telefone cru

O recuperador chaveia lead por `phone`. O SAC chaveia por `canal:identificador`
(`whatsapp:+55...`), e proíbe fundir identidades de canais diferentes sem
evidência explícita.

São compatíveis, mas a tradução precisa ser explícita na fronteira: o evento que
entra no SAC carrega `whatsapp:+55...`, nunca o telefone solto, senão a primeira
integração de Instagram ou e-mail do mesmo cliente vai querer fundir por nome.

## A decisão que falta: quem envia

Tudo acima é detalhe de execução. A decisão de arquitetura é uma só.

Nas duas opções abaixo, a fronteira é a mesma e não é negociável: **leitura ou
evento publicado**. O SAC nunca escreve no banco dos agentes nem no banco do
recuperador; o que ele precisa guardar, guarda no banco novo de integrações.

### Opção A — recuperador continua enviando, SAC só espelha

O recuperador segue dono do envio. Ao criar um `recovery_lead`, publica um
evento no SAC, que cria a conversa como **somente leitura**, para o atendimento
aparecer no painel junto com os outros canais.

- Rápido, risco quase zero, não mexe em produção.
- Mas duplica outbox, e a auditoria fica partida em dois bancos. Operador que
  responder pelo painel não vai ver o que o cron enviou, e vice-versa.

### Opção B — recuperador publica, SAC envia

O recuperador para de enviar para os clientes migrados: ele detecta o evento,
resolve a sequência e publica no SAC as mensagens agendadas. O envio,
o dedupe, a retentativa, o DLQ e a auditoria passam a ser todos do SAC.

- Uma fila só, um histórico só, uma auditoria só. O operador vê e responde no
  mesmo lugar em que o robô falou.
- Exige desligar o cron de envio **por empresa**, não globalmente, e uma janela
  em que nenhuma das duas pontas envia.

### Recomendação

**Opção B, faseada, uma empresa por vez.** A Opção A parece mais barata e cobra
depois: no dia em que o operador precisar assumir a conversa que o robô começou,
o histórico partido vira retrabalho maior do que a migração.

Fase 1 — o recuperador publica no SAC e continua enviando (espelho). Confere-se
se contagem, ordem e conteúdo batem nos dois lados, sem ninguém receber nada
diferente do que já recebe hoje.

Fase 2 — para **uma** empresa, desliga o envio no recuperador e liga o do SAC.
Homologa entrada, resposta, dedupe, reinício, timeout, retry/DLQ e avanço de
pipeline.

Fase 3 — repete por empresa, e só então liga os outros canais dela.

## O que ainda depende de você

1. **Qual plataforma primeiro.** São 4 e cada uma tem contrato de webhook
   próprio. Ligar as quatro juntas multiplica a homologação por quatro.
2. **Qual empresa é a cobaia da Fase 2.** Precisa ser uma com volume suficiente
   para provar o fluxo e prejuízo pequeno se algo escapar.
3. **Se o `checkBeforeSend` e o delay mínimo de 30 minutos viram regra do SAC.**
   São duas boas decisões do recuperador que hoje não existem deste lado, e eu
   não as trago sem sua confirmação — a segunda muda o tempo de resposta de
   qualquer sequência.

## O que NÃO muda em nenhuma hipótese

O recuperador tem hoje um cron que envia WhatsApp para contato real. Enquanto a
integração estiver sendo construída, ela roda com `DRY_RUN=true` do lado do SAC
e **nenhuma ponta nova envia mensagem**. Nada de mensagem de teste para contato
real; homologação em conta sandbox. O piloto AutonomIA continua somente leitura.

E, desde a descoberta acima: **nenhuma alteração de estrutura no banco dos
agentes**. Sem tabela nova, sem coluna nova, sem índice, sem trigger, sem RLS,
sem migration. A integração entra por leitura ou por evento publicado, e todo
estado da integração mora no banco novo — Neon ou segundo projeto Supabase,
preparado por `scripts/preparar-banco-sac.py` (veja `RUNBOOK-v2.md`).
