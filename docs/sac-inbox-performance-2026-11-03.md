# SAC — investigação do Inbox (2026-11-03)

## Causa reproduzida

`InboxLayout` precisava terminar `loadInboxPage` antes de renderizar a lista. A consulta de visibilidade usava um `EXISTS` correlacionado com três alternativas (`lead_id`, telefone e telefone normalizado) dentro do mesmo `OR`; no checkout havia também uma segunda inserção da mesma condição. Em um tenant grande, o PostgreSQL filtrava mensagens repetidamente e a tela permanecia no carregamento.

O cenário descartável reproduz a diferença relatada sem tocar na produção: 253 leads e 253 mensagens para Dr. Lucas, 5.096 leads e 76.440 mensagens para Gramado. Antes da correção, a seleção inicial do Gramado excedeu 5 s e ficou presa por mais de 2 minutos em uma execução. Depois da correção, a consulta usa conjuntos candidatos por chave e canal, com paginação por cursor:

| Tenant | Primeira página | Consultas | Payload | Linhas | Segunda página |
| --- | ---: | ---: | ---: | ---: | ---: |
| Dr. Lucas | 52,8 ms | 4 | 48,3 KB | 75 | — |
| Gramado Plazza | 102,2 ms | 4 | 48,8 KB | 75 | 109,6 ms |

O teste executado foi `node --experimental-test-module-mocks --import tsx --test scripts/inbox-tenant-performance.test.ts`, com PostgreSQL 16 descartável, `statement_timeout=5000`, cursor e índice de telefone normalizado verificados. O teste passou.

## Alterações locais

- A consulta de visibilidade foi reescrita para usar pares de identidade e canal em subconsultas não correlacionadas; a condição duplicada foi removida.
- Foi registrado o índice de telefone normalizado em `schema.ts` e em `ensureSchema`.
- `/inbox` ganhou loading e error boundary próprios; a carga inicial tem limite de 8 s e informa falha ao usuário.
- `/api/inbox` devolve JSON 500 com código estável quando a consulta falha.
- O cliente aborta requisições presas após 12 s e identifica 401, redirect para login, HTML e payload incompleto; não trata uma página de login como lista vazia.
- Instagram independente, verificação direta de seguir/gatilho Luana, painel de IA auditável e áudio/transcrição com anexo já estavam presentes nos commits `3e99a39`, `b1c5bd7`, `ade1728`, `32c2d1f` e `695325f`; foram revalidados nesta rodada.

## Validação e limites

- Build, TypeScript, lint dos arquivos alterados e testes do Inbox, filtros, autenticação, Instagram, seguir/Luana, IA e áudio passaram.
- O lint completo ainda encontra cinco `any` preexistentes em `src/lib/db/index.ts`, fora deste diff.
- Readback público atual: `GET /inbox` e `GET /api/inbox` retornam HTTP 307 para `/handler/sign-in`; não há sessão administrativa neste executor para conferir a tela/API autenticadas.
- O commit local de autenticação `69f33f5` continua sem publicação. Não houve publicação, troca de credenciais, envio de mensagem ou ação real.
