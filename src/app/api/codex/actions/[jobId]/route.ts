import { NextRequest, NextResponse } from 'next/server'
import { and, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { sacCodexJobs } from '@/lib/db/schema'
import { requireSacActor } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ jobId: string }> }) {
  const actor = await requireSacActor()
  const { jobId } = await params
  const [job] = await db.select().from(sacCodexJobs).where(and(eq(sacCodexJobs.companyId, actor.company.id), eq(sacCodexJobs.jobId, jobId))).limit(1)
  if (!job) return NextResponse.json({ error: 'Job não encontrado neste tenant.' }, { status: 404 })
  return NextResponse.json({ ok: true, job }, { headers: { 'Cache-Control': 'no-store' } })
}
