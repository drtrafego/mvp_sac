import { NextRequest, NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { instagramCommentAutomations } from '@/lib/db/schema'
import { eq, desc } from 'drizzle-orm'
import { requireCompanyRole, AuthError, ForbiddenError, forbiddenResponse } from '@/lib/auth'
import { findInvalidOptionalTextField } from '@/lib/request-validation'
import { MAX_TAG_LENGTH, normalizeTag } from '@/lib/lead-tags'
import {
  INSTAGRAM_COMMENT_DM_TEMPLATE_ID,
  buildInstagramCommentDmTemplateRegistration,
} from '@/lib/instagram-comment-dm-template'

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof AuthError || (
    typeof error === 'object' && error !== null && 'status' in error && error.status === 401
  )
}
function isForbiddenError(error: unknown): boolean { return error instanceof ForbiddenError || (typeof error === 'object' && error !== null && 'status' in error && error.status === 403) }

export async function GET() {
  try {
    const { company } = await requireCompanyRole('admin')
    const rules = await db
      .select()
      .from(instagramCommentAutomations)
      .where(eq(instagramCommentAutomations.companyId, company.id))
      .orderBy(desc(instagramCommentAutomations.createdAt))

    return NextResponse.json({ automations: rules })
  } catch (err: unknown) {
    if (isUnauthorizedError(err)) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    if (isForbiddenError(err)) return forbiddenResponse()
    console.error('[Comment Automations GET Error]:', err)
    return NextResponse.json({ error: 'Erro interno do servidor' }, { status: 500 })
  }
}

