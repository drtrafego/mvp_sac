import postgres from 'postgres'

export const CRON_DISPATCH_ADVISORY_LOCK_KEY = 77422001

export async function tryAcquireCronDispatchLock(): Promise<any | null> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, idle_timeout: 60, prepare: false })
  try {
    const [row] = await client<{ locked: boolean }[]>`
      SELECT pg_try_advisory_lock(${CRON_DISPATCH_ADVISORY_LOCK_KEY}) AS locked
    `
    if (row?.locked === true) return client
    await client.end({ timeout: 1 })
    return null
  } catch (err) {
    await client.end({ timeout: 1 }).catch(() => {})
    throw err
  }
}

export async function releaseCronDispatchLock(client: any): Promise<void> {
  try {
    await client`SELECT pg_advisory_unlock(${CRON_DISPATCH_ADVISORY_LOCK_KEY})`
  } catch (err) {
    console.error('[cron] ALERTA: falha ao liberar advisory lock do executor', err)
  } finally {
    await client.end({ timeout: 1 }).catch(() => {})
  }
}
