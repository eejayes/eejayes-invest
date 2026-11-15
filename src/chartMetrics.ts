import type { ChartMetric, Fundamentals, PricePoint } from './types'

type Quarter = Fundamentals['quarters'][number]
type ChartRow = Record<string, string | number>
type Histories = Record<string, PricePoint[]>
type ReportEvent = { date: string; timestamp: number; value: number; assumptions?: string[] }

const reportMetrics: ChartMetric[] = [
  'earningsGrowth', 'ewEpsGrowth', 'ewRevenueGrowth', 'sustainableGrowth', 'incrementalRoic', 'priceToNetTangibleAssets',
]

export function isReportMetric(metric: ChartMetric) {
  return reportMetrics.includes(metric)
}

export function isPercentMetric(metric: ChartMetric) {
  return metric !== 'price' && metric !== 'pe' && metric !== 'priceToBook' && metric !== 'priceToNetTangibleAssets'
}

function growth(current: number, previous: number) {
  return previous === 0 ? null : ((current - previous) / Math.abs(previous)) * 100
}

function weightedGrowth(values: Array<number | null>) {
  const valid = values.filter((value): value is number => value != null)
  let weighted: number | null = null
  for (let i = 1; i < valid.length; i++) {
    const change = growth(valid[i], valid[i - 1])
    if (change != null) weighted = weighted == null ? change : 0.45 * change + 0.55 * weighted
  }
  return weighted
}

function trailingValues(quarters: Quarter[]) {
  const eps = quarters.map((quarter) => quarter.eps).filter((value): value is number => value != null).slice(-4)
  const dividendQuarters = quarters.slice(-4)
  const ttmEps = eps.reduce((sum, value) => sum + value, 0)
  const dividends = dividendQuarters.length === 4
    ? dividendQuarters.reduce((sum, quarter) => sum + (quarter.dividendsPerShare ?? 0), 0)
    : null
  const book = [...quarters].reverse().find((quarter) => quarter.bookValuePerShare != null)?.bookValuePerShare ?? null
  const sustainableGrowth = eps.length === 4 && ttmEps > 0 && book != null && book > 0 && dividends != null
    ? ((ttmEps - dividends) / book) * 100
    : null
  return { book, dividends, sustainableGrowth }
}

function incrementalRoic(quarters: Quarter[]) {
  if (quarters.length < 8) return null
  const nopat = (window: Quarter[]) => {
    const operating = window.map((quarter) => quarter.operatingIncome)
    const pretax = window.map((quarter) => quarter.preTaxIncome)
    const taxes = window.map((quarter) => quarter.incomeTaxExpense)
    if (!operating.every((value): value is number => value != null) ||
        !pretax.every((value): value is number => value != null) ||
        !taxes.every((value): value is number => value != null)) return null
    const totalOperating = operating.reduce((sum, value) => sum + value, 0)
    const totalPretax = pretax.reduce((sum, value) => sum + value, 0)
    const totalTaxes = taxes.reduce((sum, value) => sum + value, 0)
    if (totalPretax <= 0 || totalTaxes < 0 || totalTaxes > totalPretax) return null
    return totalOperating * (1 - totalTaxes / totalPretax)
  }
  const last = quarters.length - 1
  const current = nopat(quarters.slice(last - 3, last + 1))
  const previous = nopat(quarters.slice(last - 7, last - 3))
  const currentCapital = quarters[last].investedCapital
  const previousCapital = quarters[last - 4].investedCapital
  if (current == null || previous == null || currentCapital == null || previousCapital == null || currentCapital <= previousCapital) return null
  return ((current - previous) / (currentCapital - previousCapital)) * 100
}

function reportValue(quarters: Quarter[], metric: ChartMetric) {
  const eps = quarters.map((quarter) => quarter.eps).filter((value): value is number => value != null)
  switch (metric) {
    case 'earningsGrowth':
      return eps.length >= 2 ? growth(eps[eps.length - 1], eps[eps.length - 2]) : null
    case 'ewEpsGrowth':
      return weightedGrowth(quarters.map((quarter) => quarter.eps))
    case 'ewRevenueGrowth':
      return weightedGrowth(quarters.map((quarter) => quarter.revenue))
    case 'sustainableGrowth':
      return trailingValues(quarters).sustainableGrowth
    case 'incrementalRoic':
      return incrementalRoic(quarters)
    default:
      return null
  }
}

