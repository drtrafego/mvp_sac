import { readFileSync } from 'node:fs'
import { neon } from '@neondatabase/serverless'

const env = readFileSync(new URL('../.env.local', import.meta.url), 'utf-8')
for (const line of env.split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/)
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '')
}

const sql = neon(process.env.DATABASE_URL)

await sql`
  CREATE TABLE IF NOT EXISTS webhook_received (
    id SERIAL PRIMARY KEY,
    company_id INTEGER REFERENCES companies(id) ON DELETE CASCADE,
    slug TEXT,
    source TEXT DEFAULT 'hotmart',
    event TEXT,
    processed BOOLEAN DEFAULT false,
    skip_reason TEXT,
    error_message TEXT,
    lead_id INTEGER,
    raw_body JSONB,
    headers JSONB,
    received_at TIMESTAMP DEFAULT NOW()
  )
`
await sql`CREATE INDEX IF NOT EXISTS webhook_received_company_id_idx ON webhook_received(company_id)`
await sql`CREATE INDEX IF NOT EXISTS webhook_received_received_at_idx ON webhook_received(received_at DESC)`
console.log('OK: tabela webhook_received criada')
