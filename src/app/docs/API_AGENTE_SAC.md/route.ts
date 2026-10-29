import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

export const dynamic = 'force-static'
export const runtime = 'nodejs'

export async function GET() {
  const markdown = await readFile(join(process.cwd(), 'API_DOCS.md'), 'utf8')

  return new Response(markdown, {
    headers: {
      'Cache-Control': 'public, max-age=0, must-revalidate',
      'Content-Type': 'text/markdown; charset=utf-8',
    },
  })
}
