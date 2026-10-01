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

## Commits

- Implementação e testes do gate:
  `7f70b05a338ae0b63f99879bcb606be1a8f966bb`.
- Primeiro relatório da entrega: `dd00fe5974a13b203bbace5c97d9b2fb0dbcfbec`.
- Correção do baseline de lint do `sidebar.tsx`:
  `d6bec1b772efb66e93efb399ac705878201361ad`.

O `.git` compartilhado continua somente leitura no sandbox: o `git add`
nominal falhou ao tentar criar `.git/worktrees/comentario-dm-menu/index.lock`.
Os commits novos foram, portanto, produzidos em clone temporário baseado
exatamente em `dd00fe59` e entregues em
`comentario-dm-menu-qa-fix.bundle` na raiz deste worktree. Este relatório fica
em um commit documental posterior ao commit de lint dentro do mesmo bundle.

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

## Correção do lint bloqueante

Antes desta correção, o comando solicitado pelo QA retornava código `1` e
reportava exatamente **11 problemas: 3 erros e 8 warnings**, todos em
`src/components/layout/sidebar.tsx`:

- `3:31` — warning `@typescript-eslint/no-unused-vars` (`Fragment`);
- `25:3` — warning `@typescript-eslint/no-unused-vars` (`Filter`);
- `337:9` — error `react-hooks/set-state-in-effect`;
- `347:7` — error `react-hooks/set-state-in-effect`;
- `364:6` — warning `react-hooks/exhaustive-deps` (`isActive`);
- `379:9` — warning `@typescript-eslint/no-unused-vars`
  (`showSectionAtendimento`);
- `380:9` — warning `@typescript-eslint/no-unused-vars`
  (`showSectionAnalise`);
- `381:9` — warning `@typescript-eslint/no-unused-vars`
  (`showSectionApiOficial`);
- `978:15` — warning `@next/next/no-img-element`;
- `1018:10` — warning `@typescript-eslint/no-unused-vars` (`mounted`);
- `1021:5` — error `react-hooks/set-state-in-effect`.

Foram removidos os imports, constantes e estado sem uso. As restaurações de
preferências após a hidratação e a abertura de seção após mudança de rota foram
preservadas e receberam exceções locais justificadas para
`react-hooks/set-state-in-effect`; reestruturá-las poderia mudar hidratação e
comportamento. A dependência deliberadamente restrita a `pathname` recebeu
justificativa local, assim como o `<img>` cuja URL externa vem do provedor de
identidade e não possui host estático para `next/image`. Nenhuma lógica do gate
ou da navegação foi alterada.

Resultado final e reproduzível:

```bash
pnpm exec eslint src/lib/company-sidebar.ts src/components/layout/sidebar.tsx scripts/instagram-direct-access-gate.test.ts scripts/instagram-comment-menu-gate.test.ts
```

Código de saída: `0`. Saída exata: **vazia** (`stdout` e `stderr` sem conteúdo).

## Revalidação após a correção de lint

- `npm run test:instagram-comment-menu-gate` — código `0`; saída final exata:
  **3 testes, 3 passaram, 0 falharam, 0 cancelados, 0 pulados, 0 todo**.
- `npm run test:instagram-direct-regressions` — código `0`; saída final exata:
  **6 testes, 6 passaram, 0 falharam, 0 cancelados, 0 pulados, 0 todo**.
- `npx tsx scripts/sidebar-nav-filters.reconcile.test.ts` — código `0`; saída
  final exata: **16 passaram, 0 falharam**.
- `npx tsc --noEmit` — código `0`; saída exata: **vazia** (`stdout` e `stderr`
  sem conteúdo).
- `git diff --check` — código `0`; saída exata: **vazia**.
