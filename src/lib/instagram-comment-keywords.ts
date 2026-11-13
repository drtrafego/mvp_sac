export function normalizeCommentKeywordText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Verifica palavras-chave como texto literal, nunca como regex do usuário. */
export function matchesCommentKeywords(
  commentText: string,
  keywordsStr: string | null | undefined,
  matchType: string,
): { matched: boolean; matchedKeyword?: string } {
  if (matchType === 'any') return { matched: true, matchedKeyword: '*' }
  if (!keywordsStr || !keywordsStr.trim()) return { matched: false }

  const normalizedComment = normalizeCommentKeywordText(commentText)
  const keywordsList = keywordsStr
    .split(',')
    .map(keyword => normalizeCommentKeywordText(keyword))
    .filter(Boolean)

  if (matchType === 'exact') {
    const matchedKeyword = keywordsList.find(keyword => normalizedComment === keyword)
    return matchedKeyword ? { matched: true, matchedKeyword } : { matched: false }
  }

  for (const keyword of keywordsList) {
    const regex = new RegExp(`(^|\\s|[.,!?;])${escapeRegExp(keyword)}($|\\s|[.,!?;])`, 'i')
    if (regex.test(normalizedComment)) {
      return { matched: true, matchedKeyword: keyword }
    }
  }

  return { matched: false }
}
