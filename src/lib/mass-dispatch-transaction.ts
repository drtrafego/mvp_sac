import { drizzle as postgresDrizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

export type ConfirmationExecutor = {
  execute: <T>(query: unknown) => Promise<T>
}

export async function withConfirmationTransaction<T>(fn: (tx: ConfirmationExecutor) => Promise<T>): Promise<T> {
  const client = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, idle_timeout: 5 })
  try {
    const transactionalDb = postgresDrizzle(client)
    return await transactionalDb.transaction(tx => fn(tx as unknown as ConfirmationExecutor))
  } finally {
    await client.end({ timeout: 1 }).catch(() => {})
  }
}
