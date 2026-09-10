# Migration multicanal (rascunho não aplicado)

Base considerada: schema atual do Minerador, especialmente `leads`,
`outreach_threads`, `outreach_messages`, `pipeline_stages`, `activities` e
`events`. O desenho é paralelo e aditivo para não alterar os fluxos existentes;
eventos multicanal podem apontar para uma `activity` já existente.

Arquivos:

- `migration_multicanal.sql`: identidades por canal, threads, mensagens com duas
  chaves de dedupe, origens, eventos, regras de avanço e CRM avançado com pontos
  de contato, perfil enriquecido, tags e merges auditáveis.
- `001_multicanal_down.sql`: rollback estrutural na ordem inversa.
- `validate_migration.py`: validação somente textual; não abre conexão.

Antes de qualquer aplicação, substituir literalmente `<schema>` por um
identificador PostgreSQL já validado (por exemplo `minerador_scrapling`) e
revisar em ambiente descartável. Não fazer interpolação com entrada externa.

A função `advance_pipeline_automatically` só aceita estágio do mesmo tenant e
só troca o card quando `position` aumenta. Assim, automação não retrocede uma
movimentação manual. A identidade só é unificada quando o adapter fornece uma
ligação confiável; nome semelhante nunca é critério de merge.

Validação local:

    python3 validate_migration.py

O DOWN é reversível quanto ao schema, mas removerá os novos dados. Antes de um
rollback real, exportar as onze tabelas multicanal. A coluna nova
`merged_into_lead_id` também é removida; nenhuma coluna preexistente é alterada.