export function reportEvents(
  quarters: Quarter[],
  metric: ChartMetric,
  tangibleReports: NonNullable<Fundamentals['tangibleAssetReports']> = [],
  prices: PricePoint[] = [],
  currencyRateToUsd = 1,
): ReportEvent[] {
  if (!isReportMetric(metric)) return []
  if (metric === 'priceToNetTangibleAssets') {
    return tangibleReports.flatMap((report) => {
      const price = [...prices].reverse().find((point) => point.date <= report.date && Number.isFinite(point.price) && point.price > 0)
      const value = price && report.value > 0 ? price.price * currencyRateToUsd / report.value : NaN
      return Number.isFinite(value) && value > 0
        ? [{ date: report.date, timestamp: Date.parse(`${report.date}T00:00:00Z`), value, assumptions: report.assumptions }]
        : []
    })
      .sort((a, b) => a.timestamp - b.timestamp)
  }
  const dates = [...new Set(quarters.map((quarter) => quarter.filed))].sort()
  return dates.flatMap((date) => {
    const value = reportValue(quarters.filter((quarter) => quarter.filed <= date), metric)
    return value == null || !Number.isFinite(value)
      ? []
      : [{ date, timestamp: Date.parse(`${date}T00:00:00Z`), value }]
  })
}

export function lastReportAt(events: ReturnType<typeof reportEvents>, timestamp: number) {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].timestamp <= timestamp) return events[index]
  }
  return undefined
}

export function mergeSeries(symbols: string[], histories: Histories, fundamentals: Record<string, Fundamentals>, metric: ChartMetric) {
  const rows = new Map<string, ChartRow>()
  const reportMetric = isReportMetric(metric)
  const reportRow = (date: string) => rows.get(date) ?? { date, timestamp: Date.parse(`${date}T00:00:00Z`) }
  for (const symbol of symbols) {
    const points = histories[symbol] ?? []
    const first = points[0]?.price
    const item = fundamentals[symbol]
    const quarters = item?.quarters ?? []
    const knownOn = (date: string) => quarters.filter((quarter) => quarter.filed <= date)
    if (reportMetric && points.length) {
      const firstDate = points[0].date
      const lastDate = points[points.length - 1].date
      rows.set(firstDate, reportRow(firstDate))
      rows.set(lastDate, reportRow(lastDate))
      for (const event of reportEvents(quarters, metric, item?.tangibleAssetReports, points, item?.currencyRateToUsd)) {
        if (event.date < firstDate || event.date > lastDate) continue
        const row = reportRow(event.date)
        row[symbol] = event.value
        rows.set(event.date, row)
      }
      continue
    }
    for (const point of points) {
      const row = rows.get(point.date) ?? { date: point.date }
      if (metric === 'relative') row[symbol] = first ? ((point.price / first) - 1) * 100 : 0
      else if (metric === 'yield') {
        const distribution = item?.dividendYield != null && item.price
          ? (item.dividendYield / 100) * item.price
          : null
        row[symbol] = distribution != null && point.price > 0 ? (distribution / point.price) * 100 : Number.NaN
      } else if (metric === 'pe') {
        const known = knownOn(point.date).filter((quarter) => quarter.eps != null)
        const trailing = known.slice(-4)
        const ttm = trailing.reduce((sum, quarter) => sum + (quarter.eps ?? 0), 0)
        const complete = trailing.length === 4 && trailing.slice(1).every((quarter, index) => {
          const days = (Date.parse(quarter.end) - Date.parse(trailing[index].end)) / 86_400_000
          return days >= 60 && days <= 120
        })
        row[symbol] = ttm > 0 && (!item?.epsRequiresFourQuarters || complete) ? point.price / ttm : Number.NaN
      } else if (metric === 'priceToBook' || metric === 'dividendYield' || metric === 'impliedReturn') {
        const known = knownOn(point.date)
        const { book, dividends, sustainableGrowth } = trailingValues(known)
        if (metric === 'priceToBook') row[symbol] = book != null && book > 0 ? point.price / book : Number.NaN
        else if (metric === 'dividendYield') {
          const dividendQuarters = known.slice(-4)
          const hasDividendData = dividendQuarters.length === 4 &&
            dividendQuarters.every((quarter) => quarter.dividendsPerShare != null && Number.isFinite(quarter.dividendsPerShare))
          row[symbol] = hasDividendData && dividends != null && point.price > 0 ? dividends / point.price * 100 : Number.NaN
        } else row[symbol] = sustainableGrowth != null && dividends != null && point.price > 0
          ? sustainableGrowth + dividends / point.price * 100
          : Number.NaN
      } else {
        row[symbol] = point.price * (item?.currencyRateToUsd ?? 1)
      }
      rows.set(point.date, row)
    }
  }
  return [...rows.values()].sort((a, b) => String(a.date).localeCompare(String(b.date)))
}
