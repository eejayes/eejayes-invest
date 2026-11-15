import type { Fundamentals } from './types'

const fundHoldingsMetrics = new Set([
  'pe', 'priceToBook', 'earningsGrowth', 'ewEpsGrowth', 'ewRevenueGrowth',
  'incrementalRoic', 'returnOnEquity', 'sustainableGrowth', 'impliedReturn', 'payoutRatio',
])

export function missingMetricSource(item: Fundamentals, metric: string) {
  const sources = item.sourceLinks
  if (!sources) return undefined
  if (item.isFund) {
    return fundHoldingsMetrics.has(metric)
      ? { url: sources.holdings, label: 'Yahoo Finance holdings' }
      : { url: sources.quote, label: 'Yahoo Finance' }
  }
  const filing = sources.metricFilings?.[metric]
  if (filing) return { url: filing, label: 'SEC filing' }
  if (metric === 'price' || metric === 'region' || metric === 'dividendYield' ||
      (metric === 'impliedReturn' && item.sustainableGrowth != null && item.dividendYield == null)) {
    return { url: sources.quote, label: 'Yahoo Finance' }
  }
  return sources.financials ? { url: sources.financials, label: sources.financialsLabel } : undefined
}
