import { NextResponse } from 'next/server'
import { requireCompanyRole, unauthorizedResponse, forbiddenResponse, ForbiddenError } from '@/lib/auth'
import { db } from '@/lib/db'
import { companyMembers } from '@/lib/db/schema'
import { eq, and } from 'drizzle-orm'

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Excluir/promover/rebaixar membro exige administrador da empresa (SAC Lote 1, 5.5).
    const { company } = await requireCompanyRole('admin')
    const { id } = await params
    const memberId = parseInt(id)

    if (isNaN(memberId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const [deleted] = await db
      .delete(companyMembers)
      .where(and(eq(companyMembers.id, memberId), eq(companyMembers.companyId, company.id)))
      .returning()

    if (!deleted) {
      return NextResponse.json({ error: 'Membro não encontrado' }, { status: 404 })
    }

    return NextResponse.json({ ok: true })
  } catch (err) {
    if (err instanceof ForbiddenError) return forbiddenResponse()
    return unauthorizedResponse()
  }
}

export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    // Excluir/promover/rebaixar membro exige administrador da empresa (SAC Lote 1, 5.5).
    const { company } = await requireCompanyRole('admin')
    const { id } = await params
    const memberId = parseInt(id)
    const { role } = await req.json()

    if (isNaN(memberId)) {
      return NextResponse.json({ error: 'ID inválido' }, { status: 400 })
    }

    const validRoles = ['admin', 'membro']
    if (!validRoles.includes(role)) {
      return NextResponse.json({ error: 'Cargo inválido' }, { status: 400 })
    }

    const [updated] = await db
      .update(companyMembers)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(companyMembers.id, memberId), eq(companyMembers.companyId, company.id)))
      .returning()

    if (!updated) {
      return NextResponse.json({ error: 'Membro não encontrado' }, { status: 404 })
    }

    return NextResponse.json({ member: updated })
  } catch (err) {
    if (err instanceof ForbiddenError) return forbiddenResponse()
    return unauthorizedResponse()
  }
}
