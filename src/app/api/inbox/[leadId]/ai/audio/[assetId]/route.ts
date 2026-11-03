import { and, eq } from 'drizzle-orm'
import { NextRequest, NextResponse } from 'next/server'
import { requireSacActor } from '@/lib/auth'
import { db } from '@/lib/db'
import { sacAudioAssets } from '@/lib/db/schema'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type Params = { params: Promise<{ leadId: string; assetId: string }> }

export async function GET(_req: NextRequest, { params }: Params) {
  const { leadId: rawLeadId, assetId: rawAssetId } = await params
  const leadId = Number.parseInt(rawLeadId, 10)
  const assetId = Number.parseInt(rawAssetId, 10)
  if (!Number.isSafeInteger(leadId) || !Number.isSafeInteger(assetId) || leadId <= 0 || assetId <= 0) return NextResponse.json({ error: 'Áudio inválido.' }, { status: 400 })
  const actor = await requireSacActor()
  const [asset] = await db.select({ mimeType: sacAudioAssets.mimeType, filename: sacAudioAssets.filename, audioData: sacAudioAssets.audioData }).from(sacAudioAssets).where(and(eq(sacAudioAssets.id, assetId), eq(sacAudioAssets.leadId, leadId), eq(sacAudioAssets.companyId, actor.company.id))).limit(1)
  if (!asset) return NextResponse.json({ error: 'Áudio não encontrado.' }, { status: 404 })
  return new NextResponse(new Uint8Array(asset.audioData), {
    status: 200,
    headers: {
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.audioData.byteLength),
      'Content-Disposition': `inline; filename="${asset.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}"`,
      'Cache-Control': 'private, no-store',
    },
  })
}
