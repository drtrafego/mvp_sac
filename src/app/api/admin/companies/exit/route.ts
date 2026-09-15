import { NextResponse } from 'next/server'
import { requireAdmin, unauthorizedResponse } from '@/lib/auth'
import { cookies } from 'next/headers'

export async function POST() {
  try {
    await requireAdmin()
  } catch {
    return unauthorizedResponse()
  }

  const cookieStore = await cookies()
  cookieStore.delete('admin_viewing')

  return NextResponse.json({ ok: true })
}
