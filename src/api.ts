import type { Fundamentals, FundConstituentData, PriceHistory, Range, SearchResult, SymbolDetail, SymbolNewsItem } from './types'

async function request<T>(path: string, attempt = 0): Promise<T> {
  try {
    const response = await fetch(path)
    const body = await response.json()
    if (!response.ok) {
      if (attempt < 2 && [429, 502, 503, 504].includes(response.status)) {
        await new Promise((resolve) => window.setTimeout(resolve, 750 * (2 ** attempt)))
        return request<T>(path, attempt + 1)
      }
      throw new Error(body.error ?? 'Request failed')
    }
    return body as T
  } catch (error) {
    if (attempt < 2 && error instanceof TypeError) {
      await new Promise((resolve) => window.setTimeout(resolve, 750 * (2 ** attempt)))
      return request<T>(path, attempt + 1)
    }
    throw error
  }
}

export const api = {
  search: (query: string) => request<SearchResult[]>(`/api/search?q=${encodeURIComponent(query)}`),
  history: (symbol: string, range: string) =>
    request<PriceHistory>(
      `/api/history/${encodeURIComponent(symbol)}?range=${range}`,
    ),
  fundamentals: (symbol: string) =>
    request<Fundamentals>(`/api/fundamentals/${encodeURIComponent(symbol)}`),
  detail: (symbol: string) =>
    request<SymbolDetail>(`/api/detail/${encodeURIComponent(symbol)}`),
  news: (symbol: string, range: Range) =>
    request<{ symbol: string; items: SymbolNewsItem[] }>(
      `/api/news/${encodeURIComponent(symbol)}?range=${range}`,
    ),
  fundConstituents: (symbol: string) =>
    request<FundConstituentData>(`/api/fund-constituents/${encodeURIComponent(symbol)}`),
  randomSymbols: (options: {
    count: number
    pool: 'all' | 'volume'
    regions: string[]
    minMarketCap: string
    maxMarketCap: string
  }) => {
    const params = new URLSearchParams({
      count: String(options.count),
      pool: options.pool,
      regions: options.regions.join(','),
      minMarketCap: options.minMarketCap,
      maxMarketCap: options.maxMarketCap,
    })
    return request<{ symbols: SearchResult[]; universeSize: number; refreshedAt: string; pool: string }>(
      `/api/random-symbols?${params}`,
    )
  },
}
