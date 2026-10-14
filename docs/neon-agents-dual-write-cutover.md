# Migração do banco central dos agentes para Neon

## Premissas e escopo

O Supabase atual é a fonte operacional até o cutover concluído. O Neon disponível é um snapshot antigo e não pode receber escrita de produção, nem ser usado como verdade, antes de um restore validado. Esta fase não altera DSN, cron, runtime, agentes ou dados.

As únicas variáveis aceitas pelos scripts desta pasta são `AGENTS_SOURCE_DATABASE_URL` e `AGENTS_TARGET_DATABASE_URL`. Elas entram pelo ambiente do processo, nunca por arquivo versionado, argumento, log ou artefato.

## Evidência obrigatória antes de qualquer escrita

1. Executar `scripts/neon-migration/inventory-compare.sh` e arquivar o diretório emitido. O script é read-only, coleta schema, contagem exata por tabela e máximos de colunas numéricas e temporais candidatas.
2. Gerar, revisar e aprovar `scripts/neon-migration/generate-restore-plan.sh`. Ele exige uma URL direta Neon e recusa host `-pooler`.
3. Restaurar manualmente em branch/banco Neon vazio, fora do escopo deste repositório. Reexecutar o inventário e exigir `COMPATÍVEL`.
4. Registrar dono, horário, hashes do dump e dos artefatos, versão de cada consumidor e plano de rollback.

## Contrato por consumidor

| Consumidor | Fase dual write | Leitura antes do cutover | Cutover | Rollback |
| --- | --- | --- | --- | --- |
| SAC Next.js, API e jobs | Escreve transacionalmente no Supabase, envia a mesma mutação com idempotency key para Neon e registra falha sem esconder a escrita primária. | Supabase é a única leitura operacional. Neon recebe reconciliação por chave primária, contagem e máximo. | Trocar leituras para Neon somente após backlog zero, inventário compatível e soak aprovado. | Voltar somente leituras ao Supabase, manter captura de divergências e reparar Neon sem replay cego. |
| Hermes gateway e workers PostgreSQL v2 | Usar a mesma chave de evento/outbox nos dois bancos. O ack externo só ocorre depois da escrita primária e da outbox durável. | Supabase, sem fallback de leitura implícito. | Neon passa a primário por uma configuração versionada e reversível, aplicada numa janela. | Reverter a configuração para Supabase; bloquear consumidores que não preservem idempotência. |
| Conectores, webhooks e cron | Não trocam DSN durante dual write. Cada evento conserva `event_id`/idempotency key e tem contador de sucesso, erro e atraso por destino. | Supabase. | Atualizar cada job de forma canária, com métricas por consumidor. | Reapontar o job canário para Supabase e reprocessar apenas eventos comprovadamente ausentes. |
| SAC analytics e painel | Recebe dados do banco primário definido para o período, sem somar fontes. | Supabase. | Validar mesmas métricas por empresa, período e agente antes de apontar o painel ao Neon. | Retornar a leitura à fonte Supabase e preservar a janela de comparação. |

## Gates

1. **Preparação:** inventário e restore compatíveis, dump testado, branch Neon vazio confirmado.
2. **Dual write:** 100% das mutações carregam idempotency key, backlog de réplica observável e reconciliação sem divergência pendente.
3. **Canário:** um consumidor reversível, leitura controlada e métricas comparadas por pelo menos uma janela operacional completa.
4. **Cutover:** dono aprova, writes pausadas apenas se necessário, conexões diretas usadas no restore, métricas e health checks aprovados.
5. **Soak:** Neon é primário por janela acordada, erros e atraso dentro do baseline; Supabase permanece recuperável durante a retenção acordada.

## Regras de rollback

Rollback muda o roteamento de leitura e escrita de volta para o Supabase, não apaga o Neon e não executa restore automático. Toda mutação aceita durante uma falha precisa estar identificada para reconciliação posterior. Se a evidência de idempotência não existir, parar o consumidor afetado e investigar antes de replay.
