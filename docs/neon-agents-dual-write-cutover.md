# Migração do banco central dos agentes para Neon

## Premissas e escopo

O Supabase atual é a fonte operacional até o cutover concluído. O Neon disponível é um snapshot antigo e não pode receber escrita de produção, nem ser usado como verdade, antes de um restore validado. Esta fase não altera DSN, cron, runtime, agentes ou dados.

As únicas variáveis de conexão aceitas pelos scripts desta pasta são `AGENTS_SOURCE_DATABASE_URL` e `AGENTS_TARGET_DATABASE_URL`. Elas entram pelo ambiente do processo inicial, nunca por arquivo versionado, argumento, log ou artefato. Antes de chamar clientes PostgreSQL, os scripts convertem cada URL em `PGPASSFILE` local com permissão 600 e removem as URLs do ambiente dos filhos. Das opções libpq da URL, aceitam somente `sslmode` e `channel_binding`, que é preservado em `PGCHANNELBINDING`.

## Evidência obrigatória antes de qualquer escrita

1. Executar `scripts/neon-migration/inventory-compare.sh` e arquivar o diretório emitido. O script é read-only, coleta schema, contagem exata por tabela e máximos de colunas numéricas e temporais candidatas.
2. Gerar, revisar e aprovar `scripts/neon-migration/generate-restore-plan.sh`. O plano só roda com `--execute-approved`, revalida Neon direto, recusa host `-pooler`, consulta o destino em modo read-only para exigir ausência de tabelas de usuário e só cria dump novo, exclusivamente, em `approved-dumps`.
3. Restaurar manualmente em branch/banco Neon vazio, fora do escopo deste repositório. Reexecutar o inventário e exigir `COMPATÍVEL`.
4. Registrar dono, horário, hashes do dump e dos artefatos, versão de cada consumidor e plano de rollback.

## Contrato por consumidor

| Consumidor | Fase dual write | Leitura antes do cutover | Cutover | Rollback |
| --- | --- | --- | --- | --- |
| SAC Next.js, API e jobs | Escreve transacionalmente no Supabase, envia a mesma mutação com idempotency key para Neon e registra falha sem esconder a escrita primária. | Supabase é a única leitura operacional. Neon recebe reconciliação por chave primária, contagem e máximo. | Trocar leituras para Neon somente após backlog zero, inventário compatível e soak aprovado. | Drenar outbox Neon para Supabase com idempotency key e comprovar reconciliação. Sem outbox íntegra, pausar o consumidor, reconciliar e só então voltar. |
| Hermes gateway e workers PostgreSQL v2 | Usar a mesma chave de evento/outbox nos dois bancos. O ack externo só ocorre depois da escrita primária e da outbox durável. | Supabase, sem fallback de leitura implícito. | Neon passa a primário por uma configuração versionada e reversível, aplicada numa janela. | Drenar outbox Neon para Supabase de modo idempotente; se não houver prova de entrega, pausar ingressão, reconciliar por evento e somente então reapontar. |
| Conectores, webhooks e cron | Não trocam DSN durante dual write. Cada evento conserva `event_id`/idempotency key e tem contador de sucesso, erro e atraso por destino. | Supabase. | Atualizar cada job de forma canária, com métricas por consumidor. | Pausar o job se a outbox/replay idempotente não cobrir o intervalo, reconciliar eventos ausentes e depois retornar ao Supabase. |
| SAC analytics e painel | Recebe dados do banco primário definido para o período, sem somar fontes. | Supabase. | Validar mesmas métricas por empresa, período e agente antes de apontar o painel ao Neon. | Voltar a leitura ao Supabase somente após outbox/replay ou pausa e reconciliação preservarem a janela analítica. |

## Gates

1. **Preparação:** inventário e restore compatíveis, dump testado, branch Neon vazio confirmado.
2. **Dual write:** 100% das mutações carregam idempotency key, backlog de réplica observável e reconciliação sem divergência pendente.
3. **Canário:** um consumidor reversível, leitura controlada e métricas comparadas por pelo menos uma janela operacional completa.
4. **Cutover:** dono aprova, writes pausadas apenas se necessário, conexões diretas usadas no restore, métricas e health checks aprovados.
5. **Soak:** Neon é primário por janela acordada, erros e atraso dentro do baseline; Supabase permanece recuperável durante a retenção acordada.

## Regras de rollback

Rollback muda o roteamento de leitura e escrita de volta para o Supabase, não apaga o Neon e não executa restore automático. Antes de reverter, o consumidor precisa drenar a outbox Neon para o Supabase por chave idempotente e comprovar a reconciliação. Se essa outbox ou prova não existir, pausar o consumidor afetado, reconciliar o intervalo por evento e somente então retomar no Supabase.
