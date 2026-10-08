# Documento de Entrega — SAC Lote 1 (MVP SAC)

**Data:** 07/10/2026  
**Branch:** `feat/sac-lote1`  
**Escopo:** Implementação integral do Lote 1 conforme diretrizes técnicas e operacionais (Casal do Tráfego / Gastão Matos).  
**Status de Compilação:** 0 erros de TypeScript (`npx tsc --noEmit -p tsconfig.json` exit code 0).  
**Status de Testes:** 13/13 testes aprovados (`scripts/sac-lote1-core.test.ts`).

---

## 1. Mapeamento das 20 Oportunidades & Critérios de Aceite

| # | Oportunidade / Requisito | Solução Técnica Implementada | Critério de Aceite | Status |
|---|---|---|---|---|
| **01** | Envio de mensagens com semântica de estado e tratamento de falhas | Sender confiável (`src/lib/outbound-send.ts`) com estados `pending`, `accepted`, `failed`, `uncertain`. Captura e expõe mensagens de erro do transporte (ex.: erro Meta). | A01 | ✅ Concluído |
| **02** | Proteção contra duplo clique e reenvios acidentais | Idempotência baseada em `clientRequestId` exclusivo por tentativa no composer e APIs. Rejeita duplicações concorrentes. | A02 | ✅ Concluído |
| **03** | Assumir atendimento (Takeover) sem corrida entre operadores | Rota atômica `POST /api/inbox/[leadId]/claim`. Define `humanOwnerMemberId`, pausa bot (`botPaused = true`), incrementa monotonicamente `botControlVersion` e audita em `sac_audit_events`. | A03 / A12 | ✅ Concluído |
| **04** | Resolução unívoca de telefone e identificação de lead | `resolveLeadByPhone` com normalização estrita de dígitos e bloqueio de resolução ambígua caso dígitos coincidam entre DDDs distintos. | A04 | ✅ Concluído |
| **05** | Controle de acesso e permissões (RBAC) | `src/lib/company-role.ts` com verificação estrita: apenas usuários com role `admin` têm acesso a rotas administrativas e gestão de membros. | A05 | ✅ Concluído |
| **06** | Consistência no Pipeline ao migrar/excluir colunas | `src/app/api/pipeline/columns/route.ts` atualiza atomicamente tanto `status` quanto `pipelineStage` (`or(eq(status, migrateFrom), eq(pipelineStage, migrateFrom))`), eliminando órfãos no reload. | A06 | ✅ Concluído |
| **07** | Card de Contexto SAC no Inbox e Pipeline | Suporte completo a Pedido (`requestSummary`), Mensagem Ref (`requestMessageId`), Compromisso (`commitment`), Próxima Ação (`nextAction`), Prazo (`nextActionDueAt`) e Dono Humano (`humanOwnerMemberId`). | A07 | ✅ Concluído |
| **08** | Notas Internas de Atendimento | Tabela `sac_internal_notes` e APIs `GET/POST/DELETE /api/inbox/[leadId]/notes`. Estritamente internas (nunca enviadas aos canais externos), com soft delete e auditoria. | A08 | ✅ Concluído |
| **09** | Respostas Rápidas Aprovadas (Canned Replies) | Tabela `sac_approved_replies` e APIs `/api/approved-replies`. Suporte a atalhos (`/pix`), categorias e interpolação dinâmica de variáveis `{nome}` e `{produto}` sem disparo automático (injeta no composer). | A09 | ✅ Concluído |
| **10** | Busca com Snippet Seguro contra XSS | Função `createSafeSnippet` em `src/lib/inbox-conversations.ts` com escape HTML de caracteres perigosos (`<`, `>`, `&`, `"`, `'`) e recorte de contexto ao redor do termo pesquisado. | A10 | ✅ Concluído |
| **11** | Salto de Histórico na Busca (Deep Linking) | Suporte ao parâmetro `aroundMessageId` em `loadInboxMessagePage` e nas telas do Inbox, permitindo navegar diretamente para a mensagem encontrada além do limite padrão de 75 mensagens. | A10 / A14 | ✅ Concluído |
| **12** | Motor de Regras Internas Prontas (Alertas) | Módulo `src/lib/sac-pending-rules.ts` com avaliação idempotente de Regra A (retorno vencido), Regra B (transbordo sem dono) e Regra C (etapa sem retorno). Chaves únicas compostas (`sourceKey`) evitam duplicações. Zero envio externo. | A11 | ✅ Concluído |
| **13** | Integração das Regras com o Cron | Execução periódica de `evaluateSacPendingRules` no ciclo de cron (`src/app/api/cron/route.ts`) para cada empresa ativa. | A11 | ✅ Concluído |
| **14** | API de Itens Pendentes (Inbox Alertas) | Endpoints `GET /api/inbox/pending` e `PATCH /api/inbox/pending/[id]` para listar pendências ativas por empresa e marcar como resolvidas/dispensadas. | A11 | ✅ Concluído |
| **15** | Três Abas Laterais no ChatWindow | Reestruturação do painel lateral em 3 abas focadas: **Contexto** (Card SAC + Ações), **Notas Internas** (Histórico e Nova Nota) e **Detalhes** (Janela Meta, Tags, Custos IA, UTMs). | A07 / A08 | ✅ Concluído |
| **16** | Seletor de Respostas Aprovadas no Composer | Botão e dropdown integrado no composer do Inbox (`ChatWindow.tsx`), permitindo buscar, pré-visualizar e preencher o texto com um clique. | A09 | ✅ Concluído |
| **17** | Auditoria e Rastreabilidade Completa | Registro de auditoria em `sac_audit_events` para alterações de contexto, criação e exclusão de notas internas e assunção de casos. | A03 / A07 / A08 | ✅ Concluído |
| **18** | Revalidação de Pausa de Bot antes do Despacho | Em `src/lib/ai-reply.ts`, o despacho da IA relê o estado fresco de `botPaused` imediatamente antes de enviar a resposta, respeitando pausas imediatas de operadores. | A03 | ✅ Concluído |
| **19** | Métricas Operacionais Medidas em `/canais` | Estatísticas em tempo real agregando mensagens por canal, falhas e latência em `src/app/(dashboard)/canais/page.tsx`. | A01 | ✅ Concluído |
| **20** | Preservação Estrita de Integridade e Compatibilidade | Zero quebra de contratos de rotas existentes de WhatsApp, Instagram, Brevo ou Hermes. DDL e migrações aditivas sem remoção destrutiva. | A01-A15 | ✅ Concluído |

