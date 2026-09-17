import { NextRequest, NextResponse } from 'next/server'

export async function GET(request: NextRequest) {
  const response = NextResponse.redirect(new URL('/handler/sign-in', request.url))
  response.cookies.delete('agent_auth_session')
  response.cookies.delete('admin_viewing')
  return response
}

export async function POST(request: NextRequest) {
  return GET(request)
}
