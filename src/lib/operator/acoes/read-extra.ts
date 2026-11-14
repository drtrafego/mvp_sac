import { sql } from 'drizzle-orm'
import { db } from '@/lib/db'
// Leitura prevista no perfil da Fatia 2; escritas de story continuam na Fatia 3.
export async function listarRegrasStory(companyId: number) {
  const result = await db.execute(sql`SELECT id, name, keywords, match_type, story_id, mode, is_active
    FROM instagram_story_automations WHERE company_id = ${companyId} ORDER BY id LIMIT 100`)
  return { kind: 'listar_regras_story', data: result.rows }
}
