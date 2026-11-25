import { NextRequest, NextResponse } from 'next/server'
import { and, desc, eq } from 'drizzle-orm'
import { db } from '@/lib/db'
import { recoveryLeads, sacApprovedReplies, settings } from '@/lib/db/schema'
import { requireCompany } from '@/lib/auth'
import { loadApprovedMetaTemplates } from '@/lib/meta-templates'
import { normalizeInboxThreadChannel } from '@/lib/inbox-messages'

export const dynamic = 'force-dynamic'

function noStoreJson(body: unknown, init?: ResponseInit): NextResponse {
  const response = NextResponse.json(body, init)
  response.headers.set('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
  response.headers.set('Pragma', 'no-cache')
  response.headers.set('Expires', '0')
  return response
}

type Params = { params: Promise<{ leadId: string }> }

export async function GET(req: NextRequest, { params }: Params): Promise<NextResponse> {
  const { leadId } = await params
  const id = Number.parseInt(leadId, 10)
  if (!Number.isSafeInteger(id) || id <= 0) return noStoreJson({ error: 'ID inválido.' }, { status: 400 })

  const rawThread = new URL(req.url).searchParams.get('thread')
  const thread = normalizeInboxThreadChannel(rawThread)
  if (rawThread && !thread) return noStoreJson({ error: 'Canal inválido.' }, { status: 400 })
  const effectiveThread = thread ?? 'whatsapp'
  const company = await requireCompany()
  const [[lead], replies, [config]] = await Promise.all([
    db.select({ id: recoveryLeads.id, channel: recoveryLeads.channel })
      .from(recoveryLeads)
      .where(and(eq(recoveryLeads.id, id), eq(recoveryLeads.companyId, company.id)))
      .limit(1),
    db.select({
      id: sacApprovedReplies.id,
      title: sacApprovedReplies.title,
      shortcut: sacApprovedReplies.shortcut,
      body: sacApprovedReplies.body,
      variables: sacApprovedReplies.variables,
      approvalState: sacApprovedReplies.approvalState,
    })
      .from(sacApprovedReplies)
      .where(and(eq(sacApprovedReplies.companyId, company.id), eq(sacApprovedReplies.approvalState, 'approved')))
      .orderBy(desc(sacApprovedReplies.updatedAt)),
    db.select({
      whatsappProvider: settings.whatsappProvider,
      metaWabaId: settings.metaWabaId,
      metaAccessToken: settings.metaAccessToken,
      metaPhoneNumberId: settings.metaPhoneNumberId,
    })
      .from(settings)
      .where(eq(settings.companyId, company.id))
      .limit(1),
  ])

  if (!lead) return noStoreJson({ error: 'Lead não encontrado.' }, { status: 404 })

  // A Meta template belongs to the company's WABA and can only be used in a
  // WhatsApp thread. The phone number guard prevents showing templates when
  // this tenant has no configured sender for the current channel.
  const metaState = effectiveThread === 'whatsapp' && config?.metaPhoneNumberId
    ? await loadApprovedMetaTemplates(config)
    : { kind: 'disabled' as const, templates: [], message: 'Templates Meta só ficam disponíveis em uma conversa WhatsApp com número configurado.' }

  return noStoreJson({
    replies,
    templates: metaState.templates,
    metaState: metaState.kind,
    metaMessage: metaState.message,
    channel: effectiveThread,
  })
}
