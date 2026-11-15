import type { SearchResult } from './types'

export function submittedSymbol(query: string, results: SearchResult[]) {
  const text = query.trim()
  const normalized = text.toUpperCase()
  const exactSymbol = results.find((result) => result.symbol.toUpperCase() === normalized)
  if (exactSymbol) return exactSymbol.symbol
  const exactName = results.find((result) => result.name.toUpperCase() === normalized)
  if (exactName?.symbol.toUpperCase() === `${normalized}.NE`) return text
  return exactName?.symbol ?? text
}
