import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { resolve } from 'node:path'

// PostgreSQL WASM is a disposable test dependency; never connects to DATABASE_URL.
const pgliteModule = process.env.PGLITE_MODULE || '@electric-sql/pglite'
const hasPgCode = (code: string) => (error: unknown) => (
  typeof error === 'object' && error !== null && 'code' in error && error.code === code
)

async function fixture() {
  const { PGlite } = await import(pgliteModule)
  const pg = new PGlite()
  await pg.exec(`
    CREATE TABLE companies (id serial PRIMARY KEY);
    CREATE TABLE settings (id serial PRIMARY KEY, company_id integer REFERENCES companies(id));
    CREATE TABLE company_members (id serial PRIMARY KEY, company_id integer REFERENCES companies(id), stack_auth_user_id text);
    CREATE TABLE recovery_leads (id serial PRIMARY KEY, company_id integer REFERENCES companies(id), phone text, status text);
    CREATE TABLE whatsapp_messages (id serial PRIMARY KEY, company_id integer REFERENCES companies(id), lead_id integer REFERENCES recovery_leads(id), content text);
    INSERT INTO companies VALUES (1),(2);
    INSERT INTO settings (company_id) VALUES (1),(2);
    INSERT INTO company_members (company_id,stack_auth_user_id) VALUES (1,'original-owner');
    INSERT INTO recovery_leads (company_id,phone,status) VALUES (1,'5511999990000','converted');
    INSERT INTO whatsapp_messages (company_id,lead_id,content) VALUES (1,1,'Mensagem histórica preservada');
  `)
  const migrations = await Promise.all([
    readFile(resolve('drizzle/0029_sac_lote1_core.sql'), 'utf8'),
    readFile(resolve('drizzle/0030_sac_lote1_reconciliation.sql'), 'utf8'),
  ])
  return { pg, migrations, async migrate() { for (const source of migrations) await pg.exec(source) } }
}

async function main() {
await test('0029+0030 apply twice and preserve legacy records without invented acceptance', async () => {
  const f = await fixture()
  try {
    await f.migrate(); await f.migrate()
    const { rows } = await f.pg.query('SELECT m.content,m.send_state,l.status,l.sac_case_episode FROM whatsapp_messages m JOIN recovery_leads l ON l.id=m.lead_id')
    assert.deepEqual(rows, [{ content: 'Mensagem histórica preservada', send_state: null, status: 'converted', sac_case_episode: 1 }])
    const { rows: settings } = await f.pg.query('SELECT sac_followup_stage_ids FROM settings ORDER BY id')
    assert.deepEqual(settings, [{ sac_followup_stage_ids: [] }, { sac_followup_stage_ids: [] }])
    const { rows: defaults } = await f.pg.query("SELECT column_default FROM information_schema.columns WHERE table_name='whatsapp_messages' AND column_name='send_state'")
    assert.equal(defaults[0].column_default, null)
    const { rows: replyDefaults } = await f.pg.query("SELECT column_default FROM information_schema.columns WHERE table_name='sac_approved_replies' AND column_name='approval_state'")
    assert.ok(String(replyDefaults[0].column_default).includes('draft'))
  } finally { await f.pg.close() }
})

await test('request keys and member identity are unique within each company, not across companies', async () => {
  const f = await fixture()
  try {
    await f.migrate()
    await f.pg.query("INSERT INTO whatsapp_messages(company_id,client_request_id,outbound_payload_hash) VALUES (1,'same-key','hash-a'),(2,'same-key','hash-b')")
    await assert.rejects(() => f.pg.query("INSERT INTO whatsapp_messages(company_id,client_request_id) VALUES (1,'same-key')"), hasPgCode('23505'))
    await f.pg.query("INSERT INTO company_members(company_id,stack_auth_user_id) VALUES (2,'original-owner')")
    await assert.rejects(() => f.pg.query("INSERT INTO company_members(company_id,stack_auth_user_id) VALUES (1,'original-owner')"), hasPgCode('23505'))
  } finally { await f.pg.close() }
})

await test('request-message FK rejects nonexistent references and clears deleted references', async () => {
  const f = await fixture()
  try {
    await f.migrate()
    await assert.rejects(() => f.pg.query('UPDATE recovery_leads SET request_message_id=999 WHERE id=1'), hasPgCode('23503'))
    await f.pg.query('UPDATE recovery_leads SET request_message_id=1 WHERE id=1')
    await f.pg.query('DELETE FROM whatsapp_messages WHERE id=1')
    const { rows } = await f.pg.query('SELECT request_message_id,status FROM recovery_leads WHERE id=1')
    assert.deepEqual(rows, [{ request_message_id: null, status: 'converted' }])
  } finally { await f.pg.close() }
})

await test('legacy duplicate memberships stop migration visibly without deleting any identity', async () => {
  const f = await fixture()
  try {
    await f.pg.query("INSERT INTO company_members(company_id,stack_auth_user_id) VALUES (1,'original-owner')")
    await f.pg.exec(f.migrations[0])
    await assert.rejects(() => f.pg.exec(f.migrations[1]), hasPgCode('23505'))
    const { rows } = await f.pg.query("SELECT count(*)::int AS total FROM company_members WHERE stack_auth_user_id='original-owner'")
    assert.equal(rows[0].total, 2)
  } finally { await f.pg.close() }
})
}
main().catch(error => { console.error(error); process.exitCode = 1 })
