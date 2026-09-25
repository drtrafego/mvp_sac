-- Documental (a migração REAL roda em ensureSchema(), src/lib/db/index.ts,
-- mesmo padrão do resto do projeto — ver comentário no topo daquele
-- arquivo). Migração aditiva (expand): tabela nova, nenhuma coluna de
-- recovery_leads é alterada.
--
-- Tags livres de lead (25/09/2026, pedido do Gastão via Renato): "queria uma
-- tag pessoa para eu colocar nas pessoas do sac que são pessoas que a Nina
-- não vai responder" + "vale para todos os canais". Sistema genérico de
-- tags (múltiplas por lead, texto livre) com uma tag especial 'pessoa' que
-- pausa o bot de IA e avisa a ponte da Nina para não responder o contato
-- fora do SAC também. Ver comentários completos em src/lib/db/schema.ts
-- (leadTags) e src/app/api/leads/[leadId]/tags/route.ts.

CREATE TABLE IF NOT EXISTS "lead_tags" (
  "id" SERIAL PRIMARY KEY,
  "lead_id" INTEGER NOT NULL REFERENCES "recovery_leads"("id") ON DELETE CASCADE,
  "tag" TEXT NOT NULL,
  "created_at" TIMESTAMP DEFAULT NOW(),
  "created_by" TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS "lead_tags_lead_tag_unique" ON "lead_tags" ("lead_id", "tag");
CREATE INDEX IF NOT EXISTS "lead_tags_tag_idx" ON "lead_tags" ("tag");
