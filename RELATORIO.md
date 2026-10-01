# Relatório — gate do menu “Comentário → DM”

## Confirmação da causa

A causa reportada foi confirmada após a leitura integral de
`src/components/layout/sidebar.tsx`:

- `atendimentoNav` continha “Comentário → DM” sem condição e a seção de
  Atendimento renderizava o array diretamente com `map`, portanto o link era
  exibido para todas as empresas.
- `instagramNav` continha uma segunda cópia do link. A seção Instagram já era
  condicionada por `activeConnections.instagram`, que representa credenciais
  válidas de Instagram Direct, mas o item não verificava a existência de uma
  automação de comentário. Assim, uma empresa com Direct configurado e nenhuma
  regra de comentário ainda via essa cópia.
- Não existia outra condição específica que ocultasse qualquer uma das duas
  cópias conforme a configuração da automação.

## Sinal correto e correção

O schema define as regras por empresa em `instagram_comment_automations`, com
o estado operacional em `is_active`. O processador de comentários usa a mesma
semântica: só consulta regras com `company_id` da empresa e `is_active=true`.

`getCompanySidebarData` agora consulta a existência de pelo menos uma regra
com essas duas condições (seleção apenas do `id`, limitada a uma linha) e expõe
o resultado como `activeConnections.instagramCommentAutomation`. Esse sinal é
independente de `activeConnections.instagram`, pois credenciais de Direct não
implicam uma automação de comentário configurada.

As entradas de “Comentário → DM” em `atendimentoNav` e `instagramNav` declaram
o mesmo requisito, e ambas passam pelo filtro compartilhado usado pela
renderização. Uma regra pausada (`is_active=false`) não libera o item, coerente
com o fato de que o processador não executa essa regra.

## Commit

Commit de implementação e testes:

`7f70b05a338ae0b63f99879bcb606be1a8f966bb`

O `.git` compartilhado estava somente leitura no sandbox. Por isso, o commit
foi produzido sobre um clone temporário baseado no mesmo `main` atualizado
(`bd2867d5`) e será entregue em `comentario-dm-menu.bundle` na raiz deste
worktree. Este relatório é incluído em um segundo commit no mesmo bundle.

## Provas

Não havia credencial de produção disponível no worktree (somente arquivos de
exemplo). A prova positiva e as negativas foram executadas com dados sintéticos
persistidos em um Postgres 16 real e descartável pelo teste
`scripts/instagram-comment-menu-gate.test.ts`:

- Caso negativo: empresa `301`, com credenciais de Instagram Direct mas sem
  automação, recebeu `instagramCommentAutomation=false`; o item ficou ausente
  em Atendimento e Instagram.
- Caso positivo: empresa `302`, com regra `is_active=true`, recebeu
  `instagramCommentAutomation=true`; o item permaneceu visível nas duas
  seções.
- Caso pausado: empresa `303`, com regra cadastrada e `is_active=false`, recebeu
  `instagramCommentAutomation=false`; o item ficou ausente nas duas seções.

Validações executadas com sucesso:

- `npx tsc --noEmit`
- `npx eslint src/lib/company-sidebar.ts src/components/layout/sidebar.tsx scripts/instagram-direct-access-gate.test.ts scripts/instagram-comment-menu-gate.test.ts`
- `npm run test:instagram-comment-menu-gate` — 3/3 testes passaram
- `npm run test:instagram-direct-regressions` — 6/6 testes passaram
- `npx tsx scripts/sidebar-nav-filters.reconcile.test.ts` — 16/16 testes passaram
