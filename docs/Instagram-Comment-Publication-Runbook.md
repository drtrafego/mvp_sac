# Automação oficial de resposta a comentários do Instagram

O fluxo global do SAC recebe o evento oficial `comments` nos webhooks de Instagram. Quando o texto contém a palavra `Luana` (sem diferenciar maiúsculas e minúsculas), o backend:

1. aceita somente o `entry.id` que pertence ao tenant resolvido e um `media_id` explícito recebido no evento;
2. deduplica pelo `company_id + comment_id`;
3. aplica o limite de 60 jobs por tenant em uma hora;
4. cria um job `instagram.comment.reply` por comentário, com o `media_id`, o `comment_id` e o texto aprovado;
5. grava auditoria sem guardar o texto livre do comentário;
6. mantém o job em `aguardando_confirmacao`.

Não há seleção manual de post, geração de ID, scraping, Bot API ou uso do `composio_responder.py`. Cada post coberto aparece somente porque a Meta entregou seu `media_id` no evento oficial. Comentários sem `media_id` numérico, sem autor, fora da conta do tenant ou sem `comment_id` são bloqueados e auditados.

Texto aprovado:

`Quer implementar a Luana na sua empresa? Na consultoria, vamos entender sua rotina e identificar quais tarefas ela pode assumir pra ajudar sua equipe no dia a dia. Nossa equipe vai entrar em contato com você pra marcar o melhor horário. Topa??`

## Confirmação e execução

O operador consulta o job pelo painel e confirma com:

`POST /api/codex/actions/{jobId}/confirm` com `{ "confirm": true }`.

Para este tipo de evento, a confirmação humana muda o job para `executando` e registra `codex_job_confirmed`. O executor oficial usa:

`POST /api/v1/companies/{tenant}/instagram/comments`

com `x-codex-confirmed: true` e um corpo contendo `jobId`, `mediaId`, `commentId` e o texto exato do job. O endpoint confere tenant, intenção, `media_id`, `comment_id`, estado e claim atômico. A função de publicação lê previamente o `media_id` com o token do tenant e só então chama `/{comment_id}/replies` na Graph API oficial.

O executor exige `SAC_CODEX_EXECUTOR_KEY` no servidor e o chamador fornece a mesma chave somente como `Authorization: Bearer ...`. O token do Instagram fica apenas nas configurações seguras do tenant. Sem qualquer uma dessas credenciais, a resposta é bloqueada; a preparação e a confirmação não publicam.

## Auditoria e bloqueios

Os eventos preparados usam `sac_codex_jobs` com chave idempotente derivada do tenant e `comment_id`. A auditoria registra preparação, bloqueio por tenant/post, limite excedido, confirmação e resultado da execução. Uma reentrega do mesmo comentário reutiliza o job existente e não cria outro.

O código foi preparado e testado localmente. Nenhum webhook real foi enviado, nenhum job de produção foi confirmado e nenhum comentário foi publicado nesta execução porque não foram fornecidos credencial segura, tenant operacional ou `media_id` real.
