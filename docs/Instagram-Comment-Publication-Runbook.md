# Publicação oficial de comentário no Instagram

O único caminho de publicação de comentário iniciado pelo SAC é:

`POST /api/v1/companies/{tenant}/instagram/comments`

A rota chama `createInstagramMediaComment` em `src/lib/instagram.ts`. Essa função faz uma leitura prévia do `media_id` com o token do tenant, confere a conta proprietária quando há username configurado e só então chama a API oficial `/{media_id}/comments`. O fluxo não usa script legado, scraping ou Bot API.

## Pré-condições obrigatórias

Antes do runner, o painel SAC precisa ter criado um job com:

- `intent`: `instagram.comment.create`;
- `companyId`: o tenant que será usado na URL;
- `mediaId`: o `media_id` numérico do post ou reel;
- `targetText`: exatamente o texto que será publicado;
- `status`: `aguardando_confirmacao`.

A confirmação humana ocorre no painel, pelo botão **Confirmar**, que chama `POST /api/codex/actions/{jobId}/confirm` com `{ "confirm": true }`. O executor só pode ser chamado depois que o job avançar para `executando`. O runner exige ainda `--confirm` para evitar uma chamada acidental e envia `x-codex-confirmed: true`.

O servidor precisa ter `SAC_CODEX_EXECUTOR_KEY` configurada. O operador fornece a mesma chave somente pela variável de ambiente `SAC_CODEX_EXECUTOR_KEY`; ela não deve aparecer em argumento, arquivo, log ou mensagem. `SAC_API_BASE_URL` também deve apontar para o SAC correto.

## Runner

Grave o texto em um arquivo local protegido e forneça apenas o caminho ao runner. O texto deve ter entre 1 e 2.200 caracteres.

```sh
SAC_API_BASE_URL='https://sac.exemplo' \\
SAC_CODEX_EXECUTOR_KEY="$SAC_CODEX_EXECUTOR_KEY" \\
pnpm exec tsx scripts/publish-instagram-comment.ts \\
  --tenant empresa-slug \\
  --job-id JOB_ID \\
  --media-id 17841400000000000 \\
  --text-file /caminho/comentario.txt \\
  --confirm
```

O runner chama somente a rota oficial, com este corpo:

```json
{
  "jobId": "JOB_ID",
  "mediaId": "17841400000000000",
  "text": "texto exato do job"
}
```

Se o tenant não existir, o job não pertencer ao tenant, o `mediaId` ou texto não corresponder ao job, o job não estiver em `executando`, ou a ação já tiver sido reivindicada, a rota bloqueia a publicação. Em timeout da API do Instagram, o job fica para revisão porque a operação externa pode ter sido aceita; não se deve repetir o job automaticamente.

## Bloqueio desta auditoria

Nenhum job, tenant, `media_id`, confirmação humana ou credencial foi fornecido para esta execução. Por isso o runner não foi chamado e nenhum comentário foi publicado. A entrega deste checkout é o caminho preparado e testado localmente; a publicação real continua bloqueada até essas pré-condições existirem.