---

## 2. Arquivos Criados e Modificados

### Novos Arquivos
- `scripts/sac-lote1-core.test.ts`: Bateria automatizada cobrindo A01 a A12.
- `src/lib/sac-pending-rules.ts`: Motor de regras internas para detecção de retornos vencidos, transbordos e etapas paradas.
- `src/app/api/inbox/[leadId]/claim/route.ts`: Endpoint atômico para assumir atendimento.
- `src/app/api/inbox/[leadId]/notes/route.ts` & `[noteId]/route.ts`: CRUD seguro de notas internas.
- `src/app/api/approved-replies/route.ts` & `[id]/route.ts`: Gestão de respostas rápidas com variáveis.
- `src/app/api/inbox/pending/route.ts` & `[id]/route.ts`: Consulta e resolução de alertas pendentes.

### Arquivos Aprimorados
- `src/lib/outbound-send.ts`: Estados confiáveis de envio e idempotência.
- `src/lib/ai-reply.ts`: Revalidação instantânea de pausa antes do envio.
- `src/lib/company-role.ts`: Proteção RBAC contra escalonamento de privilégios.
- `src/lib/inbox-conversations.ts`: Extração segura de snippets com sanitização XSS.
- `src/lib/inbox-messages.ts`: Suporte à janela `aroundMessageId`.
- `src/app/api/pipeline/columns/route.ts`: Correção da sincronização de `status` e `pipelineStage`.
- `src/app/api/pipeline/[leadId]/route.ts`: Suporte aos campos de contexto SAC no Kanban.
- `src/app/api/inbox/[leadId]/route.ts`: PATCH de contexto e registro de auditoria.
- `src/app/api/cron/route.ts`: Gatilho do motor de regras do SAC.
- `src/components/inbox/ChatWindow.tsx`: Interface renovada com abas (Contexto, Notas Internas, Detalhes) e seletor de Respostas Aprovadas.
- `src/components/inbox/ConversationList.tsx` & `ConversationChatPage.tsx`: Exibição de snippets e navegação profunda por ID de mensagem.
- `src/app/(dashboard)/pipeline/page.tsx`: Mapeamento dos campos SAC nos cards do Kanban.

---

## 3. Diretrizes de Governança
- **Branch Ativa:** `feat/sac-lote1`
- **Regra de Mesclagem:** **Não mesclar na `main`** e **não abrir Pull Request**. A entrega permanece na branch isolada para revisão e validação do Renato antes da incorporação em produção.
- **Lote 2 (Copiloto IA / Áudio):** Permanece provisionado para a próxima etapa assim que amostras reais de produção forem fornecidas.