export async function POST(req: NextRequest) {
  try {
    const { company } = await requireCompanyRole('admin')
    const parsedBody: unknown = await req.json().catch(() => null)
    if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
      return NextResponse.json({ error: 'O corpo da requisição deve ser um objeto JSON.' }, { status: 400 })
    }
    const body = parsedBody as Record<string, unknown>

    const {
      name,
      mediaId,
      mediaUrl,
      mediaCaption,
      keywords,
      matchType = 'contains',
      dmMessage,
      publicReply,
      hideCommentAfterReply = false,
      activeHoursStart,
      activeHoursEnd,
      isActive,
      requireFollowCheck = false,
      autoTag,
      templateId,
      triggerType = 'comment',
    } = body

    if (typeof triggerType !== 'string' || !['comment', 'direct', 'both'].includes(triggerType)) {
      return NextResponse.json({ error: 'O gatilho deve ser comentário, Direct ou ambos.' }, { status: 400 })
    }
    if ((triggerType === 'direct' || triggerType === 'both') && matchType === 'any') {
      return NextResponse.json({ error: 'O gatilho por palavra no Direct não aceita “Qualquer comentário”. Escolha contém ou exato.' }, { status: 400 })
    }
    if (triggerType === 'direct' && requireFollowCheck === true) {
      return NextResponse.json({ error: 'O gatilho só por Direct não permite exigir que a pessoa siga a conta.' }, { status: 400 })
    }
    if (triggerType === 'direct' && ((typeof publicReply === 'string' && publicReply.trim()) || hideCommentAfterReply === true)) {
      return NextResponse.json({ error: 'O gatilho só por Direct não permite resposta pública nem ocultar comentário.' }, { status: 400 })
    }

    const requestedTemplateId = typeof templateId === 'string' ? templateId.trim() : ''
    if (requestedTemplateId && requestedTemplateId !== INSTAGRAM_COMMENT_DM_TEMPLATE_ID) {
      return NextResponse.json({ error: 'templateId não reconhecido.' }, { status: 400 })
    }
    if (requestedTemplateId && triggerType !== 'comment') {
      return NextResponse.json({ error: 'O template 021126 só pode usar o gatilho de comentário.' }, { status: 400 })
    }
    if ((!name || typeof name !== 'string' || !name.trim()) && !requestedTemplateId) {
      return NextResponse.json({ error: 'O nome da automação é obrigatório.' }, { status: 400 })
    }

    const optionalTextFields = [
      ['mediaId', mediaId],
      ['mediaUrl', mediaUrl],
      ['mediaCaption', mediaCaption],
      ['keywords', keywords],
      ['publicReply', publicReply],
      ['activeHoursStart', activeHoursStart],
      ['activeHoursEnd', activeHoursEnd],
      ['autoTag', autoTag],
    ] as const
    const invalidTextField = findInvalidOptionalTextField(optionalTextFields)
    if (invalidTextField) {
      return NextResponse.json(
        { error: `O campo ${invalidTextField} deve ser um texto.` },
        { status: 400 },
      )
    }
    const rawAutoTag = typeof autoTag === 'string' ? autoTag.trim() : ''
    const normalizedAutoTag = rawAutoTag ? normalizeTag(rawAutoTag) : null
    if (rawAutoTag.length > MAX_TAG_LENGTH) {
      return NextResponse.json({ error: `A tag pode ter no máximo ${MAX_TAG_LENGTH} caracteres.` }, { status: 400 })
    }

    const requestedIsActive = typeof isActive === 'boolean' ? isActive : !requestedTemplateId
    let templateRegistration: ReturnType<typeof buildInstagramCommentDmTemplateRegistration> | null = null
    if (requestedTemplateId) {
      if (typeof publicReply === 'string' && publicReply.trim()) {
        return NextResponse.json({ error: 'O template 021126 não publica resposta em comentário.' }, { status: 400 })
      }
      if (hideCommentAfterReply === true) {
        return NextResponse.json({ error: 'O template 021126 não oculta comentários.' }, { status: 400 })
      }
      try {
        templateRegistration = buildInstagramCommentDmTemplateRegistration({
          mediaId: typeof mediaId === 'string' ? mediaId : null,
          isActive: requestedIsActive,
        })
      } catch (error) {
        return NextResponse.json({ error: error instanceof Error ? error.message : 'Registro de template inválido.' }, { status: 400 })
      }
      if (typeof dmMessage === 'string' && dmMessage.trim() && dmMessage.trim() !== templateRegistration.dmMessage) {
        return NextResponse.json({ error: 'A mensagem do template 021126 é fixa e não pode ser alterada.' }, { status: 400 })
      }
    } else if (!dmMessage || typeof dmMessage !== 'string' || !dmMessage.trim()) {
      return NextResponse.json({ error: 'A mensagem da DM é obrigatória.' }, { status: 400 })
    }

    const [created] = await db
      .insert(instagramCommentAutomations)
      .values({
        companyId: company.id,
        name: templateRegistration?.name ?? (name as string).trim(),
        mediaId: triggerType === 'direct' ? null : typeof mediaId === 'string' ? mediaId.trim() || null : null,
        mediaUrl: triggerType === 'direct' ? null : typeof mediaUrl === 'string' ? mediaUrl.trim() || null : null,
        mediaCaption: triggerType === 'direct' ? null : typeof mediaCaption === 'string' ? mediaCaption.trim() || null : null,
        triggerType,
        keywords: templateRegistration?.keywords ?? (typeof keywords === 'string' ? keywords.trim() || null : null),
        matchType: templateRegistration?.matchType ?? (typeof matchType === 'string' && ['contains', 'exact', 'any'].includes(matchType) ? matchType : 'contains'),
        dmMessage: templateRegistration?.dmMessage ?? (dmMessage as string).trim(),
        publicReply: templateRegistration?.publicReply ?? (typeof publicReply === 'string' ? publicReply.trim() || null : null),
        hideCommentAfterReply: Boolean(hideCommentAfterReply),
        activeHoursStart: typeof activeHoursStart === 'string' ? activeHoursStart.trim() || null : null,
        activeHoursEnd: typeof activeHoursEnd === 'string' ? activeHoursEnd.trim() || null : null,
        isActive: requestedIsActive,
        templateId: templateRegistration?.templateId ?? null,
        templateVariables: templateRegistration?.templateVariables ?? null,
        consentRequired: templateRegistration?.consentRequired ?? false,
        metaWindowHours: templateRegistration?.metaWindowHours ?? 168,
        apiOrigin: templateRegistration?.apiOrigin ?? 'instagram_graph',
        requireFollowCheck: Boolean(requireFollowCheck),
        autoTag: normalizedAutoTag || null,
      })
      .returning()

    return NextResponse.json({ automation: created }, { status: 201 })
  } catch (err: unknown) {
    if (isUnauthorizedError(err)) {
      return NextResponse.json({ error: 'Não autorizado' }, { status: 401 })
    }
    if (isForbiddenError(err)) return forbiddenResponse()
    console.error('[Comment Automations POST Error]:', err)
    return NextResponse.json({ error: 'Erro interno ao criar automação' }, { status: 500 })
  }
}
