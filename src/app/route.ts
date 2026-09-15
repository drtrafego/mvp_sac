import { NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const filePath = path.join(process.cwd(), 'public', 'index.html')
    const html = fs.readFileSync(filePath, 'utf-8')
    return new NextResponse(html, {
      status: 200,
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
      },
    })
  } catch (error) {
    return new NextResponse('Erro ao carregar o painel SAC Hermes', { status: 500 })
  }
}
