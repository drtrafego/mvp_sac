# Integrações dos canais

Este material é deliberadamente isolado de produção. Ele documenta e valida a
configuração de WhatsApp Cloud API, Instagram Messaging API e Brevo sem abrir
conexões, alterar webhooks ou imprimir credenciais.

## Uso local

```bash
cp .env.example .env.local
set -a; . ./.env.local; set +a
python3 healthcheck.py --json
python3 -m unittest discover -s tests -v
```

O health check só informa `presente`, `ausente` ou `inválido`; nunca mostra o
conteúdo das variáveis. Saída 0 significa configuração pronta, 1 significa que
faltam dados e 2 significa erro de uso.

## Inventário e responsabilidades

| Canal | Entrada | Envio | Identificador externo | Segredo de webhook |
|---|---|---|---|---|
| WhatsApp | Meta webhook `messages` | Graph API `/PHONE_NUMBER_ID/messages` | `wamid` | `META_APP_SECRET` |
| Instagram | Meta webhook `instagram/messages` | Graph API `/IG_ACCOUNT_ID/messages` | `mid` | `META_APP_SECRET` |
| E-mail | webhook transacional Brevo | Brevo SMTP/API | `message-id` / `event` | `BREVO_WEBHOOK_SECRET` |

`META_VERIFY_TOKEN` serve apenas ao desafio GET de cadastro. A autenticidade
dos POSTs Meta deve ser verificada com `X-Hub-Signature-256` e
`META_APP_SECRET`. Em Brevo, configure o endpoint com segredo próprio e valide
o header definido em `BREVO_SIGNATURE_HEADER`; se a conta usar outro mecanismo
de autenticação, o adapter deve ser trocado antes da produção.

## Contrato interno normalizado

Todo adapter deve produzir um evento com: `channel`, `external_event_id`,
`identity`, `occurred_at`, `direction`, `kind`, `text`, `acquisition_source` e
`raw_ref`. O payload bruto não deve ir para logs. `identity` é namespaced
(`whatsapp:+55...`, `instagram:178...`, `email:pessoa@...`) para evitar fusão
por nome.

## Dedupe

A chave é `channel:external_event_id`. A persistência deve ter índice UNIQUE e
uma inserção atômica; cache em memória não basta. Quando o provedor não entregar
ID, gere SHA-256 de canal + identidade + timestamp do provedor + tipo + corpo
canônico. Retentativas respondem 2xx sem executar Hermes, enviar resposta ou
mover card novamente. Guarde a chave por no mínimo 30 dias.

## Webhooks

- Expor HTTPS e responder ao desafio Meta somente quando o verify token bater.
- Capturar o corpo bruto antes de parsear JSON; assinatura é calculada sobre os
  bytes originais.
- Rejeitar assinatura ausente ou inválida antes de qualquer efeito colateral.
- Confirmar rapidamente com 2xx após persistência durável; trabalho pesado vai
  para fila.
- Separar endpoint por cliente/tenant e resolver credencial pelo tenant, nunca
  por valor recebido no payload.
- Limitar tamanho, validar content-type, registrar apenas IDs/redações seguras e
  manter relógio sincronizado.

## Critérios de aceite para ativação

1. `healthcheck.py --json` retorna 0 no ambiente de homologação e não contém
   qualquer valor secreto na saída.
2. Desafio GET correto retorna o challenge; token errado retorna 403.
3. POST com assinatura válida é aceito e assinatura inválida/ausente retorna
   401, sem gravação, resposta ou movimentação.
4. O mesmo evento entregue 3 vezes cria uma entrada, uma execução do Hermes e
   no máximo uma mudança de etapa.
5. Mensagens WhatsApp, Instagram e e-mail viram o contrato normalizado e mantêm
   canal e origem de aquisição como campos separados.
6. Identidades de canais diferentes não são fundidas por nome; união só ocorre
   com evidência confiável e auditável.
7. Falha depois da persistência permite retry; falha antes dela não devolve 2xx.
8. Logs e respostas de health check passam por busca de tokens/e-mails/corpos e
   não revelam dados pessoais ou segredos.
9. Teste ponta a ponta em contas sandbox confirma entrada, resposta, dedupe e
   avanço monotônico do pipeline antes de qualquer chave de produção.
