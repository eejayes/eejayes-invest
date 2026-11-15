import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import katex from 'katex'
import {
  AreaChart,
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  ArrowUpDown,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  ExternalLink,
  Filter,
  FlaskConical,
  FolderPlus,
  GitCompareArrows,
  Moon,
  Newspaper,
  Pencil,
  Plus,
  Search,
  Settings2,
  Sun,
  Trash2,
  WandSparkles,
  X,
} from 'lucide-react'
import { api } from './api'
import { isPercentMetric, isReportMetric, lastReportAt, mergeSeries, reportEvents } from './chartMetrics'
import { missingMetricSource } from './metricSources'
import { submittedSymbol } from './symbolSearch'
import type { ChartMetric, FundConstituentData, FundConstituentHolding, Fundamentals, PriceEvent, PricePoint, Range, SearchResult, SymbolDetail, SymbolNewsItem } from './types'

const colors = ['#68e0cf', '#ffbd69', '#8fa7ff', '#ff7a90', '#b4e66e', '#d69cff']
const inactiveTraceColor = '#65717a'
const inactiveTraceOpacity = 0.25
const defaultSymbols = ['AAPL', 'MSFT', 'NVDA']
const portfolioStorageKey = 'market-lens.portfolio'
const oldColumnsStorageKey = 'market-lens.comparison-columns'
const columnsStorageKey = 'market-lens.comparison-columns-v2'
const fundColumnsStorageKey = 'market-lens.fund-columns'
const bondColumnsStorageKey = 'market-lens.bond-columns'
const screenerStorageKey = 'market-lens.screener'
const workspaceStorageKey = 'market-lens.workspace'
const aggregateRangeOptions: Range[] = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y']
const detailRangeOptions: Range[] = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max']

function getCurrencySymbol(currency?: string | null): string {
  if (!currency) return '$'
  const cur = currency.toUpperCase()
  switch (cur) {
    case 'USD': return '$'
    case 'EUR': return '€'
    case 'GBP': return '£'
    case 'GBX': return 'p'
    case 'JPY': return '¥'
    case 'KRW': return '₩'
    case 'CNY': return '¥'
    case 'INR': return '₹'
    case 'CAD': return 'CA$'
    case 'AUD': return 'A$'
    case 'CHF': return 'CHF '
    case 'HKD': return 'HK$'
    case 'TWD': return 'NT$'
    case 'BRL': return 'R$'
    case 'SEK': return 'kr '
    case 'NOK': return 'kr '
    case 'DKK': return 'kr '
    case 'ILS': return '₪'
    case 'ZAR': return 'R '
    default: return `${currency} `
  }
}

function formatCurrency(value: number | null | undefined, currency?: string | null, decimals = 2): string {
  if (value == null) return '—'
  const sym = getCurrencySymbol(currency)
  const cur = (currency || 'USD').trim()
  if (cur === 'GBp') {
    return `${formatNumber(value, decimals)} GBp (£${formatNumber(value / 100, 2)})`
  }
  return `${sym}${formatNumber(value, decimals)}${currency && currency !== 'USD' ? ` ${currency}` : ''}`
}

type ColumnId = 'region' | 'price' | 'marketCap' | 'pe' | 'priceToBook' | 'priceToNetTangibleAssets' | 'earningsGrowth' | 'ewEpsGrowth' | 'ewRevenueGrowth' | 'incrementalRoic' | 'sustainableGrowth' | 'dividendYield' | 'impliedReturn' | 'lastReport'
type SortKey = 'symbol' | ColumnId
type SortDirection = 'asc' | 'desc'
type CollectionKind = 'portfolio' | 'analysis'
type CollectionItem = { symbol: string; enabled: boolean }
const randomSampleRegionOptions = [
  'USA',
  'North America',
  'Europe',
  'Asia',
  'Oceania',
  'Latin America',
  'Middle East',
  'Africa',
] as const
type RandomSampleRegion = typeof randomSampleRegionOptions[number]
// Portfolios and analyses share a shape so per-symbol visibility works identically in both.
type Portfolio = { id: string; name: string; items: CollectionItem[] }
type AnalysisCollection = { id: string; name: string; items: CollectionItem[] }
type Workspace = {
  portfolios: Portfolio[]
  analyses: AnalysisCollection[]
  activeKind: CollectionKind
  activeId: string
}
type ScreenerFilters = {
  query: string
  exchange: string
  minMarketCap: string
  maxMarketCap: string
  minPe: string
  maxPe: string
  minPriceToBook: string
  maxPriceToBook: string
  minEarningsGrowth: string
  minRevenueGrowth: string
}

const comparisonColumns: Array<{
  id: ColumnId
  label: string
  description?: string
  formula?: string
}> = [
  {
    id: 'region',
    label: 'Region',
    description: 'Geographic region of the exchange listing (e.g. USA, North America, Europe, Asia, Oceania, Latin America, Middle East, Africa)',
  },
  { id: 'price', label: 'Price' },
  {
    id: 'marketCap',
    label: 'Market cap',
    description: 'Current price multiplied by latest reported shares outstanding, converted to USD for foreign listings',
    formula: String.raw`\text{MarketCap} = P \times S`,
  },
  {
    id: 'pe',
    label: 'P / E',
    description: 'Current price divided by trailing four-quarter EPS',
    formula: String.raw`\text{P/E} = \dfrac{P}{\text{EPS}_{TTM}}`,
  },
  {
    id: 'priceToBook',
    label: 'P / Book',
    description: 'Current price divided by latest reported book value per share',
    formula: String.raw`\text{P/B} = \dfrac{P}{\text{BVPS}}`,
  },
  {
    id: 'priceToNetTangibleAssets',
    label: 'Price / net tangible assets',
    description: 'Price divided by net tangible assets per share. Missing balance-sheet amounts are assumed zero; positive shares and net tangible assets per share are required. Chart dots use the latest closing price on or before the filing date.',
    formula: String.raw`\dfrac{P}{\left(\text{Assets} - \text{Intangibles} - \text{Liabilities} - \text{Preferred stock}\right) / \text{Common shares outstanding}}`,
  },
  {
    id: 'earningsGrowth',
    label: 'EPS growth',
    description: 'Growth versus the preceding reported quarter',
    formula: String.raw`\Delta\text{EPS}_t = \dfrac{\text{EPS}_t - \text{EPS}_{t-1}}{|\text{EPS}_{t-1}|} \times 100`,
  },
  {
    id: 'ewEpsGrowth',
    label: 'EW EPS growth',
    description: 'Exponentially weighted quarter-over-quarter EPS growth, alpha 0.45',
    formula: String.raw`g_1 = \Delta\text{EPS}_1, \qquad g_t = \alpha\,\Delta\text{EPS}_t + (1-\alpha)\,g_{t-1}, \qquad \alpha = 0.45`,
  },
  {
    id: 'ewRevenueGrowth',
    label: 'EW revenue growth',
    description: 'Exponentially weighted quarter-over-quarter revenue growth, alpha 0.45',
    formula: String.raw`g_1 = \Delta\text{Rev}_1, \qquad g_t = \alpha\,\Delta\text{Rev}_t + (1-\alpha)\,g_{t-1}, \qquad \alpha = 0.45`,
  },
  {
    id: 'incrementalRoic',
    label: 'Incremental ROIC',
    description: 'Additional trailing-year operating profit after tax divided by additional invested capital',
    formula: String.raw`\Delta\text{ROIC} = \dfrac{\text{NOPAT}_{TTM} - \text{NOPAT}_{TTM-1}}{\text{IC}_t - \text{IC}_{t-1}} \qquad \text{IC} = \text{Equity} + \text{Debt} - \text{Cash}`,
  },
  {
    id: 'sustainableGrowth',
    label: 'Sustainable growth',
    description: 'Return on equity multiplied by the share of earnings retained after dividends, using trailing four-quarter figures',
    formula: String.raw`\text{ROE} = \dfrac{\text{EPS}_{TTM}}{\text{BVPS}} \qquad b = 1 - \dfrac{\text{DPS}_{TTM}}{\text{EPS}_{TTM}} \qquad g = \text{ROE} \times b`,
  },
  {
    id: 'dividendYield',
    label: 'Dividend yield',
    description: 'Trailing four-quarter dividends per share divided by the current price',
    formula: String.raw`y = \dfrac{\text{DPS}_{TTM}}{P}`,
  },
  {
    id: 'impliedReturn',
    label: 'Implied return',
    description: 'Sustainable growth plus dividend yield: the return implied at an unchanged valuation multiple',
    formula: String.raw`r = g + y = \text{ROE} \times b + \dfrac{\text{DPS}_{TTM}}{P}`,
  },
  { id: 'lastReport', label: 'Last report' },
]
const defaultColumns = comparisonColumns.map((column) => column.id)

type FundColumnId =
  | 'region' | 'price' | 'fundCategory' | 'netAssets' | 'expenseRatio' | 'pe' | 'priceToBook'
  | 'dividendYield' | 'returnOnEquity' | 'sustainableGrowth' | 'impliedReturn' | 'assetMix'
  | 'earningsGrowth' | 'ewEpsGrowth' | 'ewRevenueGrowth' | 'incrementalRoic' | 'payoutRatio'

/**
 * Funds are valued through their holdings, so these use the terminology the fund industry
 * actually uses for each measure rather than the company-level names.
 */
const fundColumns: Array<{ id: FundColumnId; label: string; description?: string; formula?: string }> = [
  {
    id: 'region',
    label: 'Region',
    description: 'Geographic region of the exchange listing (e.g. USA, North America, Europe, Asia, Oceania, Latin America, Middle East, Africa)',
  },
  { id: 'price', label: 'Price' },
  { id: 'fundCategory', label: 'Category' },
  {
    id: 'netAssets',
    label: 'Net assets',
    description: 'Total net assets under management in the fund, converted to USD for foreign listings',
  },
  {
    id: 'expenseRatio',
    label: 'Expense ratio',
    description: 'Annual management fee charged by the fund, reported in its annual report',
  },
  {
    id: 'pe',
    label: 'Trailing P / E',
    description: 'Weighted trailing price-to-earnings calculated from the fund’s published holdings and each holding’s trailing P/E',
    formula: String.raw`\text{P/E}_{trail} = \dfrac{\sum_i w_i}{\sum_i w_i / \text{P/E}_{i,trail}}`,
  },
  {
    id: 'priceToBook',
    label: 'Price / book (portfolio)',
    description: 'Weighted average price-to-book of the fund’s equity holdings',
    formula: String.raw`\text{P/B}_{port} = \dfrac{1}{\sum_i w_i \left(\frac{B}{P}\right)_i}`,
  },
  {
    id: 'earningsGrowth',
    label: 'EPS growth',
    description: 'Weighted average quarter-over-quarter EPS growth of the fund’s holdings',
    formula: String.raw`\Delta\text{EPS}_{port} = \sum_i w_i\,\Delta\text{EPS}_i`,
  },
  {
    id: 'ewEpsGrowth',
    label: 'EW EPS growth',
    description: 'Weighted average exponentially weighted EPS growth of the fund’s holdings, alpha 0.45',
    formula: String.raw`g_{port} = \sum_i w_i\,g_i, \qquad \alpha = 0.45`,
  },
  {
    id: 'ewRevenueGrowth',
    label: 'EW revenue growth',
    description: 'Weighted average exponentially weighted revenue growth of the fund’s holdings, alpha 0.45',
    formula: String.raw`g_{port} = \sum_i w_i\,g_i, \qquad \alpha = 0.45`,
  },
  {
    id: 'incrementalRoic',
    label: 'Incremental ROIC',
    description: 'Weighted average incremental ROIC of the fund’s holdings',
    formula: String.raw`\Delta\text{ROIC}_{port} = \sum_i w_i\,\Delta\text{ROIC}_i`,
  },
  {
    id: 'dividendYield',
    label: 'Distribution yield',
    description: 'Trailing twelve-month distributions paid by the fund divided by its price. For a bond fund this is the interest it passes through',
    formula: String.raw`y = \dfrac{\text{Distributions}_{TTM}}{P}`,
  },
  {
    id: 'returnOnEquity',
    label: 'Look-through ROE',
    description: 'Return on equity of the underlying holdings, implied by the portfolio’s price-to-book and price-to-earnings',
    formula: String.raw`\text{ROE} = \dfrac{E}{B} = \dfrac{\text{P/B}_{port}}{\text{P/PE}}`,
  },
  {
    id: 'sustainableGrowth',
    label: 'Implied earnings growth',
    description: 'Growth the holdings can fund from retained earnings: look-through ROE multiplied by the share of earnings they retain',
    formula: String.raw`\text{payout} = y \times \text{P/PE} \qquad g = \text{ROE} \times (1 - \text{payout})`,
  },
  {
    id: 'payoutRatio',
    label: 'Payout ratio',
    description: 'Share of the holdings’ earnings being distributed rather than retained. Distribution yield is cash paid out today relative to price; payout ratio is the same distributions measured against earnings, so it signals how sustainable the distribution is',
    formula: String.raw`\text{payout} = y \times \text{P/PE} = \dfrac{\text{Distributions}_{TTM}}{\text{Earnings}_{TTM}}`,
  },
  {
    id: 'impliedReturn',
    label: 'Expected return (net of fees)',
    description: 'Implied earnings growth plus distribution yield, less the expense ratio. For a bond fund, the yield less fees',
    formula: String.raw`r = g + y - \text{expenses}`,
  },
  {
    id: 'assetMix',
    label: 'Asset mix',
    description: 'Share of the fund held in stocks versus bonds',
  },
]
const defaultFundColumns = fundColumns.map((column) => column.id)

type BondColumnId =
  | 'region' | 'price' | 'fundCategory' | 'netAssets' | 'expenseRatio' | 'dividendYield' | 'creditQuality' | 'assetMix'

/**
 * Bond-heavy funds carry no look-through earnings or book value, so the equity-style ratios
 * above (P/E, P/B, ROE, growth) don't apply. Credit quality and yield are the comparable
 * measures for this asset class instead.
 */
const bondColumns: Array<{ id: BondColumnId; label: string; description?: string; formula?: string }> = [
  {
    id: 'region',
    label: 'Region',
    description: 'Geographic region of the exchange listing (e.g. USA, North America, Europe, Asia, Oceania, Latin America, Middle East, Africa)',
  },
  {
    id: 'price',
    label: 'Price',
    description: 'Current market price per share of the fund',
  },
  {
    id: 'fundCategory',
    label: 'Category',
    description: 'Morningstar-style bond category (for example duration and credit-quality band), reported by Yahoo’s fund profile',
  },
  {
    id: 'netAssets',
    label: 'Net assets',
    description: 'Total net assets under management in the fund, converted to USD for foreign listings',
  },
  {
    id: 'expenseRatio',
    label: 'Expense ratio',
    description: 'Annual management fee charged by the fund, reported in its annual report',
  },
  {
    id: 'dividendYield',
    label: 'Distribution yield',
    description: 'Trailing twelve-month interest distributions divided by price — the closest comparable figure to a bond fund’s SEC yield',
    formula: String.raw`y = \dfrac{\text{Distributions}_{TTM}}{P}`,
  },
  {
    id: 'creditQuality',
    label: 'Credit quality',
    description: 'The largest credit-rating band across the fund’s bond holdings, and its share of the portfolio. Lower-rated bands (BB and below) carry higher default risk but usually pay a higher yield',
  },
  {
    id: 'assetMix',
    label: 'Asset mix',
    description: 'Share of the fund held in bonds, cash, and other instruments',
  },
]
const defaultBondColumns = bondColumns.map((column) => column.id)
const defaultFilters: ScreenerFilters = {
  query: '',
  exchange: 'all',
  minMarketCap: '',
  maxMarketCap: '',
  minPe: '',
  maxPe: '',
  minPriceToBook: '',
  maxPriceToBook: '',
  minEarningsGrowth: '',
  minRevenueGrowth: '',
}

type Histories = Record<string, PricePoint[]>
type HistoryEvents = Record<string, PriceEvent[]>

function historyCacheKey(symbol: string, range: Range) {
  return `${symbol}:${range}`
}

async function mapWithConcurrency<T>(
  values: string[],
  concurrency: number,
  task: (value: string) => Promise<T>,
  onResult: (value: string, result: T) => void,
  onError: (value: string, error: unknown) => void,
) {
  let nextIndex = 0
  async function worker() {
    while (nextIndex < values.length) {
      const value = values[nextIndex]
      nextIndex += 1
      try {
        onResult(value, await task(value))
      } catch (error) {
        onError(value, error)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker))
}

function readStoredList<T extends string>(key: string, fallback: T[], allowed?: readonly T[]): T[] {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    if (!Array.isArray(parsed)) return fallback
    const values = parsed.filter(
      (item): item is T => typeof item === 'string' && (!allowed || allowed.includes(item as T)),
    )
    return values
  } catch {
    return fallback
  }
}

function readCompanyColumns() {
  try {
    const stored = window.localStorage.getItem(columnsStorageKey)
    const parsed: unknown = JSON.parse(stored ?? window.localStorage.getItem(oldColumnsStorageKey) ?? 'null')
    if (!Array.isArray(parsed)) return defaultColumns
    const migrated = parsed
      .map((item) => item === 'roiOnReinvestedEarnings' ? 'incrementalRoic' : item === 'netTangibleAssetsPerShare' ? 'priceToNetTangibleAssets' : item)
      .filter((item): item is ColumnId => typeof item === 'string' && defaultColumns.includes(item as ColumnId))
    if (stored == null) migrated.push('priceToNetTangibleAssets')
    return defaultColumns.filter((column) => migrated.includes(column))
  } catch {
    return defaultColumns
  }
}

function storeList(key: string, values: string[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(values))
  } catch (error) {
    console.warn(`Could not save ${key}`, error)
  }
}

function readStoredObject<T extends object>(key: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(key) ?? 'null')
    return parsed && typeof parsed === 'object' ? { ...fallback, ...parsed } : fallback
  } catch {
    return fallback
  }
}

function storeObject(key: string, value: object) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    console.warn(`Could not save ${key}`, error)
  }
}

type Theme = 'dark' | 'light'
const themeStorageKey = 'market-lens.theme'

function readTheme(): Theme {
  try {
    const saved = window.localStorage.getItem(themeStorageKey)
    return saved === 'light' ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

// Applied immediately at module load (before React mounts) so the correct theme is in
// place for the very first paint, avoiding a flash of the other theme on reload.
if (typeof document !== 'undefined') {
  document.documentElement.dataset.theme = readTheme()
}

function newId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function readWorkspace(): Workspace {
  let saved: Workspace | null = null
  try {
    saved = JSON.parse(window.localStorage.getItem(workspaceStorageKey) ?? 'null') as Workspace | null
  } catch {
    saved = null
  }
  if (
    saved &&
    Array.isArray(saved.portfolios) &&
    Array.isArray(saved.analyses) &&
    (saved.activeKind === 'portfolio' || saved.activeKind === 'analysis')
  ) {
    // Portfolios were previously stored as a bare symbol list; upgrade them in place so
    // existing saved workspaces keep working now that portfolios carry visibility too.
    const portfolios = saved.portfolios.map((portfolio) => {
      const legacy = portfolio as Portfolio & { symbols?: string[] }
      return Array.isArray(legacy.items)
        ? { id: legacy.id, name: legacy.name, items: legacy.items }
        : { id: legacy.id, name: legacy.name, items: (legacy.symbols ?? []).map((symbol) => ({ symbol, enabled: true })) }
    })
    const activeExists = saved.activeKind === 'portfolio'
      ? portfolios.some((item) => item.id === saved.activeId)
      : saved.analyses.some((item) => item.id === saved.activeId)
    if (activeExists) return { ...saved, portfolios }
  }

  const migratedSymbols = readStoredList(portfolioStorageKey, defaultSymbols)
  const portfolio: Portfolio = {
    id: newId(),
    name: 'My portfolio',
    items: migratedSymbols.map((symbol) => ({ symbol, enabled: true })),
  }
  return { portfolios: [portfolio], analyses: [], activeKind: 'portfolio', activeId: portfolio.id }
}

function parseOptionalNumber(value: string, multiplier = 1) {
  if (value.trim() === '') return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed * multiplier : null
}

function formatNumber(value: number | null | undefined, digits = 2) {
  return value == null || !Number.isFinite(value) ? '—' : value.toFixed(digits)
}

function formatGrowth(value: number | null | undefined) {
  return value == null || !Number.isFinite(value) ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`
}

function formatCompact(value: number | null | undefined) {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)
}

/**
 * Truncates at a word boundary to at most `max` characters, appending an ellipsis — except
 * a single word that alone exceeds `max` is kept whole rather than cut mid-word, since a
 * partial word (with or without an ellipsis) is harder to recognize than the full word
 * running a bit long.
 */
function truncateAtWordBoundary(text: string, max: number): string {
  if (text.length <= max) return text
  const words = text.split(' ')
  let result = ''
  for (const word of words) {
    const candidate = result ? `${result} ${word}` : word
    if (candidate.length > max) {
      // Nothing fits yet: this is the first word and it alone is longer than the budget,
      // so show it in full rather than break it (and skip the ellipsis, since it isn't
      // actually being cut short).
      if (!result) return word
      return `${result}…`
    }
    result = candidate
  }
  return result
}

/** Tracks a CSS breakpoint so components can switch behavior (not just styling) on mobile. */
function useIsMobile(maxWidth = 800): boolean {
  const query = `(max-width: ${maxWidth}px)`
  const [isMobile, setIsMobile] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mql = window.matchMedia(query)
    const handler = () => setIsMobile(mql.matches)
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  }, [query])
  return isMobile
}

type ChartTooltipPayload = { dataKey: string; value: number; color: string }

function ComparisonTooltip({
  active,
  payload,
  label,
  metric,
  pinnedSymbol,
  enabledSymbols,
  names,
  onTallChange,
}: {
  active?: boolean
  payload?: ChartTooltipPayload[]
  label?: string | number
  metric: ChartMetric
  pinnedSymbol: string | null
  enabledSymbols: string[]
  names?: Record<string, string | undefined>
  onTallChange: (tall: boolean) => void
}) {
  const tooltipRef = useRef<HTMLDivElement>(null)
  const seen = new Set<string>()
  const unique = (payload ?? []).filter((row) => {
    if (!enabledSymbols.includes(row.dataKey) || !Number.isFinite(row.value) || seen.has(row.dataKey)) return false
    seen.add(row.dataKey)
    return true
  })
  const rows = pinnedSymbol ? unique.filter((row) => row.dataKey === pinnedSymbol) : unique
  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    const area = tooltip?.closest('.chart-area')
    if (!active || !tooltip || !area) {
      onTallChange(false)
      return
    }
    const update = () => onTallChange(tooltip.offsetHeight > area.clientHeight / 2)
    update()
    const observer = new ResizeObserver(update)
    observer.observe(tooltip)
    observer.observe(area)
    return () => observer.disconnect()
  }, [active, rows.length, onTallChange])
  if (!active || !rows.length) return null
  // With a single series in view there is room to name the company; listing it for every
  // series would make a multi-ticker tooltip unreadable.
  const soleName = rows.length === 1 ? names?.[rows[0].dataKey] : undefined
  return (
    <div ref={tooltipRef} className="chart-tooltip">
      <p className="chart-tooltip-label">{isReportMetric(metric) && typeof label === 'number' ? new Date(label).toISOString().slice(0, 10) : label}</p>
      {rows.map((row) => (
        <p key={row.dataKey} style={{ color: row.color }}>
          {row.dataKey}: {isPercentMetric(metric) ? `${row.value.toFixed(2)}%` : row.value.toFixed(2)}
        </p>
      ))}
      {soleName && <p className="chart-tooltip-name">{soleName}</p>}
      {pinnedSymbol && <p className="chart-tooltip-hint">Tracking {pinnedSymbol} · press Enter or double-click/double-tap the line to open details · press Escape or click outside the chart controls to reset</p>}
    </div>
  )
}

type ChartRow = Record<string, string | number | null>

/**
 * Computes the y-axis domain. When a trace is pinned the axis is rescaled to that trace
 * alone, so a series with a small range stays readable next to one with a large range.
 */
function chartDomain(data: ChartRow[], symbols: string[]): [number, number] {
  let low = Infinity
  let high = -Infinity
  for (const row of data) {
    for (const symbol of symbols) {
      const value = row[symbol]
      if (typeof value !== 'number' || !Number.isFinite(value)) continue
      low = Math.min(low, value)
      high = Math.max(high, value)
    }
  }
  if (!Number.isFinite(low)) return [0, 1]
  const padding = (high - low || Math.abs(high) || 1) * 0.08
  return [low - padding, high + padding]
}

type DetailTab = 'financials' | 'splits' | 'insiders' | 'balance' | 'sources' | 'news'

type DetailMarker = {
  id: string
  tab: DetailTab
  type: 'Earnings' | 'Dividend' | 'Split' | 'Insider filing'
  date: string
  price: number
  pointIndex: number
  lane: number
  color: string
  summary: string
  url: string | null
}

function nearestHistoryPoint(history: PricePoint[], date: string) {
  const target = new Date(date).getTime()
  if (!Number.isFinite(target) || history.length === 0) return null
  // Events/filings dated before the first point in the currently displayed window fall
  // outside the visible range entirely, rather than snapping to day one, so they must be
  // hidden instead of being drawn stacked at the left edge.
  const first = history[0]
  if (new Date(first.date).getTime() > target) return null
  return history.find((point) => point.date >= date)
    ?? [...history].reverse().find((point) => new Date(point.date).getTime() <= target)
    ?? null
}

function historyPointIndex(history: PricePoint[], point: PricePoint) {
  return Math.max(0, history.findIndex((item) => item.date === point.date))
}

function distributeTimelineLanes<T extends { pointIndex: number }>(
  markers: T[],
  historyLength: number,
  laneCount = 6,
): Array<T & { lane: number }> {
  const laneLastPoint = Array.from({ length: laneCount }, () => -Infinity)
  const preferredLanes = [2, 3, 1, 4, 0, 5].filter((lane) => lane < laneCount)
  const minimumHorizontalGap = Math.max(2, Math.ceil(historyLength * 0.025))
  return [...markers]
    .sort((left, right) => left.pointIndex - right.pointIndex)
    .map((marker) => {
      const lane = preferredLanes.find(
        (candidate) => marker.pointIndex - laneLastPoint[candidate] >= minimumHorizontalGap,
      ) ?? preferredLanes.reduce(
        (best, candidate) => laneLastPoint[candidate] < laneLastPoint[best] ? candidate : best,
        preferredLanes[0],
      )
      laneLastPoint[lane] = marker.pointIndex
      return { ...marker, lane }
    })
}

function timelineLaneTop(lane: number, laneCount = 6) {
  return 12 + lane * (76 / Math.max(1, laneCount - 1))
}

function SharedCursorValueDot({
  cx,
  cy,
  color,
  label,
}: {
  cx?: number
  cy?: number
  color: string
  label: string
}) {
  if (cx == null || cy == null) return null
  const width = Math.max(76, label.length * 6.7 + 18)
  const labelBelow = cy < 38
  const boxY = labelBelow ? 10 : -34
  const textY = labelBelow ? 26 : -18
  return (
    <g className="shared-value-dot">
      <circle cx={cx} cy={cy} r={5} fill={color} stroke="#f4f8fa" strokeWidth={2} />
      <g transform={`translate(${cx}, ${cy})`}>
        <rect
          x={-width / 2}
          y={boxY}
          width={width}
          height={24}
          rx={6}
          fill="rgba(17, 24, 32, .94)"
          stroke="rgba(90, 110, 124, .65)"
        />
        <text
          x={0}
          y={textY}
          textAnchor="middle"
          fill="#dce5e7"
          fontFamily="DM Mono"
          fontSize={10}
        >
          {label}
        </text>
      </g>
    </g>
  )
}

function DetailChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: any; value?: number }> }) {
  if (!active || !payload?.length) return null
  const marker = payload.find((item) => item.payload?.eventType)?.payload
  if (marker) {
    return (
      <div className="chart-tooltip">
        <p><strong>{marker.eventType}</strong></p>
        <p>{marker.summary}</p>
        <p className="chart-tooltip-hint">Click the dot to open the matching table row.</p>
      </div>
    )
  }

  const point = payload[0]
  return (
    <div className="chart-tooltip">
      <p><strong>{point.payload?.date}</strong></p>
      <p>{formatNumber(Number(point.value))}</p>
    </div>
  )
}

function VolumeChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload?: PricePoint }> }) {
  const point = payload?.[0]?.payload
  if (!active || !point || point.volume == null) return null
  return (
    <div className="chart-tooltip">
      <p><strong>{point.date}</strong></p>
      <p>{formatCompact(point.volume)} shares traded</p>
    </div>
  )
}

function FilingValueTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ name?: string; value?: number; color?: string }>; label?: string }) {
  if (!active || !payload?.length) return null
  return (
    <div className="chart-tooltip">
      <p><strong>{label}</strong></p>
      {payload.map((item) => (
        <p key={item.name} style={{ color: item.color }}>
          {item.name}: {formatNumber(Number(item.value))}
        </p>
      ))}
    </div>
  )
}

type FinancialDot = {
  date: string
  pointIndex: number
  value: number
  targetId: string
  targetTab: DetailTab
}

type DetailPlotId = 'price' | 'volume' | 'eps' | 'dividends' | 'insiders' | 'news'

function DetailPlot({
  title,
  collapsed,
  onToggle,
  actions,
  children,
  className = '',
}: {
  title: string
  collapsed: boolean
  onToggle: () => void
  actions?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <div className={`detail-collapsible-plot${className ? ` ${className}` : ''}`}>
      <div className="detail-plot-header">
        <button type="button" className="detail-plot-toggle" onClick={onToggle} aria-expanded={!collapsed}>
          {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          {title}
        </button>
        {actions}
      </div>
      {!collapsed && children}
    </div>
  )
}

function FinancialDotChart({
  dots,
  historyLength,
  color,
  activeId,
  onDotClick,
  formatter = formatNumber,
}: {
  dots: FinancialDot[]
  historyLength: number
  color: string
  activeId: string | null
  onDotClick: (dot: FinancialDot) => void
  formatter?: (value: number | null) => string
}) {
  const values = dots.map((dot) => dot.value).filter((value) => Number.isFinite(value))
  if (!values.length) return null
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || Math.abs(max) || 1
  return (
    <div className="financial-dot-chart">
      <div className="financial-dot-body">
        <div className="financial-dot-axis">
          <span>{formatter(max)}</span>
          <span>{formatter(min)}</span>
        </div>
        <div className="financial-dot-track">
          {dots.map((dot) => (
            <button
              key={`${dot.targetId}:${dot.date}:${dot.value}`}
              className={`financial-dot${activeId === dot.targetId ? ' active' : ''}`}
              style={{
                '--event-color': color,
                left: `${historyLength <= 1 ? 0 : (dot.pointIndex / (historyLength - 1)) * 100}%`,
                top: `${100 - ((dot.value - min) / span) * 100}%`,
              } as React.CSSProperties}
              aria-label={`${dot.date}: ${formatter(dot.value)}`}
              onClick={() => onDotClick(dot)}
            >
              <span className="event-marker-tip">
                <span>{dot.date}: {formatter(dot.value)}</span>
                <em>Click to open the matching filing row.</em>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Full source-data view for one symbol.
 *
 * Everything shown here is the raw filing input behind the calculated metrics, not a
 * re-derivation: the server reads it with the same extraction helpers the metrics use, so
 * a number shown here is literally the number the metric consumed.
 */
function SymbolDetailPanel({
  symbol,
  detail,
  summary,
  history,
  events,
  range,
  onRangeChange,
  error,
  onClose,
  onBack,
  colorFor,
  constituents,
  constituentsError,
  onOpenSymbol,
  news,
  newsLoading,
  newsError,
}: {
  symbol: string
  detail: SymbolDetail | null
  summary?: Fundamentals
  history: PricePoint[]
  events: PriceEvent[]
  range: Range
  onRangeChange: (range: Range) => void
  error?: string
  onClose: () => void
  onBack?: () => void
  colorFor: (symbol: string) => string
  constituents: FundConstituentData | null
  constituentsError?: string
  onOpenSymbol: (symbol: string) => void
  news: SymbolNewsItem[] | null
  newsLoading: boolean
  newsError?: string
}) {
  const [tab, setTab] = useState<DetailTab>('financials')
  const [fundTab, setFundTab] = useState<'metadata' | 'constituents' | 'news'>('metadata')
  const [activeEventId, setActiveEventId] = useState<string | null>(null)
  const [visibleNewsCount, setVisibleNewsCount] = useState(15)
  const [sharedCursorIndex, setSharedCursorIndex] = useState<number | null>(null)
  const [collapsedPlots, setCollapsedPlots] = useState<Set<DetailPlotId>>(() => new Set())
  const eventRowRefs = useRef<Record<string, HTMLTableRowElement | null>>({})
  const activeEventTimerRef = useRef<number | null>(null)

  useEffect(() => {
    setVisibleNewsCount(15)
  }, [symbol, range])

  useEffect(() => {
    setCollapsedPlots(new Set())
    setActiveEventId(null)
  }, [symbol])

  useEffect(() => () => {
    if (activeEventTimerRef.current != null) window.clearTimeout(activeEventTimerRef.current)
  }, [])

  const priceStats = useMemo(() => {
    const prices = history.map((point) => point.price).filter((value) => Number.isFinite(value))
    if (!prices.length) return null
    const first = prices[0]
    const last = prices[prices.length - 1]
    return {
      low: Math.min(...prices),
      high: Math.max(...prices),
      change: first ? ((last / first) - 1) * 100 : null,
      points: prices.length,
    }
  }, [history])
  const volumeHistory = useMemo(
    () => history.filter((point) => point.volume != null && Number.isFinite(point.volume)),
    [history],
  )

  // Readable filing first, with the raw document index as a secondary link: the rendered
  // inline-XBRL document is what someone actually wants when checking a number by eye.
  function filingCell(period: SymbolDetail['periods'][number]) {
    if (!period.filingUrl && !period.filingIndexUrl) return <td>{period.form ?? '—'}</td>
    return (
      <td>
        <div className="filing-cell">
          {period.filingUrl && (
            <a className="filing-link" href={period.filingUrl} target="_blank" rel="noreferrer"
               title={`Read the ${period.form ?? 'filing'} as filed, with each tagged figure inspectable`}>
              {period.form ?? 'Filing'} <ExternalLink size={11} />
            </a>
          )}
          {period.filingIndexUrl && (
            <a className="filing-sublink" href={period.filingIndexUrl} target="_blank" rel="noreferrer"
               title="All documents filed in this submission">
              all files
            </a>
          )}
        </div>
      </td>
    )
  }

  // Newest first reads more naturally in a statement table than the chronological order
  // the metrics are computed in.
  const periods = useMemo(() => [...(detail?.periods ?? [])].reverse(), [detail])
  const dividendEvents = useMemo(() => events.filter((event) => event.type === 'dividend'), [events])
  const splitEvents = useMemo(() => events.filter((event) => event.type === 'split'), [events])
  const insiderEvents = detail?.insiderEvents ?? []
  const newsEventLinks = useMemo(() => {
    const knownEvents: Array<{ date: string; label: string; targetId: string; targetTab: DetailTab }> = []
    for (const period of detail?.periods ?? []) {
      if (period.eps != null || period.dividendsPerShare != null) {
        knownEvents.push({
          date: period.end,
          label: period.eps != null ? 'Near earnings report' : 'Near reported dividend',
          targetId: `earnings:${period.end}`,
          targetTab: 'financials',
        })
      }
    }
    for (const event of splitEvents) {
      knownEvents.push({
        date: event.date,
        label: 'Near stock split',
        targetId: `split:${event.date}:${event.ratio ?? ''}`,
        targetTab: 'splits',
      })
    }
    for (const event of insiderEvents) {
      knownEvents.push({
        date: event.date,
        label: 'Near insider filing',
        targetId: `insider:${event.accession}`,
        targetTab: 'insiders',
      })
    }
    return new Map((news ?? []).flatMap((item) => {
      const published = new Date(item.publishedAt).getTime()
      if (!Number.isFinite(published)) return []
      let nearest: typeof knownEvents[number] | undefined
      let nearestDistance = Infinity
      for (const event of knownEvents) {
        const distance = Math.abs(new Date(event.date).getTime() - published)
        if (distance < nearestDistance) {
          nearest = event
          nearestDistance = distance
        }
      }
      return nearest && nearestDistance <= 2 * 24 * 60 * 60 * 1000 ? [[item.id, nearest] as const] : []
    }))
  }, [detail, insiderEvents, news, splitEvents])
  const filingDots = useMemo(() => {
    if (!detail || history.length === 0) return { eps: [] as FinancialDot[], dividends: [] as FinancialDot[] }
    const eps: FinancialDot[] = []
    const dividends: FinancialDot[] = []
    for (const period of detail.periods) {
      const point = nearestHistoryPoint(history, period.end)
      if (!point) continue
      const pointIndex = historyPointIndex(history, point)
      if (period.eps != null) {
        eps.push({ date: period.end, pointIndex, value: period.eps, targetId: `earnings:${period.end}`, targetTab: 'financials' })
      }
      if (period.dividendsPerShare != null) {
        dividends.push({
          date: period.end,
          pointIndex,
          value: period.dividendsPerShare,
          targetId: `earnings:${period.end}`,
          targetTab: 'financials',
        })
      }
    }
    return { eps, dividends }
  }, [detail, history])
  const fundSummary = detail?.fundSummary ?? summary
  const bondFund = (fundSummary?.bondPosition ?? 0) > (fundSummary?.stockPosition ?? 0)
  const eventMarkers = useMemo<DetailMarker[]>(() => {
    if (!detail || history.length === 0) return []
    const markers: Array<Omit<DetailMarker, 'lane'>> = []
    // Earnings and dividend levels have their own dedicated dot charts below the price
    // chart, so this strip only needs to surface insider filing events.
    for (const event of insiderEvents) {
      const point = nearestHistoryPoint(history, event.date)
      if (!point) continue
      markers.push({
        id: `insider:${event.accession}`,
        tab: 'insiders',
        type: 'Insider filing',
        date: point.date,
        price: point.price,
        pointIndex: historyPointIndex(history, point),
        color: '#8fa7ff',
        summary: `${event.date}: ${event.eventClass} (SEC Form ${event.form})`,
        url: event.filingUrl ?? event.filingIndexUrl,
      })
    }
    return distributeTimelineLanes(markers, history.length)
  }, [detail, history, insiderEvents])
  const newsTimelineMarkers = useMemo(() => {
    if (!news?.length || history.length === 0) return []
    const firstDate = history[0].date
    const lastDate = history[history.length - 1].date
    const markers = news.flatMap((item) => {
      const date = item.publishedAt.slice(0, 10)
      if (date < firstDate || date > lastDate) return []
      const point = nearestHistoryPoint(history, date)
      if (!point) return []
      return [{
        item,
        date,
        pointIndex: historyPointIndex(history, point),
      }]
    })
    return distributeTimelineLanes(markers, history.length)
  }, [history, news])

  // On a mouse/trackpad, hover already previews the headline before the click, so a single
  // click can open immediately. Touch screens have no hover, so a tap would otherwise open
  // the link blind — instead the first tap only reveals the `.event-marker-tip` preview
  // (via `activeEventId`/`.active`) and a second tap on the same marker confirms opening it.
  function isTouchDevice() {
    return window.matchMedia('(hover: none), (pointer: coarse)').matches
  }

  function openEventMarker(marker: DetailMarker) {
    if (marker.url) window.open(marker.url, '_blank', 'noopener,noreferrer')
  }

  function handleEventDotClick(event: React.MouseEvent, marker: DetailMarker) {
    // The second tap must land on the popped-up preview card itself (`.event-marker-tip`),
    // not the tiny dot — the dot is a much smaller, easy-to-mis-tap target, and re-tapping it
    // should just keep the preview open rather than risk opening the wrong thing.
    const tappedTip = (event.target as HTMLElement).closest('.event-marker-tip') != null
    if (isTouchDevice() && !tappedTip) {
      setActiveEventId(marker.id)
      return
    }
    openEventMarker(marker)
  }

  // Dismisses an insider/news preview opened by a tap (see handleEventDotClick above) as soon
  // as the user taps or clicks anywhere else — including elsewhere in the chart or outside
  // the panel entirely. Scoped to just insider/news marker ids so it doesn't interfere with
  // the separate flash-row highlight `flashEventRow` drives (that one already auto-clears on
  // its own timer).
  useEffect(() => {
    if (!activeEventId) return
    const isPreviewId = eventMarkers.some((marker) => marker.id === activeEventId)
      || newsTimelineMarkers.some(({ item }) => item.id === activeEventId)
    if (!isPreviewId) return
    function dismissIfOutside(event: PointerEvent) {
      const target = event.target as HTMLElement | null
      if (target?.closest('.event-dot')) return
      setActiveEventId(null)
    }
    document.addEventListener('pointerdown', dismissIfOutside)
    return () => document.removeEventListener('pointerdown', dismissIfOutside)
  }, [activeEventId, eventMarkers, newsTimelineMarkers])

  function flashEventRow(id: string) {
    if (activeEventTimerRef.current != null) window.clearTimeout(activeEventTimerRef.current)
    setActiveEventId(id)
    activeEventTimerRef.current = window.setTimeout(() => {
      setActiveEventId((current) => current === id ? null : current)
      activeEventTimerRef.current = null
    }, 1400)
  }

  function togglePlot(plot: DetailPlotId) {
    setCollapsedPlots((current) => {
      const next = new Set(current)
      if (next.has(plot)) next.delete(plot)
      else next.add(plot)
      return next
    })
  }

  function openFinancialDot(dot: FinancialDot) {
    flashEventRow(dot.targetId)
    setTab(dot.targetTab)
    window.setTimeout(() => {
      eventRowRefs.current[dot.targetId]?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    }, 0)
  }

  const detailChartMargin = { top: 6, right: 10, left: 0, bottom: 0 }
  const sharedCursorLeft = sharedCursorIndex == null || history.length <= 1
    ? null
    : `calc(58px + (100% - 68px) * ${sharedCursorIndex / (history.length - 1)})`
  const sharedCursorPoint = sharedCursorIndex == null ? null : history[sharedCursorIndex] ?? null

  function moveSharedCursor(event: React.MouseEvent<HTMLDivElement>) {
    updateSharedCursorFromClientX(event.clientX, event.currentTarget)
  }

  // When the mobile browser itself is pinch-zoomed in, a one-finger drag normally pans that
  // zoomed viewport around — which is what was hijacking drags meant to scrub the cursor.
  // `touch-action: none` on `.detail-time-stack` (styles.css) tells the browser not to handle
  // touches there at all, so this handler becomes the only thing driving the drag while a
  // finger is over the chart; every other area of the panel is untouched and still pans/zooms
  // normally.
  function moveSharedCursorTouch(event: React.TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0]
    if (!touch) return
    updateSharedCursorFromClientX(touch.clientX, event.currentTarget)
  }

  function updateSharedCursorFromClientX(clientX: number, container: HTMLDivElement) {
    if (history.length === 0) return
    const bounds = container.getBoundingClientRect()
    const plotWidth = Math.max(1, bounds.width - 68)
    const plotX = Math.min(plotWidth, Math.max(0, clientX - bounds.left - 58))
    setSharedCursorIndex(Math.round((plotX / plotWidth) * Math.max(0, history.length - 1)))
  }

  const newsContent = newsLoading ? (
    <div className="news-loading"><span className="search-loader" /> Loading coverage for this period…</div>
  ) : newsError ? (
    <div className="detail-error news-error">{newsError}</div>
  ) : !news?.length ? (
    <p className="detail-empty">No news articles were found for {symbol} in the selected period.</p>
  ) : (
    <div className="news-list">
      {news.slice(0, visibleNewsCount).map((item) => (
        <article className="news-item" key={item.id}>
          <div className="news-item-meta">
            <span>{item.publisher} · via {item.source}</span>
            <time dateTime={item.publishedAt}>
              {new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(item.publishedAt))}
            </time>
          </div>
          <a href={item.url} target="_blank" rel="noreferrer">
            <Newspaper size={15} />
            <strong>{item.title}</strong>
            <ExternalLink size={12} />
          </a>
          {newsEventLinks.get(item.id) && (
            <button
              className="news-event-link"
              type="button"
              onClick={() => {
                const event = newsEventLinks.get(item.id)
                if (!event) return
                flashEventRow(event.targetId)
                setTab(event.targetTab)
                window.setTimeout(() => {
                  eventRowRefs.current[event.targetId]?.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
                }, 0)
              }}
            >
              {newsEventLinks.get(item.id)?.label} · {newsEventLinks.get(item.id)?.date}
            </button>
          )}
        </article>
      ))}
      {visibleNewsCount < news.length && (
        <button
          className="news-load-more"
          type="button"
          onClick={() => setVisibleNewsCount((current) => Math.min(current + 15, news.length))}
        >
          Load more news
          <small>{Math.min(15, news.length - visibleNewsCount)} of {news.length - visibleNewsCount} remaining</small>
        </button>
      )}
      <p className="news-source-note">Recent coverage comes from Yahoo Finance; older coverage comes from Google News RSS. Event badges indicate date proximity only, not a verified causal relationship.</p>
    </div>
  )

  function detailUnavailable(label: string, reason: string) {
    return (
      <HoverTip
        className="metric-missing"
        ariaLabel={`Why ${label} is unavailable`}
        content={
          <>
            <p><strong>{label} unavailable</strong></p>
            <p>{reason}</p>
          </>
        }
      >
        —
      </HoverTip>
    )
  }

  function detailNumber(value: number | null, formatted: string, label: string, reason: string, className?: string) {
    return <td className={value == null ? undefined : className}>{value == null ? detailUnavailable(label, reason) : formatted}</td>
  }

  function tangibleDetailNumber(value: number, assumptions: string[], derived = false, formatted = formatCompact(value)) {
    return (
      <td>
        {formatted}
        {assumptions.length > 0 && (
          <HoverTip className="derived-flag" ariaLabel="Assumed zero" content={<><p><strong>Assumed zero</strong></p><p>Unreported {assumptions.join(', ')} assumed zero for net tangible assets per share.</p></>}>assumed</HoverTip>
        )}
        {derived && (
          <HoverTip className="derived-flag" ariaLabel="How total liabilities was derived" content={<><p><strong>Derived value</strong></p><p>Total assets less total equity including noncontrolling interests.</p></>}>derived</HoverTip>
        )}
      </td>
    )
  }

  return (
    <div
      className="detail-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={`${symbol} details`}
      onClick={(event) => {
        // Only the backdrop itself should close on click; clicks inside the panel bubble
        // up but shouldn't dismiss it.
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="detail-panel">
        <header className="detail-header">
          {/* Kept deliberately minimal: this bar stays pinned to the top of the scroll
              container the whole time the panel is open, so anything more than the ticker
              and the primary actions would permanently cover the content that scrolls
              beneath it. The full name and the exchange/region/CIK line live in the
              scrollable body instead, right above the business description. */}
          <div>
            <h2><i style={{ background: colorFor(symbol) }} />{symbol}</h2>
            {(!detail || error) && <p>{error ? 'Could not load' : 'Loading…'}</p>}
          </div>
          <div className="detail-header-right">
            {onBack && (
              <button className="icon-action" onClick={onBack} aria-label="Back to previous symbol"><ArrowLeft size={18} /></button>
            )}
            {detail?.filingsUrl && (
              <a className="edgar-link" href={detail.filingsUrl} target="_blank" rel="noreferrer">
                <ExternalLink size={13} /> Verify on SEC EDGAR
              </a>
            )}
            {detail?.price != null && (
              <strong className="detail-price">
                {formatCurrency(detail.price, detail.currency)}
                {detail.currency !== 'USD' && detail.usdPrice != null && (
                  <small className="detail-price-usd">(≈ ${formatNumber(detail.usdPrice)} USD)</small>
                )}
              </strong>
            )}
            <button className="icon-action" onClick={onClose} aria-label="Close details"><X size={18} /></button>
          </div>
        </header>

        {error ? (
          <div className="detail-error">{error}</div>
        ) : !detail ? (
          <div className="loading-state"><span className="large-loader" /> Loading filing data…</div>
        ) : (
          <div className="detail-body">
            <section className="detail-section">
              <h1 className="detail-company-name">{detail.name}</h1>
              <h3>Business description</h3>
              {detail.profile?.description ? (
                <p className="detail-description">{detail.profile.description}</p>
              ) : (
                <p className="detail-empty">
                  No business description available.
                  {detail.profile?.sicDescription ? ` SEC classifies this entity as: ${detail.profile.sicDescription}.` : ''}
                </p>
              )}
              <dl className="detail-stats">
                <div><dt>Exchange</dt><dd>{detail.fullExchange || detail.exchange || '—'}</dd></div>
                {detail.region && (
                  <div><dt>Region</dt><dd>{detail.region}</dd></div>
                )}
                {detail.entityName && detail.entityName !== detail.name && (
                  <div><dt>Filed as</dt><dd>{detail.entityName}</dd></div>
                )}
                {detail.cik && (
                  <div><dt>CIK</dt><dd>{detail.cik}</dd></div>
                )}
                {detail.currency && (
                  <div><dt>Currency</dt><dd>{detail.currency}</dd></div>
                )}
                {(detail.profile?.sector || detail.profile?.industry) && (
                  <div><dt>Sector / industry</dt><dd>{[detail.profile?.sector, detail.profile?.industry].filter(Boolean).join(' · ') || '—'}</dd></div>
                )}
                {detail.profile?.sicDescription && (
                  <div><dt>SEC classification</dt><dd>{detail.profile.sicDescription}{detail.profile.sic ? ` (SIC ${detail.profile.sic})` : ''}</dd></div>
                )}
                {detail.profile?.employees != null && (
                  <div><dt>Employees</dt><dd>{detail.profile.employees.toLocaleString()}</dd></div>
                )}
                {detail.profile?.location && (
                  <div><dt>Headquarters</dt><dd>{detail.profile.location}</dd></div>
                )}
              </dl>
              <div className="detail-links">
                {detail.profile?.website && (
                  <a className="filing-link" href={detail.profile.website} target="_blank" rel="noreferrer">
                    Company website <ExternalLink size={11} />
                  </a>
                )}
                {detail.profile?.financeProfileUrl && (
                  <a className="filing-link" href={detail.profile.financeProfileUrl} target="_blank" rel="noreferrer">
                    Yahoo Finance profile <ExternalLink size={11} />
                  </a>
                )}
                {detail.filingsUrl && (
                  <a className="filing-link" href={detail.filingsUrl} target="_blank" rel="noreferrer">
                    SEC filing history <ExternalLink size={11} />
                  </a>
                )}
              </div>
            </section>

            <section className="detail-section">
              {history.length === 0 ? (
                <p className="detail-empty">No price history loaded for this symbol.</p>
              ) : (
                <div
                  className="detail-time-stack"
                  onMouseMove={moveSharedCursor}
                  onMouseLeave={() => setSharedCursorIndex(null)}
                  onTouchMove={moveSharedCursorTouch}
                  onTouchEnd={() => setSharedCursorIndex(null)}
                  onTouchCancel={() => setSharedCursorIndex(null)}
                >
                  {sharedCursorLeft && (
                    <div className="detail-shared-cursor" style={{ left: sharedCursorLeft }}>
                      <span>{history[sharedCursorIndex!]?.date}</span>
                    </div>
                  )}
                  <DetailPlot
                    title="Price history"
                    collapsed={collapsedPlots.has('price')}
                    onToggle={() => togglePlot('price')}
                    actions={
                      <div className="segmented compact">
                        {detailRangeOptions.map((value) => (
                          <button key={value} className={range === value ? 'active' : ''} onClick={() => onRangeChange(value)}>{value.toUpperCase()}</button>
                        ))}
                      </div>
                    }
                  >
                    <div className="detail-chart">
                      <ResponsiveContainer width="100%" height="100%">
                        <ComposedChart data={history} margin={detailChartMargin}>
                          <defs>
                            <linearGradient id="detailFill" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="5%" stopColor={colorFor(symbol)} stopOpacity={0.3} />
                              <stop offset="95%" stopColor={colorFor(symbol)} stopOpacity={0} />
                            </linearGradient>
                          </defs>
                          <CartesianGrid stroke="#26313a" strokeDasharray="3 5" vertical={false} />
                          <XAxis dataKey="date" stroke="#71808c" tickLine={false} axisLine={false} minTickGap={60} />
                          <YAxis stroke="#71808c" tickLine={false} axisLine={false} domain={['auto', 'auto']} width={58} />
                          <Tooltip content={<DetailChartTooltip />} />
                          <Area type="linear" dataKey="price" stroke={colorFor(symbol)} fill="url(#detailFill)" strokeWidth={2} />
                          {sharedCursorPoint && (
                            <ReferenceDot
                              x={sharedCursorPoint.date}
                              y={sharedCursorPoint.price}
                              ifOverflow="extendDomain"
                              shape={
                                <SharedCursorValueDot
                                  color={colorFor(symbol)}
                                  label={`Price ${formatCurrency(sharedCursorPoint.price, detail.currency)}`}
                                />
                              }
                            />
                          )}
                        </ComposedChart>
                      </ResponsiveContainer>
                    </div>
                  </DetailPlot>
                  {priceStats && (
                    <dl className="detail-stats detail-price-stats">
                      <div><dt>Low</dt><dd>{formatCurrency(priceStats.low, detail?.currency)}</dd></div>
                      <div><dt>High</dt><dd>{formatCurrency(priceStats.high, detail?.currency)}</dd></div>
                      <div><dt>Change over window</dt><dd>{formatGrowth(priceStats.change)}</dd></div>
                      <div><dt>Trading days</dt><dd>{priceStats.points}</dd></div>
                    </dl>
                  )}
                  {volumeHistory.length > 0 && (
                    <DetailPlot
                      title="Daily trading volume"
                      collapsed={collapsedPlots.has('volume')}
                      onToggle={() => togglePlot('volume')}
                    >
                      <div className="detail-volume-body">
                        <ResponsiveContainer width="100%" height="100%">
                          <LineChart data={volumeHistory} margin={detailChartMargin}>
                            <CartesianGrid stroke="#26313a" strokeDasharray="3 5" vertical={false} />
                            <XAxis dataKey="date" stroke="#71808c" tickLine={false} axisLine={false} minTickGap={60} />
                            <YAxis
                              stroke="#71808c"
                              tickLine={false}
                              axisLine={false}
                              width={58}
                              domain={[0, 'auto']}
                              tickFormatter={(value) => formatCompact(Number(value))}
                            />
                            <Tooltip content={<VolumeChartTooltip />} />
                            <Line
                              type="linear"
                              dataKey="volume"
                              dot={false}
                              connectNulls
                              isAnimationActive={false}
                              stroke="#8fa7ff"
                              strokeWidth={1.75}
                            />
                            {sharedCursorPoint?.volume != null && (
                              <ReferenceDot
                                x={sharedCursorPoint.date}
                                y={sharedCursorPoint.volume}
                                ifOverflow="extendDomain"
                                shape={
                                  <SharedCursorValueDot
                                    color="#8fa7ff"
                                    label={`Volume ${formatCompact(sharedCursorPoint.volume)}`}
                                  />
                                }
                              />
                            )}
                          </LineChart>
                        </ResponsiveContainer>
                      </div>
                    </DetailPlot>
                  )}
                  {!detail.isFund && (filingDots.eps.length > 0 || filingDots.dividends.length > 0) && (
                    <div className="financial-dot-stack">
                      {filingDots.eps.length > 0 && (
                        <DetailPlot title="EPS by report period" collapsed={collapsedPlots.has('eps')} onToggle={() => togglePlot('eps')}>
                          <FinancialDotChart dots={filingDots.eps} historyLength={history.length} color="#68e0cf" activeId={null} onDotClick={openFinancialDot} />
                        </DetailPlot>
                      )}
                      {filingDots.dividends.length > 0 && (
                        <DetailPlot title="Dividends per share by report period" collapsed={collapsedPlots.has('dividends')} onToggle={() => togglePlot('dividends')}>
                          <FinancialDotChart dots={filingDots.dividends} historyLength={history.length} color="#ffbd69" activeId={null} onDotClick={openFinancialDot} />
                        </DetailPlot>
                      )}
                    </div>
                  )}
                  {eventMarkers.length > 0 && (
                    <DetailPlot title="Insider filings" collapsed={collapsedPlots.has('insiders')} onToggle={() => togglePlot('insiders')}>
                      <div className="event-strip">
                        <div className="event-strip-track">
                          {eventMarkers.map((marker) => (
                            <button
                              key={marker.id}
                              className={`event-dot${activeEventId === marker.id ? ' active' : ''}`}
                              style={{
                                '--event-color': marker.color,
                                left: `${history.length <= 1 ? 0 : (marker.pointIndex / (history.length - 1)) * 100}%`,
                                top: `${timelineLaneTop(marker.lane)}%`,
                              } as React.CSSProperties}
                              aria-label={`${marker.type}: ${marker.summary}`}
                              onClick={(event) => handleEventDotClick(event, marker)}
                            >
                              <span className="event-marker-tip">
                                <strong>{marker.type}</strong>
                                <span>{marker.summary}</span>
                                <em>{activeEventId === marker.id ? 'Tap this card to open the SEC filing.' : 'Click to open the SEC filing.'}</em>
                              </span>
                            </button>
                          ))}
                        </div>
                      </div>
                    </DetailPlot>
                  )}
                  {newsTimelineMarkers.length > 0 && (
                    <DetailPlot title="News articles" collapsed={collapsedPlots.has('news')} onToggle={() => togglePlot('news')}>
                      <div className="event-strip news-event-strip">
                        <div className="event-strip-track">
                          {newsTimelineMarkers.map(({ item, pointIndex, lane, date }) => (
                            <a
                              key={item.id}
                              className={`event-dot news-timeline-dot${activeEventId === item.id ? ' active' : ''}`}
                              style={{
                                '--event-color': '#ffbd69',
                                left: `${history.length <= 1 ? 0 : (pointIndex / (history.length - 1)) * 100}%`,
                                top: `${timelineLaneTop(lane)}%`,
                              } as React.CSSProperties}
                              href={item.url}
                              target="_blank"
                              rel="noreferrer"
                              aria-label={`Open article: ${item.title}`}
                              onClick={(event) => {
                                // Same tap-to-preview gating as the insider dots above: on a
                                // touch screen the first tap only reveals the headline, and
                                // the second tap must land on the preview card itself
                                // (`.event-marker-tip`) — not the small dot — to follow the
                                // link, since default anchor navigation is otherwise blocked.
                                const tappedTip = (event.target as HTMLElement).closest('.event-marker-tip') != null
                                if (isTouchDevice() && !tappedTip) {
                                  event.preventDefault()
                                  setActiveEventId(item.id)
                                }
                              }}
                            >
                              <span className="event-marker-tip">
                                <strong>{item.title}</strong>
                                <span>{item.publisher} · {date}</span>
                                <em>{activeEventId === item.id ? 'Tap this card to open the article.' : 'Click to open the article.'}</em>
                              </span>
                            </a>
                          ))}
                        </div>
                      </div>
                    </DetailPlot>
                  )}
                </div>
              )}
            </section>

            {detail.isFund ? (
              <section className="detail-section">
                <div className="detail-tabs">
                  <button className={fundTab === 'metadata' ? 'active' : ''} onClick={() => setFundTab('metadata')}>Fund metadata</button>
                  <button className={fundTab === 'constituents' ? 'active' : ''} onClick={() => setFundTab('constituents')}>Constituents</button>
                  <button className={fundTab === 'news' ? 'active' : ''} onClick={() => setFundTab('news')}>News</button>
                </div>
                {fundTab === 'news' ? newsContent : fundTab === 'metadata' ? (
                  bondFund ? (
                    <>
                      <h3>Fund valuation</h3>
                      {fundSummary ? (
                        <div className="fund-metadata-table">
                          <table>
                            <thead>
                              <tr><th>Metric</th><th>Value</th><th>Source note</th></tr>
                            </thead>
                            <tbody>
                              <tr><td>Category</td><td>{fundSummary.fundCategory ?? '—'}</td><td>Yahoo fund profile</td></tr>
                              <tr><td>Fund family</td><td>{fundSummary.fundFamily ?? '—'}</td><td>Yahoo fund profile</td></tr>
                              <tr><td>Net assets</td><td>{formatCompact(fundSummary.netAssets ?? null)}</td><td>Yahoo fund profile/statistics</td></tr>
                              <tr><td>Expense ratio</td><td>{formatGrowth(fundSummary.expenseRatio ?? null)}</td><td>{fundSummary.metricNotes?.expenseRatio ?? 'Yahoo fund profile annual report expense ratio.'}</td></tr>
                              <tr><td>Credit quality</td><td>{fundSummary.creditQuality ?? '—'}</td><td>Largest credit-rating band across the fund’s bond holdings, from Yahoo’s published breakdown.</td></tr>
                              <tr><td>Asset mix</td><td>Bonds {formatGrowth(fundSummary.bondPosition ?? null)} · Cash {formatGrowth(fundSummary.cashPosition ?? null)}{fundSummary.otherPosition ? ` · Other ${formatGrowth(fundSummary.otherPosition)}` : ''}</td><td>Yahoo holdings breakdown</td></tr>
                            </tbody>
                          </table>
                        </div>
                      ) : (
                        <p className="detail-empty">Fund metrics are still loading.</p>
                      )}
                      <p className="detail-note">Distribution yield is on the Bond funds table on the Compare view, alongside this fund’s peers. A bond fund holds little or no equity, so look-through earnings, book value, and growth metrics don’t apply — its return comes from interest, which yield and credit quality capture instead.</p>
                    </>
                  ) : (
                  <>
                    <h3>Fund valuation</h3>
                    {fundSummary ? (
                      <div className="fund-metadata-table">
                        <table>
                          <thead>
                            <tr><th>Metric</th><th>Value</th><th>Source note</th></tr>
                          </thead>
                          <tbody>
                            <tr><td>Category</td><td>{fundSummary.fundCategory ?? '—'}</td><td>Yahoo fund profile</td></tr>
                            <tr><td>Fund family</td><td>{fundSummary.fundFamily ?? '—'}</td><td>Yahoo fund profile</td></tr>
                            <tr><td>Net assets</td><td>{formatCompact(fundSummary.netAssets ?? null)}</td><td>Yahoo fund profile/statistics</td></tr>
                            <tr><td>Constituent coverage</td><td>{formatGrowth((constituents?.holdingCoverage ?? fundSummary.holdingCoverage) ?? null)}</td><td>Share of published top holdings with calculable company fundamentals.</td></tr>
                            <tr><td>Distribution yield</td><td>{formatGrowth(fundSummary.dividendYield)}</td><td>{fundSummary.metricNotes?.dividendYield ?? 'Yahoo summary detail yield.'}</td></tr>
                            <tr><td>Expense ratio</td><td>{formatGrowth(fundSummary.expenseRatio ?? null)}</td><td>{fundSummary.metricNotes?.expenseRatio ?? 'Yahoo fund profile annual report expense ratio.'}</td></tr>
                            <tr><td>Asset mix</td><td>Stocks {formatGrowth(fundSummary.stockPosition ?? null)} · Bonds {formatGrowth(fundSummary.bondPosition ?? null)}</td><td>Yahoo holdings breakdown</td></tr>
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="detail-empty">Fund metrics are still loading.</p>
                    )}

                    <p className="detail-note">Ratio metrics that let you compare this fund with others — P/E, P/B, look-through ROE, implied earnings growth, EPS growth, EW EPS growth, EW revenue growth, incremental ROIC, and payout ratio — are in the Funds table on the Compare view.</p>

                    <h3>Weighted constituent income metrics</h3>
                    {constituentsError ? (
                      <p className="detail-empty">{constituentsError}</p>
                    ) : constituents ? (
                      <div className="fund-metadata-table">
                        <table>
                          <thead>
                            <tr><th>Metric</th><th>Value</th><th>Source note</th></tr>
                          </thead>
                          <tbody>
                            <tr><td>Weighted market cap</td><td>{formatCompact(constituents.weightedMarketCap)}</td><td>{constituents.notes.marketCap ?? 'Weighted average of constituent company market caps.'}</td></tr>
                            <tr><td>Implied return</td><td>{formatGrowth(fundSummary?.impliedReturn ?? null)}</td><td>{fundSummary?.metricNotes?.impliedReturn ?? 'Implied earnings growth plus distribution yield, less expenses.'}</td></tr>
                            <tr><td>Coverage</td><td>{formatGrowth(constituents.weightedFinancials.coverage)}</td><td>Share of constituent weight with a usable latest filed period.</td></tr>
                            <tr><td>Revenue</td><td>{formatCompact(constituents.weightedFinancials.revenue)}</td><td>{constituents.weightedFinancials.notes.revenue ?? 'Weight-scaled sum of each holding’s latest period revenue.'}</td></tr>
                            <tr><td>Net income</td><td>{formatCompact(constituents.weightedFinancials.netIncome)}</td><td>{constituents.weightedFinancials.notes.netIncome ?? 'Weight-scaled sum of each holding’s latest period net income.'}</td></tr>
                            <tr><td>EPS</td><td>{constituents.weightedFinancials.eps == null ? '—' : formatNumber(constituents.weightedFinancials.eps, 2)}</td><td>{constituents.weightedFinancials.notes.eps ?? 'Weighted average of constituent latest-period EPS.'}</td></tr>
                            <tr><td>Dividend per share</td><td>{constituents.weightedFinancials.dividendsPerShare == null ? '—' : formatNumber(constituents.weightedFinancials.dividendsPerShare, 2)}</td><td>{constituents.weightedFinancials.notes.dividendsPerShare ?? 'Weighted average of constituent latest-period dividends per share.'}</td></tr>
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <p className="detail-empty">Loading weighted constituent financials…</p>
                    )}

                    <h3>Weighted constituent assets and debts</h3>
                    {constituents && !constituentsError ? (
                      <div className="fund-metadata-table">
                        <table>
                          <thead>
                            <tr><th>Metric</th><th>Value</th><th>Source note</th></tr>
                          </thead>
                          <tbody>
                            <tr><td>Assets</td><td>{formatCompact(constituents.weightedFinancials.assets)}</td><td>{constituents.weightedFinancials.notes.assets ?? 'Weight-scaled sum of each holding’s latest period total assets.'}</td></tr>
                            <tr><td>Liabilities</td><td>{formatCompact(constituents.weightedFinancials.liabilities)}</td><td>{constituents.weightedFinancials.notes.liabilities ?? 'Weight-scaled sum of each holding’s latest period total liabilities.'}</td></tr>
                            <tr><td>Equity</td><td>{formatCompact(constituents.weightedFinancials.equity)}</td><td>{constituents.weightedFinancials.notes.equity ?? 'Weight-scaled sum of each holding’s latest period stockholders’ equity.'}</td></tr>
                            <tr><td>Cash</td><td>{formatCompact(constituents.weightedFinancials.cash)}</td><td>{constituents.weightedFinancials.notes.cash ?? 'Weight-scaled sum of each holding’s latest period cash and equivalents.'}</td></tr>
                            <tr><td>Long-term debt</td><td>{formatCompact(constituents.weightedFinancials.longTermDebt)}</td><td>{constituents.weightedFinancials.notes.longTermDebt ?? 'Weight-scaled sum of each holding’s latest period long-term debt.'}</td></tr>
                            <tr><td>Short-term debt</td><td>{formatCompact(constituents.weightedFinancials.shortTermDebt)}</td><td>{constituents.weightedFinancials.notes.shortTermDebt ?? 'Weight-scaled sum of each holding’s latest period short-term debt.'}</td></tr>
                            <tr><td>Total debt</td><td>{formatCompact(constituents.weightedFinancials.totalDebt)}</td><td>{constituents.weightedFinancials.notes.totalDebt ?? 'Long-term debt plus short-term debt.'}</td></tr>
                            <tr><td>Net debt</td><td>{formatCompact(constituents.weightedFinancials.netDebt)}</td><td>{constituents.weightedFinancials.notes.netDebt ?? 'Total debt less cash.'}</td></tr>
                          </tbody>
                        </table>
                      </div>
                    ) : !constituentsError ? (
                      <p className="detail-empty">Loading weighted constituent financials…</p>
                    ) : null}
                  </>
                  )
                ) : constituentsError ? (
                  <p className="detail-empty">{constituentsError}</p>
                ) : constituents ? (
                  <FundConstituentsTable holdings={constituents.holdings} onOpenSymbol={onOpenSymbol} />
                ) : (
                  <p className="detail-empty">Loading constituent holdings…</p>
                )}
              </section>
            ) : detail.periods.length === 0 ? (
              <section className="detail-section">
                <h3>Filings</h3>
                <p className="detail-empty">No SEC filing facts are available for this symbol.</p>
              </section>
            ) : (
              <section className="detail-section">
                <div className="detail-tabs">
                  {([
                    ['financials', 'Earnings and cash'],
                    ['splits', 'Splits'],
                    ['insiders', 'Insider filings'],
                    ['balance', 'Assets and debts'],
                    ['sources', 'Where each number comes from'],
                    ['news', 'News'],
                  ] as const).map(([value, label]) => (
                    <button key={value} className={tab === value ? 'active' : ''} onClick={() => setTab(value)}>{label}</button>
                  ))}
                </div>

                {tab === 'financials' && (
                  <>
                    <div className="currency-unit-notice">
                      All monetary figures reported in <strong>{detail.currency}</strong> (per-share figures in {detail.currency}/share; share counts in shares).
                    </div>
                    <div className="table-scroll detail-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Period end</th><th>Form</th><th>Filed</th>
                            <th>Revenue ({detail.currency})</th><th>Net income ({detail.currency})</th>
                            <th>Book value / equity ({detail.currency})</th><th>Book value / share ({detail.currency}/sh)</th>
                            <th>
                              EPS ({detail.currency}/sh)
                            </th>
                            <th>
                              ROE
                              <MetricInfo
                                description="Quarterly return on equity for this reporting period, using EPS and book value per share at period end."
                                formula={String.raw`\text{ROE}_q = \dfrac{\text{EPS}_q}{\text{BVPS}_q}`}
                              />
                            </th>
                            <th>Dividend / share ({detail.currency}/sh)</th>
                            <th>
                              Payout ratio
                              <MetricInfo
                                description="Dividend payout ratio for this reporting period. Negative or zero EPS makes the ratio not meaningful."
                                formula={String.raw`\text{Payout} = \dfrac{\text{DPS}_q}{\text{EPS}_q}`}
                              />
                            </th>
                            <th>Operating cash flow ({detail.currency})</th>
                          </tr>
                        </thead>
                        <tbody>
                          {periods.map((period) => (
                            <tr
                              key={period.end}
                              className={activeEventId === `earnings:${period.end}` ? 'event-row-active' : undefined}
                              ref={(node) => { eventRowRefs.current[`earnings:${period.end}`] = node }}
                            >
                              <td><strong>{period.end}</strong>{period.fiscalYear && <small className="report-detail">FY{period.fiscalYear} {period.fiscalPeriod ?? ''}</small>}</td>
                              {filingCell(period)}
                              <td>{period.filed ?? '—'}</td>
                              {detailNumber(period.revenue, formatCompact(period.revenue), 'Revenue', 'No revenue fact was found for this reporting period.')}
                              {detailNumber(period.netIncome, formatCompact(period.netIncome), 'Net income', 'No net-income fact was found for this reporting period.')}
                              {detailNumber(period.equity, formatCompact(period.equity), 'Book value', 'No stockholders-equity fact was found near this reporting period.')}
                              {detailNumber(period.bookValuePerShare, formatNumber(period.bookValuePerShare), 'Book value per share', 'Needs stockholders’ equity and shares outstanding near this reporting period.')}
                              {detailNumber(period.eps, formatNumber(period.eps), 'EPS', 'No diluted/basic EPS fact was found for this reporting period.')}
                              {detailNumber(
                                period.returnOnEquity,
                                formatGrowth(period.returnOnEquity),
                                'ROE',
                                'Needs EPS plus positive book value per share for this reporting period.',
                                period.returnOnEquity != null && period.returnOnEquity >= 0 ? 'positive' : 'negative',
                              )}
                              {detailNumber(period.dividendsPerShare, formatNumber(period.dividendsPerShare), 'Dividend per share', 'No dividend-per-share fact, or derivable aggregate dividend/share count pair, was found for this reporting period.')}
                              {detailNumber(period.payoutRatio, formatGrowth(period.payoutRatio), 'Payout ratio', 'Needs positive EPS and dividend per share for this reporting period.')}
                              {detailNumber(period.operatingCashFlow, formatCompact(period.operatingCashFlow), 'Operating cash flow', 'No operating-cash-flow fact was found for this reporting period.')}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {tab === 'splits' && (
                  <div className="table-scroll detail-table">
                    <table>
                      <thead>
                        <tr><th>Date</th><th>Split ratio</th><th>Price marker ({detail.currency})</th></tr>
                      </thead>
                      <tbody>
                        {splitEvents.length === 0 ? (
                          <tr><td className="no-results" colSpan={3}>No split events are available in the loaded price-history window.</td></tr>
                        ) : splitEvents.map((event) => {
                          const markerId = `split:${event.date}:${event.ratio ?? ''}`
                          const point = nearestHistoryPoint(history, event.date)
                          return (
                            <tr key={markerId} className={activeEventId === markerId ? 'event-row-active' : undefined} ref={(node) => { eventRowRefs.current[markerId] = node }}>
                              <td><strong>{event.date}</strong></td>
                              <td>{event.ratio ?? ([event.numerator, event.denominator].filter((value) => value != null).join(':') || '—')}</td>
                              <td>{point ? `${point.date} · ${formatCurrency(point.price, detail.currency)}` : '—'}</td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {tab === 'insiders' && (
                  <div className="table-scroll detail-table">
                    <table>
                      <thead>
                        <tr><th>Filed</th><th>Event class</th><th>Form</th><th>Verify</th></tr>
                      </thead>
                      <tbody>
                        {insiderEvents.length === 0 ? (
                          <tr><td className="no-results" colSpan={4}>No recent SEC insider filing events were found.</td></tr>
                        ) : insiderEvents.map((event) => {
                          const markerId = `insider:${event.accession}`
                          return (
                            <tr key={markerId} className={activeEventId === markerId ? 'event-row-active' : undefined} ref={(node) => { eventRowRefs.current[markerId] = node }}>
                              <td><strong>{event.date}</strong></td>
                              <td>{event.eventClass}</td>
                              <td>Form {event.form}</td>
                              <td>
                                <div className="filing-cell">
                                  {event.filingUrl && (
                                    <a className="filing-link" href={event.filingUrl} target="_blank" rel="noreferrer">
                                      Filing <ExternalLink size={11} />
                                    </a>
                                  )}
                                  {event.filingIndexUrl && (
                                    <a className="filing-sublink" href={event.filingIndexUrl} target="_blank" rel="noreferrer">
                                      all files
                                    </a>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {tab === 'balance' && (
                  <>
                    <div className="currency-unit-notice">
                      All balance sheet figures reported in <strong>{detail.currency}</strong> (per-share figures in {detail.currency}/share; share counts in shares).
                      Missing net tangible asset inputs are shown as assumed zero.
                    </div>
                    <div className="table-scroll detail-table">
                      <table>
                        <thead>
                          <tr>
                            <th>Period end</th><th>Filing</th>
                            <th>Total assets ({detail.currency})</th><th>Intangible assets incl. goodwill ({detail.currency})</th><th>Total liabilities ({detail.currency})</th><th>Preferred stock ({detail.currency})</th><th>Equity ({detail.currency})</th>
                            <th>Cash ({detail.currency})</th><th>Long-term debt ({detail.currency})</th><th>Short-term debt ({detail.currency})</th>
                            <th>Total debt ({detail.currency})</th><th>Net debt ({detail.currency})</th>
                            <th>Shares (shares)</th>
                            <th>
                              Book value / share ({detail.currency}/sh)
                              <MetricInfo
                                description="Reported stockholders' equity divided by common shares outstanding near the reporting period."
                                formula={String.raw`\dfrac{\text{Stockholders' equity}}{\text{Common shares outstanding}}`}
                              />
                            </th>
                            <th>
                              Net tangible assets / share ({detail.currency}/sh)
                              <MetricInfo
                                description="Total assets less intangible assets including goodwill, total liabilities and preferred stock, divided by common shares outstanding. Unreported balance-sheet amounts are assumed zero; positive shares are required."
                                formula={String.raw`\dfrac{\text{Assets} - \text{Intangibles} - \text{Liabilities} - \text{Preferred stock}}{\text{Common shares outstanding}}`}
                              />
                            </th>
                            <th>Debt / equity</th>
                          </tr>
                        </thead>
                        <tbody>
                          {periods.map((period) => (
                            <tr key={period.end}>
                              <td><strong>{period.end}</strong></td>
                              {filingCell(period)}
                              {tangibleDetailNumber(period.tangibleInputs.assets, period.tangibleInputs.assumptions.filter((item) => item === 'total assets'))}
                              {tangibleDetailNumber(period.tangibleInputs.intangibleAssets, period.tangibleInputs.assumptions.filter((item) => item === 'goodwill' || item === 'other intangible assets'))}
                              {tangibleDetailNumber(period.tangibleInputs.liabilities, period.tangibleInputs.assumptions.filter((item) => item === 'total liabilities'), period.tangibleInputs.liabilitiesDerived)}
                              {tangibleDetailNumber(period.tangibleInputs.preferredStock, period.tangibleInputs.assumptions.filter((item) => item === 'preferred stock'))}
                              {detailNumber(period.equity, formatCompact(period.equity), 'Equity', 'No stockholders-equity fact was found near this reporting period.')}
                              {detailNumber(period.cash, formatCompact(period.cash), 'Cash', 'No cash-and-equivalents fact was found near this reporting period.')}
                              {detailNumber(period.longTermDebt, formatCompact(period.longTermDebt), 'Long-term debt', 'No long-term-debt fact was found near this reporting period.')}
                              {detailNumber(period.shortTermDebt, formatCompact(period.shortTermDebt), 'Short-term debt', 'No short-term/current-debt fact was found near this reporting period.')}
                              {detailNumber(period.totalDebt, formatCompact(period.totalDebt), 'Total debt', 'Needs long-term debt and/or short-term debt near this reporting period.')}
                              {detailNumber(period.netDebt, formatCompact(period.netDebt), 'Net debt', 'Needs total debt; cash is subtracted when reported.')}
                              {tangibleDetailNumber(period.tangibleInputs.shares, period.tangibleInputs.assumptions.filter((item) => item === 'common shares outstanding'))}
                              {detailNumber(period.bookValuePerShare, formatNumber(period.bookValuePerShare), 'Book value per share', 'Needs stockholders’ equity and shares outstanding near this reporting period.')}
                              {period.tangibleInputs.netTangibleAssetsPerShare == null
                                ? detailNumber(null, '—', 'Net tangible assets per share', 'Needs positive common shares outstanding; missing balance-sheet amounts are assumed zero.')
                                : tangibleDetailNumber(period.tangibleInputs.netTangibleAssetsPerShare, period.tangibleInputs.assumptions, false, formatNumber(period.tangibleInputs.netTangibleAssetsPerShare))}
                              {detailNumber(period.debtToEquity, formatNumber(period.debtToEquity), 'Debt / equity', 'Needs total debt and positive stockholders’ equity near this reporting period.')}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {tab === 'sources' && (
                  <div className="table-scroll detail-table">
                    <table>
                      <thead>
                        <tr><th>Input</th><th>XBRL tag used</th><th>Periods</th><th>Verify</th><th>Feeds which metrics</th></tr>
                      </thead>
                      <tbody>
                        {detail.sources.map((source) => (
                          <tr key={source.id}>
                            <td><strong>{source.label}</strong><small className="report-detail">{source.unit} · {source.kind}</small></td>
                            <td>
                              {source.tag
                                ? <code>{source.tag}</code>
                                : <HoverTip
                                    className="metric-missing"
                                    ariaLabel={`${source.label} not reported`}
                                    content={<><p><strong>Not reported</strong></p><p>None of these tags were found: {source.searched.join(', ')}</p></>}
                                  >not reported</HoverTip>}
                            </td>
                            <td>{source.count}</td>
                            <td>
                              {source.tag && (
                                <div className="filing-cell">
                                  {detail.latestReportUrl && (
                                    <a className="filing-link" href={detail.latestReportUrl} target="_blank" rel="noreferrer"
                                       title={`Read the latest ${detail.latestReportForm ?? 'report'} and find this figure in context`}>
                                      in filing <ExternalLink size={11} />
                                    </a>
                                  )}
                                  {source.url && (
                                    <a className="filing-sublink" href={source.url} target="_blank" rel="noreferrer"
                                       title="Raw machine-readable series for this tag">
                                      raw data
                                    </a>
                                  )}
                                </div>
                              )}
                            </td>
                            <td className="detail-feeds">{source.feeds.join(', ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}

                {tab === 'news' && newsContent}
              </section>
            )}

            {detail.filingsUrl && (
              <p className="source-line">
                Every figure above is read from SEC EDGAR XBRL company facts. Each period links to the
                filing it came from, rendered as it was filed, so a number can be read in context;
                the secondary links give the raw machine-readable data behind it.
                · <a href={detail.filingsUrl} target="_blank" rel="noreferrer">All filings for this company</a>
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

function SeriesChart({
  title,
  controls,
  loading,
  symbols,
  enabledSymbols,
  data,
  metric,
  pinnedSymbol,
  onPin,
  onDisable,
  onEnable,
  onOpenSymbol,
  fundamentals,
  histories,
  names,
  colorFor,
}: {
  title?: string
  controls?: ReactNode
  loading?: boolean
  symbols: string[]
  enabledSymbols: string[]
  data: ChartRow[]
  metric: ChartMetric
  pinnedSymbol: string | null
  onPin: (symbol: string) => void
  onDisable: (symbol: string) => void
  onEnable: (symbol: string) => void
  onOpenSymbol: (symbol: string) => void
  fundamentals: Record<string, Fundamentals>
  histories: Histories
  names: Record<string, string | undefined>
  colorFor: (symbol: string) => string
}) {
  // A pin belongs to the chart that contains the symbol; otherwise pinning a fund would
  // dim every line in the company chart as well.
  const activePin = pinnedSymbol && symbols.includes(pinnedSymbol) && enabledSymbols.includes(pinnedSymbol) ? pinnedSymbol : null
  const reportMetric = isReportMetric(metric)
  const [reportCursor, setReportCursor] = useState<{ timestamp: number; x: number; y: number; upper: boolean } | null>(null)
  const [tallTooltip, setTallTooltip] = useState(false)
  const [tooltipAbove, setTooltipAbove] = useState(false)
  const reportTooltipRef = useRef<HTMLDivElement>(null)
  const enabled = useMemo(() => new Set(enabledSymbols), [enabledSymbols])
  const includedSymbols = useMemo(() => symbols.filter((symbol) => enabled.has(symbol)), [symbols, enabled])
  const restrictDomain = activePin != null || (includedSymbols.length > 0 && includedSymbols.length < symbols.length)
  const domain = useMemo<[number | 'auto', number | 'auto']>(
    () => restrictDomain ? chartDomain(data, activePin ? [activePin] : includedSymbols) : ['auto', 'auto'],
    [data, activePin, includedSymbols, restrictDomain],
  )
  const gradientId = `areaFill-${symbols[0] ?? 'none'}`
  const reports = useMemo(
    () => reportMetric
      ? Object.fromEntries(symbols.map((symbol) => [symbol, reportEvents(fundamentals[symbol]?.quarters ?? [], metric, fundamentals[symbol]?.tangibleAssetReports, histories[symbol], fundamentals[symbol]?.currencyRateToUsd)]))
      : {},
    [symbols, fundamentals, histories, metric, reportMetric],
  )
  const currentReports = useMemo(
    () => reportCursor
      ? Object.fromEntries(includedSymbols.map((symbol) => [symbol, lastReportAt(reports[symbol] ?? [], reportCursor.timestamp)]))
      : {},
    [includedSymbols, reports, reportCursor],
  )
  const reportTooltipRows = (activePin ? [activePin] : includedSymbols).flatMap((symbol) => {
    const report = currentReports[symbol]
    return report ? [{ symbol, report }] : []
  })

  useEffect(() => { setReportCursor(null) }, [data, metric])

  useLayoutEffect(() => {
    const tooltip = reportTooltipRef.current
    const area = tooltip?.parentElement
    if (!reportCursor || !tooltip || !area) return
    const offset = 12
    const width = tooltip.offsetWidth
    const height = tooltip.offsetHeight
    const left = reportCursor.x + offset + width <= area.clientWidth
      ? reportCursor.x + offset : reportCursor.x - offset - width
    const top = reportCursor.y + offset + height <= area.clientHeight
      ? reportCursor.y + offset : reportCursor.y - offset - height
    tooltip.style.left = `${Math.max(0, Math.min(left, area.clientWidth - width))}px`
    tooltip.style.top = `${!activePin && height > area.clientHeight / 2
      ? reportCursor.y - (reportCursor.upper ? height : 0)
      : Math.max(0, Math.min(top, area.clientHeight - height))}px`
  }, [reportCursor, activePin, includedSymbols, reports, names])

  function moveReportCursor(event: React.MouseEvent<HTMLDivElement>) {
    const grid = event.currentTarget.querySelector('.recharts-cartesian-grid')?.getBoundingClientRect()
    if (!reportMetric) {
      if (!activePin && grid) setTooltipAbove(event.clientY < grid.top + grid.height / 2)
      return
    }
    if (data.length < 2) return
    const first = data[0].timestamp
    const last = data[data.length - 1].timestamp
    if (!grid || grid.width <= 0 || typeof first !== 'number' || typeof last !== 'number' ||
        event.clientX < grid.left || event.clientX > grid.right ||
        event.clientY < grid.top || event.clientY > grid.bottom) {
      setReportCursor(null)
      return
    }
    const fraction = (event.clientX - grid.left) / grid.width
    const area = event.currentTarget.getBoundingClientRect()
    setReportCursor({
      timestamp: first + fraction * (last - first),
      x: event.clientX - area.left,
      y: event.clientY - area.top,
      upper: event.clientY < grid.top + grid.height / 2,
    })
  }

  function selectTrace(symbol: string, shiftKey: boolean) {
    if (!enabled.has(symbol)) return
    if (shiftKey) {
      if (activePin === symbol) onDisable(symbol)
    } else {
      onPin(symbol)
    }
  }

  // Lets a symbol picked while scanning its trace be opened without hunting for it in the
  // legend below. Scoped to whichever chart actually holds the pinned symbol, and skipped
  // while a text input has focus so it never hijacks Enter while typing elsewhere on the page.
  useEffect(() => {
    if (!activePin) return
    const handler = (event: KeyboardEvent) => {
      if (event.key !== 'Enter') return
      const target = event.target as HTMLElement | null
      if (target && (target.closest('input, textarea, select, button, a') || target.isContentEditable)) return
      onOpenSymbol(activePin)
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [activePin, onOpenSymbol])

  return (
    <>
      {(title || controls) && (
        <div className="chart-group-header">
          {title && <h3 className="chart-group-title">{title}</h3>}
          {controls}
        </div>
      )}
      <div
        className="chart-area"
        onMouseMove={moveReportCursor}
        onMouseLeave={() => setReportCursor(null)}
        onClickCapture={(event) => {
          if (event.button === 0 && event.shiftKey && activePin) {
            const grid = event.currentTarget.querySelector('.recharts-cartesian-grid')?.getBoundingClientRect()
            if (grid && grid.width > 0 && grid.height > 0 &&
                event.clientX >= grid.left && event.clientX <= grid.right &&
                event.clientY >= grid.top && event.clientY <= grid.bottom) {
              event.stopPropagation()
              onDisable(activePin)
              return
            }
          }
          if (symbols.length !== 1 || metric !== 'price' || event.button !== 0) return
          const target = event.target
          if (target instanceof Element && target.closest('.recharts-area-curve, .recharts-active-dot')) {
            selectTrace(symbols[0], event.shiftKey)
          }
        }}
        onDoubleClickCapture={(event) => {
          if (symbols.length !== 1 || metric !== 'price' || event.button !== 0 || event.shiftKey) return
          const target = event.target
          if (target instanceof Element && target.closest('.recharts-area-curve, .recharts-active-dot')) {
            if (enabled.has(symbols[0])) onOpenSymbol(symbols[0])
            else onEnable(symbols[0])
          }
        }}
      >
        {loading ? (
          <div className="loading-state"><span className="large-loader" /> Loading market and filing data…</div>
        ) : data.length === 0 || (reportMetric && !symbols.some((symbol) => reports[symbol]?.length)) ? (
          <div className="empty-state">{reportMetric ? 'No report data available for this range.' : 'No price history available for these symbols.'}</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            {symbols.length === 1 && metric === 'price' ? (
              <AreaChart data={data} margin={{ top: 10, right: 18, left: 8, bottom: 0 }}>
                <defs>
                  <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor={enabled.has(symbols[0]) ? colorFor(symbols[0]) : inactiveTraceColor} stopOpacity={enabled.has(symbols[0]) ? 0.28 : 0.07} />
                    <stop offset="95%" stopColor={enabled.has(symbols[0]) ? colorFor(symbols[0]) : inactiveTraceColor} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="#26313a" strokeDasharray="3 5" vertical={false} />
                <XAxis dataKey="date" stroke="#71808c" tickLine={false} axisLine={false} minTickGap={50} />
                <YAxis stroke="#71808c" tickLine={false} axisLine={false} domain={['auto', 'auto']} />
                {enabled.has(symbols[0]) && <Tooltip contentStyle={{ background: 'rgba(17, 24, 32, 0.18)', backdropFilter: 'blur(2px)', border: '1px solid rgba(90, 110, 124, 0.3)', borderRadius: 8 }} />}
                <Area type="linear" dataKey={symbols[0]} stroke={enabled.has(symbols[0]) ? colorFor(symbols[0]) : inactiveTraceColor} strokeOpacity={enabled.has(symbols[0]) ? 1 : inactiveTraceOpacity} fill={`url(#${gradientId})`} strokeWidth={2} activeDot={enabled.has(symbols[0])} />
                <Area type="linear" dataKey={symbols[0]} stroke="transparent" strokeWidth={20} fill="none" activeDot={false} tooltipType="none" isAnimationActive={false} style={{ pointerEvents: 'stroke', cursor: 'pointer' }} />
              </AreaChart>
            ) : (
              <LineChart data={data} margin={{ top: 10, right: 18, left: 8, bottom: 0 }}>
                <CartesianGrid stroke="#26313a" strokeDasharray="3 5" vertical={false} />
                <XAxis
                  dataKey={reportMetric ? 'timestamp' : 'date'}
                  type={reportMetric ? 'number' : 'category'}
                  scale={reportMetric ? 'time' : 'auto'}
                  domain={reportMetric ? ['dataMin', 'dataMax'] : undefined}
                  tickFormatter={reportMetric ? (value) => new Date(Number(value)).toISOString().slice(0, 10) : undefined}
                  stroke="#71808c" tickLine={false} axisLine={false} minTickGap={50}
                />
                <YAxis
                  stroke="#71808c"
                  tickLine={false}
                  axisLine={false}
                  domain={domain}
                  allowDataOverflow={restrictDomain}
                  tickFormatter={(value) => isPercentMetric(metric)
                    ? `${Number(value).toFixed(metric === 'relative' ? 0 : 2)}%`
                    : metric === 'priceToBook' || metric === 'priceToNetTangibleAssets' ? Number(value).toFixed(2) : String(Math.round(value))}
                />
                {!reportMetric && (
                  <Tooltip
                    content={<ComparisonTooltip metric={metric} pinnedSymbol={activePin} enabledSymbols={enabledSymbols} names={names} onTallChange={setTallTooltip} />}
                    cursor={{ stroke: '#3a4a54' }}
                    allowEscapeViewBox={{ x: false, y: !activePin && tallTooltip }}
                    reverseDirection={{ x: false, y: !activePin && tallTooltip && tooltipAbove }}
                    offset={!activePin && tallTooltip ? 0 : 10}
                    isAnimationActive={!tallTooltip}
                  />
                )}
                {reportMetric && reportCursor && <ReferenceLine x={reportCursor.timestamp} stroke="#3a4a54" ifOverflow="hidden" style={{ pointerEvents: 'none' }} />}
                {symbols.map((symbol) => {
                  const dimmed = activePin != null && activePin !== symbol
                  const lineOpacity = enabled.has(symbol) ? (dimmed ? 0.2 : 1) : inactiveTraceOpacity * (dimmed ? 0.6 : 1)
                  const lineColor = enabled.has(symbol) ? colorFor(symbol) : inactiveTraceColor
                  return (
                    <Line
                      key={symbol}
                      type="linear"
                      dataKey={symbol}
                      dot={reportMetric ? (props: unknown) => {
                        const { cx, cy, value, index, payload } = props as { cx?: number; cy?: number; value?: number; index: number; payload?: ChartRow }
                        if (cx == null || cy == null || value == null || !Number.isFinite(value)) return <g key={index} />
                        const highlighted = currentReports[symbol]?.timestamp === payload?.timestamp
                        return (
                          <g
                            key={index}
                            style={{ cursor: 'pointer' }}
                            onClick={(event) => { selectTrace(symbol, event.shiftKey) }}
                            onDoubleClick={(event) => {
                              if (event.shiftKey) return
                              if (enabled.has(symbol)) onOpenSymbol(symbol)
                              else onEnable(symbol)
                            }}
                          >
                            <circle cx={cx} cy={cy} r={highlighted ? 6 : 5} fill={lineColor} opacity={lineOpacity} stroke={highlighted ? '#fff' : undefined} strokeWidth={highlighted ? 2 : undefined} />
                            <circle cx={cx} cy={cy} r={10} fill="transparent" />
                          </g>
                        )
                      } : false}
                      connectNulls
                      isAnimationActive={false}
                      stroke={lineColor}
                      strokeWidth={activePin === symbol ? 3 : 2}
                      strokeOpacity={reportMetric ? lineOpacity * 0.35 : lineOpacity}
                      activeDot={!reportMetric && enabled.has(symbol) ? (props: unknown) => {
                        const { cx, cy, value } = props as { cx?: number; cy?: number; value?: number }
                        if (typeof cx !== 'number' || !Number.isFinite(cx) ||
                            typeof cy !== 'number' || !Number.isFinite(cy) ||
                            typeof value !== 'number' || !Number.isFinite(value) ||
                            (restrictDomain && typeof domain[0] === 'number' && typeof domain[1] === 'number' &&
                              (value < domain[0] || value > domain[1]))) return <g />
                        return (
                          <circle
                            cx={cx}
                            cy={cy}
                            r={4}
                            fill={lineColor}
                            stroke="#fff"
                            strokeWidth={2}
                            opacity={lineOpacity}
                            style={{ cursor: 'pointer' }}
                            onClick={(event) => { selectTrace(symbol, event.shiftKey) }}
                            onDoubleClick={(event) => { if (!event.shiftKey) onOpenSymbol(symbol) }}
                          />
                        )
                      } : false}
                    />
                  )
                })}
                {/* Transparent wide overlays give each line a generous click target,
                    since a 2px stroke is nearly impossible to hit precisely. */}
                {symbols.map((symbol) => (
                  <Line
                    key={`${symbol}-hit`}
                    type="linear"
                    dataKey={symbol}
                    dot={false}
                    connectNulls
                    isAnimationActive={false}
                    legendType="none"
                    tooltipType="none"
                    activeDot={false}
                    stroke="transparent"
                    strokeWidth={20}
                    style={{ cursor: 'pointer', pointerEvents: 'stroke' }}
                    onClick={(_props, event) => {
                      selectTrace(symbol, event.shiftKey)
                    }}
                    onDoubleClick={(_props, event) => {
                      if (event.shiftKey) return
                      if (enabled.has(symbol)) onOpenSymbol(symbol)
                      else onEnable(symbol)
                    }}
                  />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        )}
        {reportMetric && reportCursor && reportTooltipRows.length > 0 && (
          <div
            ref={reportTooltipRef}
            className="chart-report-tooltip chart-tooltip"
          >
            <p className="chart-tooltip-label">{new Date(reportCursor.timestamp).toISOString().slice(0, 10)}</p>
            {reportTooltipRows.map(({ symbol, report }) => (
              <p key={symbol} style={{ color: colorFor(symbol) }}>
                {symbol}: {metric === 'priceToNetTangibleAssets' ? `${report.value.toFixed(2)}×` : `${report.value.toFixed(2)}%`}<small> · {report.date}</small>
                {report.assumptions?.some((item) => item !== 'preferred stock') && <small> · assumed zero: {report.assumptions.filter((item) => item !== 'preferred stock').join(', ')}</small>}
              </p>
            ))}
            {reportTooltipRows.length === 1 && names[reportTooltipRows[0].symbol] && (
              <p className="chart-tooltip-name">{names[reportTooltipRows[0].symbol]}</p>
            )}
            {activePin && <p className="chart-tooltip-hint">Tracking {activePin} · press Enter or double-click/double-tap the line to open details · press Escape or click outside the chart controls to reset</p>}
          </div>
        )}
      </div>
      {/* The legend is deliberately rendered outside the chart: Recharts' own <Legend> is
          laid out inside the plot box, so a long symbol list silently shrank the graph.
          Keeping it here holds the plot at a constant height and scrolls instead. */}
      {!loading && symbols.length > 0 && (
        <div className="chart-legend">
          {symbols.map((symbol) => (
            <HoverTip
              key={symbol}
              className="legend-label"
              ariaLabel={`${symbol} details${enabled.has(symbol) ? '' : ' (inactive)'}`}
              hoverOnly
              content={
                <>
                  <p><strong>{symbol}</strong></p>
                  <p>{fundamentals[symbol]?.name ?? 'Company name unavailable'}</p>
                  {fundamentals[symbol]?.exchange && <p className="legend-tip-exchange">{fundamentals[symbol].exchange}</p>}
                  <p className="legend-tip-hint">{enabled.has(symbol) ? 'Click the link to open details' : 'Inactive · double-click the trace or re-enable under Symbols'}</p>
                </>
              }
            >
              <span
                className={`legend-chip${activePin === symbol ? ' active' : ''}`}
                style={{ opacity: !enabled.has(symbol) ? 0.48 : activePin == null || activePin === symbol ? 1 : 0.45 }}
                onClick={() => selectTrace(symbol, false)}
              >
                <i style={{ background: enabled.has(symbol) ? colorFor(symbol) : inactiveTraceColor }} />
                {symbol}
                <button
                  className="legend-detail-link"
                  aria-label={`View ${symbol} source data`}
                  onClick={(event) => {
                    event.stopPropagation()
                    onOpenSymbol(symbol)
                  }}
                >
                  <ExternalLink size={12} />
                </button>
              </span>
            </HoverTip>
          ))}
        </div>
      )}
    </>
  )
}

function renderFormula(formula: string) {  try {
    return katex.renderToString(formula, { throwOnError: false, displayMode: false })
  } catch {
    return formula
  }
}

/**
 * The light theme inverts the whole page via a `filter` on <body> (see styles.css). Per the
 * CSS spec, an element with a non-none `filter` becomes the containing block for any
 * `position: fixed` descendants, exactly like `transform` does. Since these tooltips are
 * `position: fixed` and were being portaled into `document.body`, that turned them from
 * "fixed to the viewport" into "fixed to the (tall, scrollable) body box" whenever light
 * theme was active — so after scrolling the page, tooltips rendered far too high. Portaling
 * into a dedicated root appended as a sibling of <body> (a child of <html>, outside the
 * filtered subtree) keeps them genuinely viewport-fixed regardless of theme or scroll.
 */
function getTooltipRoot(): HTMLElement {
  let root = document.getElementById('tooltip-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'tooltip-root'
    document.documentElement.appendChild(root)
  }
  return root
}

/**
 * Same reasoning as `getTooltipRoot`: the symbol detail overlay is `position: fixed`, so it
 * must be portaled outside <body> to stay genuinely fixed to the viewport instead of to the
 * body's (filtered, scrollable) box in light theme — otherwise it renders offset by however
 * far the page happened to be scrolled, and its own scrollable range gets thrown off too.
 */
function getOverlayRoot(): HTMLElement {
  let root = document.getElementById('overlay-root')
  if (!root) {
    root = document.createElement('div')
    root.id = 'overlay-root'
    document.documentElement.appendChild(root)
  }
  return root
}

function HoverTip({
  children,
  className,
  content,
  ariaLabel,
  hoverOnly = false,
  touchOnlyPin = false,
  interactiveChild = false,
  placement = 'below',
  popoverClassName,
}: {
  children: React.ReactNode
  className?: string
  content: React.ReactNode
  ariaLabel?: string
  hoverOnly?: boolean
  touchOnlyPin?: boolean
  interactiveChild?: boolean
  placement?: 'above' | 'below'
  popoverClassName?: string
}) {
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  // There's no hover on touch screens, so a tap "pins" the tip open (instead of the
  // hover-timeout close below) until the user taps it again or taps anywhere else.
  const [pinnedOpen, setPinnedOpen] = useState(false)
  const triggerRef = useRef<HTMLSpanElement>(null)
  const popoverRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number>()
  const pointerType = useRef('')

  function show() {
    window.clearTimeout(closeTimer.current)
    const rect = triggerRef.current?.getBoundingClientRect()
    if (rect) setAnchor({ top: placement === 'above' ? rect.top - 8 : rect.bottom + 8, left: rect.left + rect.width / 2 })
  }
  function hide() {
    if (pinnedOpen) return
    closeTimer.current = window.setTimeout(() => setAnchor(null), 100)
  }
  function toggle(event: React.MouseEvent) {
    event.stopPropagation()
    if (pinnedOpen) {
      setPinnedOpen(false)
      setAnchor(null)
    } else {
      setPinnedOpen(true)
      show()
    }
  }

  useEffect(() => () => window.clearTimeout(closeTimer.current), [])

  useLayoutEffect(() => {
    const popover = popoverRef.current
    const trigger = triggerRef.current
    if (!anchor || !popover || !trigger) return
    function position() {
      if (!popover || !trigger || !anchor) return
      const gap = 8
      const margin = 8
      const rect = trigger.getBoundingClientRect()
      const { width, height } = popover.getBoundingClientRect()
      const left = Math.max(margin, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - margin))
      const below = rect.bottom + gap
      const above = rect.top - gap - height
      let top = placement === 'above' ? above : below
      if (placement === 'above' && top < margin && below + height <= window.innerHeight - margin) top = below
      if (placement === 'below' && top + height > window.innerHeight - margin && above >= margin) top = above
      popover.style.left = `${left}px`
      popover.style.top = `${Math.max(margin, Math.min(top, window.innerHeight - height - margin))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(popover)
    window.addEventListener('resize', position)
    return () => { observer.disconnect(); window.removeEventListener('resize', position) }
  }, [anchor, placement])

  // Dismiss a pinned-open tip on the next tap anywhere else on the page.
  useEffect(() => {
    if (!pinnedOpen) return
    function dismiss() {
      setPinnedOpen(false)
      setAnchor(null)
    }
    document.addEventListener('touchstart', dismiss)
    return () => document.removeEventListener('touchstart', dismiss)
  }, [pinnedOpen])

  return (
    <span
      ref={triggerRef}
      className={className}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={(event) => { if (!hoverOnly || event.target.matches(':focus-visible')) show() }}
      onBlur={hide}
      onPointerDown={(event) => { pointerType.current = event.pointerType }}
      onClick={hoverOnly ? undefined : (event) => {
        if (!touchOnlyPin || pointerType.current === 'touch') toggle(event)
      }}
      tabIndex={interactiveChild ? undefined : 0}
      aria-label={interactiveChild ? undefined : ariaLabel}
      aria-expanded={interactiveChild ? undefined : anchor != null}
    >
      {children}
      {anchor &&
        createPortal(
          <div
            ref={popoverRef}
            className={`metric-info-popover${popoverClassName ? ` ${popoverClassName}` : ''}`}
            role="tooltip"
            style={{ top: anchor.top, left: anchor.left }}
            onMouseEnter={show}
            onMouseLeave={hide}
          >
            {content}
          </div>,
          getTooltipRoot(),
        )}
    </span>
  )
}

function MetricExplanation({ description, formula }: { description?: string; formula?: string }) {
  const formulaRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = formulaRef.current
    const math = container?.querySelector<HTMLElement>('.katex')
    if (!container || !math) return
    function fit() {
      if (!container || !math) return
      container.style.fontSize = ''
      const naturalWidth = math.getBoundingClientRect().width
      if (naturalWidth > container.clientWidth) container.style.fontSize = `${container.clientWidth / naturalWidth}em`
    }
    fit()
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    window.addEventListener('resize', fit)
    return () => { observer.disconnect(); window.removeEventListener('resize', fit) }
  }, [formula])
  return (
    <>
      {description && <p>{description}</p>}
      {formula && <div ref={formulaRef} className="metric-info-formula" dangerouslySetInnerHTML={{ __html: renderFormula(formula) }} />}
    </>
  )
}

function MetricInfo({ description, formula }: { description?: string; formula?: string }) {
  if (!description && !formula) return null
  return (
    <HoverTip
      className="metric-info"
      ariaLabel="Metric details"
      content={<MetricExplanation description={description} formula={formula} />}
    >
      ⓘ
    </HoverTip>
  )
}

function MissingMetric({ item, metric, label, note, touchOnlyPin = false }: {
  item: Fundamentals
  metric: string
  label: string
  note?: string
  touchOnlyPin?: boolean
}) {
  const source = missingMetricSource(item, metric)
  const reason = (
    <>
      <p><strong>{label} unavailable</strong></p>
      <p>{note ?? 'This metric could not be calculated from the available data.'}</p>
      {source && <p className="metric-source-action">Open {source.label} in a new tab</p>}
    </>
  )
  return (
    <HoverTip
      className="metric-missing"
      ariaLabel={`Why ${label} is unavailable`}
      hoverOnly={!!source}
      interactiveChild={!!source}
      touchOnlyPin={touchOnlyPin}
      popoverClassName={source ? 'metric-source-popover' : undefined}
      content={source ? <a href={source.url} target="_blank" rel="noreferrer">{reason}</a> : reason}
    >
      {source
        ? <a href={source.url} target="_blank" rel="noreferrer" aria-label={`${label} unavailable; open ${source.label} for ${item.symbol}`}>—</a>
        : '—'}
    </HoverTip>
  )
}

function ChartMetricControl({ value, label, active, onSelect, fund = false }: {
  value: ChartMetric
  label: string
  active: boolean
  onSelect: () => void
  fund?: boolean
}) {
  const definition = value === 'relative'
    ? {
        description: 'Price change from the first price in the displayed range.',
        formula: String.raw`\text{Change} = \dfrac{P_t - P_0}{P_0} \times 100`,
      }
    : value === 'price'
      ? { description: 'Historical price converted to USD where necessary.' }
      : fund && value === 'yield'
        ? fundColumns.find((column) => column.id === 'dividendYield')
        : comparisonColumns.find((column) => column.id === value)
  const button = <button className={active ? 'active' : ''} onClick={onSelect}>{label}</button>
  if (!definition?.description && !definition?.formula) return button
  return (
    <HoverTip
      className="chart-metric-control"
      hoverOnly
      interactiveChild
      placement="above"
      content={<MetricExplanation description={definition.description} formula={definition.formula} />}
    >
      {button}
    </HoverTip>
  )
}

function SymbolSearch({ onSelect, mode, collectionKind }: {
  onSelect: (symbol: string) => void
  mode: 'add' | 'open'
  collectionKind?: CollectionKind
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<SearchResult[]>([])
  const [loading, setLoading] = useState(false)
  const [resultsOpen, setResultsOpen] = useState(false)
  const searchRef = useRef<HTMLFormElement>(null)

  useEffect(() => {
    if (!resultsOpen) return
    const dismiss = (event: PointerEvent) => {
      if (!searchRef.current?.contains(event.target as Node)) setResultsOpen(false)
    }
    document.addEventListener('pointerdown', dismiss)
    return () => document.removeEventListener('pointerdown', dismiss)
  }, [resultsOpen])

  useEffect(() => {
    let active = true
    setResults([])
    setLoading(false)
    if (query.trim().length < 1) {
      return
    }
    const timer = window.setTimeout(async () => {
      setLoading(true)
      try {
        const found = await api.search(query)
        if (active) setResults(found)
      } catch {
        if (active) setResults([])
      } finally {
        if (active) setLoading(false)
      }
    }, 300)
    return () => { active = false; window.clearTimeout(timer) }
  }, [query])

  function select(symbol: string) {
    const normalized = symbol.trim().toUpperCase()
    if (!normalized) return
    onSelect(normalized)
    setQuery('')
    setResults([])
    setResultsOpen(false)
  }

  function submit() {
    select(submittedSymbol(query, results))
  }

  return (
    <form
      ref={searchRef}
      className={`search-wrap ${mode === 'add' ? 'collection-search' : 'detail-search'}`}
      onSubmit={(event) => { event.preventDefault(); submit() }}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && resultsOpen) {
          event.stopPropagation()
          setResultsOpen(false)
        }
      }}
    >
      <Search size={17} />
      <input
        value={query}
        onChange={(event) => { setQuery(event.target.value); setResultsOpen(true) }}
        onFocus={() => setResultsOpen(true)}
        onClick={() => setResultsOpen(true)}
        placeholder={mode === 'add' ? 'Add ticker or company' : 'Open ticker or company'}
        aria-label={mode === 'add'
          ? `Add symbol to ${collectionKind === 'portfolio' ? 'portfolio' : 'analysis collection'}`
          : 'Open symbol details'}
      />
      {loading && <span className="search-loader" />}
      <button className="search-submit" type="submit">{mode === 'add' ? 'Add' : 'Open'}</button>
      {resultsOpen && results.length > 0 && (
        <div className="search-results">
          {results.map((result) => (
            <button
              type="button"
              key={result.symbol}
              onClick={() => select(result.symbol)}
            >
              <span><strong>{result.symbol}</strong>{result.name}</span>
              <small>{result.exchange}</small>
              {mode === 'add' ? <Plus size={16} /> : <ExternalLink size={16} />}
            </button>
          ))}
        </div>
      )}
    </form>
  )
}

/**
 * Renders one metric cell for the company comparison table.
 *
 * This is a pure function of the column and the row's data, with no dependency on any
 * component's state, so it is shared between the main Compare table and the fund
 * constituents table on a fund's detail page — both need the exact same metrics,
 * formatting, and "why is this missing" tooltips.
 */
function renderMetricCell(column: ColumnId, item: Fundamentals, touchOnlyPin = false) {
  const label = comparisonColumns.find((entry) => entry.id === column)?.label ?? column
  const note = item.metricNotes?.[column]

  // Renders an unavailable metric as a hoverable marker explaining which upstream
  // input was missing, rather than a bare dash.
  function unavailable() {
    return <MissingMetric item={item} metric={column} label={label} note={note} touchOnlyPin={touchOnlyPin} />
  }

  function cell(value: number | null | undefined, formatted: string, className?: string, tooltipContent?: ReactNode) {
    if (value == null) return <td key={column}>{unavailable()}</td>
    if (tooltipContent) {
      return (
        <td key={column} className={className}>
          <HoverTip className="metric-tip-inline" ariaLabel={`${label} info`} content={tooltipContent}>
            {formatted}
          </HoverTip>
        </td>
      )
    }
    return (
      <td key={column} className={className}>
        {formatted}
      </td>
    )
  }

  const growthClass = (value: number | null | undefined) => ((value ?? 0) >= 0 ? 'positive' : 'negative')

  switch (column) {
    case 'region':
      return <td key={column}>{item.region ?? unavailable()}</td>
    case 'price': {
      const isForeign = item.currency && item.currency !== 'USD'
      const tooltip = isForeign ? (
        <>
          <p><strong>Price in USD</strong></p>
          <p>Converted from {item.currency} (1 {item.currency} = ${item.currencyRateToUsd ? (item.currencyRateToUsd >= 1 ? item.currencyRateToUsd.toFixed(4) : item.currencyRateToUsd.toPrecision(4)) : '1.00'} USD).</p>
          <p>Original price: <strong>{formatCurrency(item.rawPrice ?? item.price, item.currency)}</strong></p>
        </>
      ) : null
      return cell(item.price, `$${formatNumber(item.price)}`, undefined, tooltip)
    }
    case 'marketCap': {
      const isForeign = item.currency && item.currency !== 'USD'
      const tooltip = isForeign ? (
        <>
          <p><strong>Market cap in USD</strong></p>
          <p>Converted to USD from {item.currency} (1 {item.currency} = ${item.currencyRateToUsd ? (item.currencyRateToUsd >= 1 ? item.currencyRateToUsd.toFixed(4) : item.currencyRateToUsd.toPrecision(4)) : '1.00'} USD).</p>
          <p>Original market cap: <strong>{formatCompact(item.rawMarketCap)} {item.currency}</strong></p>
        </>
      ) : null
      return cell(item.marketCap, formatCompact(item.marketCap), undefined, tooltip)
    }
    case 'pe':
      return cell(item.pe, `${formatNumber(item.pe, 1)}×`)
    case 'priceToBook':
      return cell(item.priceToBook, `${formatNumber(item.priceToBook, 1)}×`)
    case 'priceToNetTangibleAssets': {
      const tooltip = note ? (
        <><p><strong>Price / net tangible assets</strong></p><p>{note}</p></>
      ) : null
      return cell(item.priceToNetTangibleAssets, `${formatNumber(item.priceToNetTangibleAssets, 1)}×${note ? ' *' : ''}`, undefined, tooltip)
    }
    case 'earningsGrowth':
      return cell(item.earningsGrowth, formatGrowth(item.earningsGrowth), growthClass(item.earningsGrowth))
    case 'ewEpsGrowth':
      return cell(item.ewEpsGrowth, formatGrowth(item.ewEpsGrowth), growthClass(item.ewEpsGrowth))
    case 'ewRevenueGrowth':
      return cell(item.ewRevenueGrowth, formatGrowth(item.ewRevenueGrowth), growthClass(item.ewRevenueGrowth))
    case 'incrementalRoic':
      return cell(item.incrementalRoic, formatGrowth(item.incrementalRoic), growthClass(item.incrementalRoic))
    case 'sustainableGrowth':
      return cell(item.sustainableGrowth, formatGrowth(item.sustainableGrowth), growthClass(item.sustainableGrowth))
    case 'dividendYield':
      return cell(item.dividendYield, formatGrowth(item.dividendYield), growthClass(item.dividendYield))
    case 'impliedReturn':
      return cell(item.impliedReturn, formatGrowth(item.impliedReturn), growthClass(item.impliedReturn))
    case 'lastReport': {
      const latest = item.quarters.at(-1)
      return (
        <td key={column}>
          <span>{latest?.end ?? unavailable()}</span>
          {latest && (
            <small className="report-detail">
              EPS {formatNumber(latest.eps)} · Rev {formatCompact(latest.revenue)}
            </small>
          )}
        </td>
      )
    }
  }
}

const fundConstituentColumnsStorageKey = 'market-lens.fund-constituent-columns'
type ConstituentSortKey = ColumnId | 'symbol' | 'weight'

/**
 * The stocks that make up a fund, shown with the exact same metrics, column visibility
 * controls, and sorting as the main Compare table, plus each holding's weight in the fund.
 */
function FundConstituentsTable({
  holdings,
  onOpenSymbol,
}: {
  holdings: FundConstituentHolding[]
  onOpenSymbol: (symbol: string) => void
}) {
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(() =>
    readStoredList(fundConstituentColumnsStorageKey, defaultColumns, defaultColumns),
  )
  const [sort, setSort] = useState<{ key: ConstituentSortKey; direction: 'asc' | 'desc' }>({ key: 'weight', direction: 'desc' })
  const [topN, setTopN] = useState('30')
  const isMobile = useIsMobile()

  useEffect(() => {
    storeList(fundConstituentColumnsStorageKey, visibleColumns)
  }, [visibleColumns])

  function toggleColumn(column: ColumnId) {
    setVisibleColumns((current) =>
      current.includes(column)
        ? current.filter((item) => item !== column)
        : comparisonColumns.map((item) => item.id).filter((item) => current.includes(item) || item === column),
    )
  }

  function changeSort(key: ConstituentSortKey) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }))
  }

  function sortIcon(key: ConstituentSortKey) {
    if (sort.key !== key) return <ArrowUpDown size={12} />
    return sort.direction === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />
  }

  function sortValue(item: FundConstituentHolding, key: ConstituentSortKey): number | string | null {
    if (key === 'symbol') return item.symbol
    if (key === 'region') return item.region ?? null
    if (key === 'weight') return item.weight
    if (key === 'lastReport') return item.quarters.at(-1)?.end ?? null
    return item[key]
  }

  const sorted = useMemo(() => {
    // Always pick the top N holdings by weight first (the fund's biggest positions), then
    // apply whatever display sort/order the user has chosen to that fixed subset — so
    // switching sort columns reorders the same top holdings rather than changing which ones
    // qualify.
    const limit = parseOptionalNumber(topN)
    const byWeight = [...holdings].sort((left, right) => (right.weight ?? -Infinity) - (left.weight ?? -Infinity))
    const list = limit == null || limit <= 0 ? byWeight : byWeight.slice(0, Math.floor(limit))
    list.sort((left, right) => {
      const leftValue = sortValue(left, sort.key)
      const rightValue = sortValue(right, sort.key)
      if (leftValue == null && rightValue == null) return 0
      if (leftValue == null) return 1
      if (rightValue == null) return -1
      const comparison = typeof leftValue === 'string'
        ? leftValue.localeCompare(String(rightValue))
        : leftValue - Number(rightValue)
      return sort.direction === 'desc' ? -comparison : comparison
    })
    return list
  }, [holdings, sort, topN])

  if (holdings.length === 0) {
    return <p className="detail-empty">No published top holdings had usable company fundamentals to show here.</p>
  }

  return (
    <>
      <div className="table-group-header">
        <h4 className="detail-subheading">Constituent stocks</h4>
        <label className="min-weight-filter">
          <span>Show top</span>
          <input
            type="number"
            step="1"
            min="1"
            value={topN}
            onChange={(event) => setTopN(event.target.value)}
          />
        </label>
        <details className="column-picker">
          <summary><Settings2 size={15} /> Columns <b>{visibleColumns.length}</b></summary>
          <div className="column-menu">
            <div className="column-menu-heading">
              <strong>Visible metrics</strong>
              <button
                type="button"
                onClick={() => setVisibleColumns(visibleColumns.length === comparisonColumns.length ? [] : defaultColumns)}
              >
                {visibleColumns.length === comparisonColumns.length ? 'Hide all' : 'Show all'}
              </button>
              <button type="button" onClick={() => setVisibleColumns(defaultColumns)}>Reset</button>
            </div>
            {comparisonColumns.map((column) => (
              <label key={column.id}>
                <input
                  type="checkbox"
                  checked={visibleColumns.includes(column.id)}
                  onChange={() => toggleColumn(column.id)}
                />
                <span>{column.label}</span>
              </label>
            ))}
          </div>
        </details>
      </div>
      <div className="table-scroll detail-table">
        <table>
          <thead>
            <tr>
              <th><button className="sort-button" onClick={() => changeSort('symbol')}>Company {sortIcon('symbol')}</button></th>
              <th><button className="sort-button" onClick={() => changeSort('weight')}>Weight {sortIcon('weight')}</button></th>
              {comparisonColumns
                .filter((column) => visibleColumns.includes(column.id))
                .map((column) => (
                  <th key={column.id}>
                    <button className="sort-button" onClick={() => changeSort(column.id)}>
                      {column.label} {sortIcon(column.id)}
                    </button>
                    <MetricInfo description={column.description} formula={column.formula} />
                  </th>
                ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((item) => (
              <tr key={item.symbol}>
                <td>
                  <button className="symbol-open" onClick={() => onOpenSymbol(item.symbol)} title={`Show source data for ${item.symbol}`}>
                    <strong>{item.symbol}</strong>
                    <small>{isMobile ? truncateAtWordBoundary(item.name, 16) : item.name}</small>
                    <small className="symbol-exchange">{isMobile ? truncateAtWordBoundary(item.fullExchange || item.exchange, 16) : (item.fullExchange || item.exchange)}</small>
                  </button>
                </td>
                <td>{item.weight == null ? '—' : formatGrowth(item.weight * 100)}</td>
                {visibleColumns.map((column) => renderMetricCell(column, item))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <small className="constituent-filter-note">
        Showing {sorted.length} of {holdings.length} published holdings with usable fundamentals.
        {sorted.length !== holdings.length ? ' Increase min weight to narrow further, or clear it to see all.' : ''}
        {' '}Yahoo’s published top-holdings list only covers a fund’s largest positions, so holdings below Yahoo’s own cutoff won’t appear here regardless of this filter.
      </small>
    </>
  )
}

function App() {
  const [view, setView] = useState<'chart' | 'compare'>('chart')
  const isMobile = useIsMobile()
  const [theme, setTheme] = useState<Theme>(readTheme)
  const [workspace, setWorkspace] = useState<Workspace>(readWorkspace)
  const [visibleColumns, setVisibleColumns] = useState<ColumnId[]>(() =>
    readCompanyColumns(),
  )
  const [visibleFundColumns, setVisibleFundColumns] = useState<FundColumnId[]>(() =>
    readStoredList(fundColumnsStorageKey, defaultFundColumns, defaultFundColumns),
  )
  const [visibleBondColumns, setVisibleBondColumns] = useState<BondColumnId[]>(() =>
    readStoredList(bondColumnsStorageKey, defaultBondColumns, defaultBondColumns),
  )
  const [filters, setFilters] = useState<ScreenerFilters>(() => readStoredObject(screenerStorageKey, defaultFilters))
  const [sort, setSort] = useState<{ key: SortKey; direction: SortDirection }>({
    key: 'marketCap',
    direction: 'desc',
  })
  const [fundSort, setFundSort] = useState<{ key: 'symbol' | FundColumnId; direction: SortDirection }>({
    key: 'netAssets',
    direction: 'desc',
  })
  const [bondSort, setBondSort] = useState<{ key: 'symbol' | BondColumnId; direction: SortDirection }>({
    key: 'netAssets',
    direction: 'desc',
  })
  const [metric, setMetric] = useState<ChartMetric>('relative')
  // Funds are charted on their own measure: they report no quarterly EPS, so a P/E
  // series cannot be built for them the way it can for an operating company.
  const [fundMetric, setFundMetric] = useState<ChartMetric>('relative')
  const [range, setRange] = useState<Range>('1y')
  const [detailRange, setDetailRange] = useState<Range>('1y')
  const [pinnedSymbol, setPinnedSymbol] = useState<string | null>(null)
  const [symbolsCollapsed, setSymbolsCollapsed] = useState(true)
  const [histories, setHistories] = useState<Histories>({})
  const historyCacheRef = useRef<Histories>({})
  const historyRequestsRef = useRef<Record<string, Promise<PricePoint[]>>>({})
  const [detailHistories, setDetailHistories] = useState<Histories>({})
  const [detailHistoryEvents, setDetailHistoryEvents] = useState<HistoryEvents>({})
  const [fundamentals, setFundamentals] = useState<Record<string, Fundamentals>>({})
  const fundamentalsRef = useRef<Record<string, Fundamentals>>({})
  const fundamentalsRequestsRef = useRef<Record<string, Promise<Fundamentals>>>({})
  const [loading, setLoading] = useState(true)
  const [loadProgress, setLoadProgress] = useState({ completed: 0, total: 0 })
  const [symbolErrors, setSymbolErrors] = useState<Record<string, string>>({})
  const [randomCount, setRandomCount] = useState('20')
  const [randomPool, setRandomPool] = useState<'all' | 'volume'>('all')
  const [randomRegions, setRandomRegions] = useState<RandomSampleRegion[]>(['USA'])
  const [randomMinMarketCap, setRandomMinMarketCap] = useState('')
  const [randomMaxMarketCap, setRandomMaxMarketCap] = useState('')
  const [randomLoading, setRandomLoading] = useState(false)
  const [openSymbol, setOpenSymbol] = useState<string | null>(null)
  const [symbolHistory, setSymbolHistory] = useState<string[]>([])
  const [details, setDetails] = useState<Record<string, SymbolDetail>>({})
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({})
  const [newsBySymbol, setNewsBySymbol] = useState<Record<string, SymbolNewsItem[]>>({})
  const [newsLoading, setNewsLoading] = useState<Record<string, boolean>>({})
  const [newsErrors, setNewsErrors] = useState<Record<string, string>>({})
  const newsCacheRef = useRef<Partial<Record<string, SymbolNewsItem[]>>>({})
  const newsRequestsRef = useRef<Partial<Record<string, Promise<SymbolNewsItem[]>>>>({})
  const [fundConstituents, setFundConstituents] = useState<Record<string, FundConstituentData>>({})
  const [fundConstituentErrors, setFundConstituentErrors] = useState<Record<string, string>>({})
  const [error, setError] = useState('')

  // Keep the imperative cache in sync with React state so hot reloads and any future
  // state restoration path can reuse values without issuing duplicate requests.
  fundamentalsRef.current = fundamentals

  const requestNews = useCallback((symbol: string, range: Range) => {
    const key = `${symbol}:${range}`
    if (newsCacheRef.current[key] || newsRequestsRef.current[key]) return
    setNewsLoading((current) => ({ ...current, [key]: true }))
    setNewsErrors((current) => {
      if (!current[key]) return current
      const next = { ...current }
      delete next[key]
      return next
    })
    const request = api.news(symbol, range)
      .then((result) => {
        newsCacheRef.current[key] = result.items
        setNewsBySymbol((current) => ({ ...current, [key]: result.items }))
        return result.items
      })
      .catch((reason) => {
        setNewsErrors((current) => ({
          ...current,
          [key]: reason instanceof Error ? reason.message : 'Could not load news',
        }))
        return []
      })
      .finally(() => {
        delete newsRequestsRef.current[key]
        setNewsLoading((current) => ({ ...current, [key]: false }))
      })
    newsRequestsRef.current[key] = request
  }, [])

  // News is intentionally scoped to detail pages: opening a portfolio does not fan out
  // hundreds of article requests. Each visited symbol/range pair is cached for the session.
  useEffect(() => {
    if (openSymbol) requestNews(openSymbol, detailRange)
  }, [detailRange, openSymbol, requestNews])

  // The detail overlay is `position: fixed`, so it should stay pinned to the viewport
  // regardless of scrolling. But if the page behind it is still scrollable while the overlay
  // is open, wheel input that reaches the bottom of the overlay's own scroll area bubbles up
  // and scrolls the page underneath — and in the light theme, the page-wide `filter` on
  // <body> makes body the containing block for `position: fixed` elements, so scrolling it
  // drags the "fixed" overlay along with it, sliding the header (and everything else) out of
  // view. Locking body scroll while any detail panel is open prevents both problems at once.
  useEffect(() => {
    if (!openSymbol) return
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = previousOverflow
    }
  }, [openSymbol])

  const activeCollection = useMemo(
    () => workspace.activeKind === 'portfolio'
      ? workspace.portfolios.find((item) => item.id === workspace.activeId)
      : workspace.analyses.find((item) => item.id === workspace.activeId),
    [workspace],
  )
  const collectionItems = useMemo(() => activeCollection?.items ?? [], [activeCollection])
  const alphabetizedCollectionItems = useMemo(
    () => [...collectionItems].sort((left, right) => left.symbol.localeCompare(right.symbol)),
    [collectionItems],
  )
  const symbols = useMemo(
    () => collectionItems.filter((item) => item.enabled).map((item) => item.symbol),
    [collectionItems],
  )
  const enabledSymbolSet = useMemo(() => new Set(symbols), [symbols])
  const chartSymbols = useMemo(() => collectionItems.map((item) => item.symbol), [collectionItems])
  const loadSymbols = chartSymbols

  useEffect(() => {
    storeObject(workspaceStorageKey, workspace)
  }, [workspace])

  // The theme is applied as a data attribute on the document root so plain CSS can select
  // on it, and persisted so it survives reloads until the user picks the other one.
  useEffect(() => {
    document.documentElement.dataset.theme = theme
    try {
      window.localStorage.setItem(themeStorageKey, theme)
    } catch (error) {
      console.warn('Could not save theme', error)
    }
  }, [theme])

  useEffect(() => {
    storeList(columnsStorageKey, visibleColumns)
  }, [visibleColumns])

  useEffect(() => {
    storeList(fundColumnsStorageKey, visibleFundColumns)
  }, [visibleFundColumns])

  useEffect(() => {
    storeList(bondColumnsStorageKey, visibleBondColumns)
  }, [visibleBondColumns])

  useEffect(() => {
    storeObject(screenerStorageKey, filters)
  }, [filters])

  useEffect(() => {
    setPinnedSymbol((current) => (current != null && !symbols.includes(current) ? null : current))
  }, [symbols])

  useEffect(() => {
    if (!pinnedSymbol) return
    const clearPin = (event: MouseEvent) => {
      if (event.button !== 0) return
      const target = event.target
      if (target instanceof Element && target.closest('.chart-area, .chart-legend, .chart-group-header .segmented, .chart-panel > .panel-controls .segmented')) return
      setPinnedSymbol(null)
    }
    const clearPinOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !openSymbol && !event.defaultPrevented) setPinnedSymbol(null)
    }
    document.addEventListener('click', clearPin)
    document.addEventListener('keydown', clearPinOnEscape)
    return () => {
      document.removeEventListener('click', clearPin)
      document.removeEventListener('keydown', clearPinOnEscape)
    }
  }, [pinnedSymbol, openSymbol])

  useEffect(() => {
    let active = true
    if (loadSymbols.length === 0) {
      setLoading(false)
      setLoadProgress({ completed: 0, total: 0 })
      return
    }

    // Restore the selected range immediately from the session cache. Symbols without that
    // range are removed from the current chart rather than temporarily showing another
    // range's series while their request runs.
    setHistories((current) => {
      const next = { ...current }
      for (const symbol of loadSymbols) {
        const cached = historyCacheRef.current[historyCacheKey(symbol, range)]
        if (cached) next[symbol] = cached
        else delete next[symbol]
      }
      return next
    })

    const pending = loadSymbols.filter((symbol) =>
      !fundamentalsRef.current[symbol] ||
      !historyCacheRef.current[historyCacheKey(symbol, range)],
    )
    if (pending.length === 0) {
      setLoading(false)
      setLoadProgress({ completed: 0, total: 0 })
      return
    }

    setLoading(true)
    setLoadProgress({ completed: 0, total: pending.length })
    setSymbolErrors((current) => {
      const next = { ...current }
      for (const symbol of pending) delete next[symbol]
      return next
    })
    const completed = new Set<string>()
    const markComplete = (symbol: string) => {
      completed.add(symbol)
      if (active) setLoadProgress({ completed: completed.size, total: pending.length })
    }
    mapWithConcurrency(
      pending,
      pending.length > 100 ? 3 : 5,
      async (symbol) => {
        const key = historyCacheKey(symbol, range)
        const factsPromise = fundamentalsRef.current[symbol]
          ? Promise.resolve(fundamentalsRef.current[symbol])
          : fundamentalsRequestsRef.current[symbol] ?? (
            fundamentalsRequestsRef.current[symbol] = api.fundamentals(symbol)
              .finally(() => { delete fundamentalsRequestsRef.current[symbol] })
          )
        const historyPromise = historyCacheRef.current[key]
          ? Promise.resolve(historyCacheRef.current[key])
          : historyRequestsRef.current[key] ?? (
            historyRequestsRef.current[key] = api.history(symbol, range)
              .then((result) => result.points)
              .finally(() => { delete historyRequestsRef.current[key] })
          )
        const [facts, history] = await Promise.allSettled([factsPromise, historyPromise])
        return { facts, history }
      },
      (symbol, result) => {
        const key = historyCacheKey(symbol, range)
        if (result.facts.status === 'fulfilled') {
          const facts = result.facts.value
          fundamentalsRef.current[symbol] = facts
          setFundamentals((current) => ({ ...current, [symbol]: facts }))
        }
        if (result.history.status === 'fulfilled') {
          const history = result.history.value
          historyCacheRef.current[key] = history
          if (active) setHistories((current) => ({ ...current, [symbol]: history }))
        }
        if (result.facts.status === 'rejected' && !fundamentalsRef.current[symbol] && active) {
          const reason = result.facts.reason
          setSymbolErrors((current) => ({
            ...current,
            [symbol]: reason instanceof Error
              ? reason.message
              : 'Could not load fundamentals',
          }))
        }
        markComplete(symbol)
      },
      (symbol, reason) => {
        if (!active) return
        setSymbolErrors((current) => ({
          ...current,
          [symbol]: reason instanceof Error ? reason.message : 'Could not load data',
        }))
        markComplete(symbol)
      },
    ).finally(() => active && setLoading(false))
    return () => {
      active = false
    }
  }, [loadSymbols, range])

  // Funds and operating companies are valued on different data, so they are kept apart and
  // rendered in their own table and chart. Symbols still loading are treated as companies
  // until their instrument type is known. Sorted alphabetically so the chart legend (and the
  // line draw order beneath it) lists symbols in a predictable order rather than the order
  // they happened to be added to the portfolio.
  const fundSymbols = useMemo(
    () => chartSymbols.filter((symbol) => fundamentals[symbol]?.isFund).sort((a, b) => a.localeCompare(b)),
    [chartSymbols, fundamentals],
  )
  const equitySymbols = useMemo(
    () => chartSymbols.filter((symbol) => !fundamentals[symbol]?.isFund).sort((a, b) => a.localeCompare(b)),
    [chartSymbols, fundamentals],
  )
  const chartFundSymbols = fundSymbols
  const chartEquitySymbols = equitySymbols
  // A bond-heavy fund is valued on entirely different fundamentals (credit quality, yield)
  // rather than look-through earnings, so it gets its own compare table rather than being
  // mixed in with equity-oriented funds.
  const isBondFund = useCallback((symbol: string) => {
    const item = fundamentals[symbol]
    if (!item) return false
    return (item.bondPosition ?? 0) > (item.stockPosition ?? 0)
  }, [fundamentals])
  const bondFundSymbols = useMemo(
    () => fundSymbols.filter((symbol) => isBondFund(symbol)),
    [fundSymbols, isBondFund],
  )
  const stockFundSymbols = useMemo(
    () => fundSymbols.filter((symbol) => !isBondFund(symbol)),
    [fundSymbols, isBondFund],
  )

  const chartData = useMemo(
    () => mergeSeries(chartEquitySymbols, histories, fundamentals, metric),
    [chartEquitySymbols, histories, fundamentals, metric],
  )

  const fundChartData = useMemo(
    () => mergeSeries(chartFundSymbols, histories, fundamentals, fundMetric),
    [chartFundSymbols, histories, fundamentals, fundMetric],
  )

  const screenedSymbols = useMemo(() => {
    const query = filters.query.trim().toLowerCase()
    const minMarketCap = parseOptionalNumber(filters.minMarketCap, 1_000_000_000)
    const maxMarketCap = parseOptionalNumber(filters.maxMarketCap, 1_000_000_000)
    const minPe = parseOptionalNumber(filters.minPe)
    const maxPe = parseOptionalNumber(filters.maxPe)
    const minPriceToBook = parseOptionalNumber(filters.minPriceToBook)
    const maxPriceToBook = parseOptionalNumber(filters.maxPriceToBook)
    const minEarningsGrowth = parseOptionalNumber(filters.minEarningsGrowth)
    const minRevenueGrowth = parseOptionalNumber(filters.minRevenueGrowth)

    function within(value: number | null, minimum: number | null, maximum: number | null) {
      if (minimum != null && (value == null || value < minimum)) return false
      if (maximum != null && (value == null || value > maximum)) return false
      return true
    }

    return equitySymbols
      .filter((symbol) => {
        const item = fundamentals[symbol]
        if (!item) return true
        if (query && !`${item.symbol} ${item.name}`.toLowerCase().includes(query)) return false
        if (filters.exchange !== 'all' && item.exchange !== filters.exchange) return false
        return (
          within(item.marketCap, minMarketCap, maxMarketCap) &&
          within(item.pe, minPe, maxPe) &&
          within(item.priceToBook, minPriceToBook, maxPriceToBook) &&
          within(item.earningsGrowth, minEarningsGrowth, null) &&
          within(item.ewRevenueGrowth, minRevenueGrowth, null)
        )
      })
      .sort((leftSymbol, rightSymbol) => {
        const left = fundamentals[leftSymbol]
        const right = fundamentals[rightSymbol]
        if (!left || !right) return 0
        const leftValue = sort.key === 'symbol'
          ? left.symbol
          : sort.key === 'lastReport'
            ? left.quarters.at(-1)?.end ?? null
            : left[sort.key]
        const rightValue = sort.key === 'symbol'
          ? right.symbol
          : sort.key === 'lastReport'
            ? right.quarters.at(-1)?.end ?? null
            : right[sort.key]
        if (leftValue == null && rightValue == null) return 0
        if (leftValue == null) return 1
        if (rightValue == null) return -1
        const comparison = typeof leftValue === 'string'
          ? leftValue.localeCompare(String(rightValue))
          : leftValue - Number(rightValue)
        return sort.direction === 'asc' ? comparison : -comparison
      })
  }, [filters, fundamentals, sort, equitySymbols])

  // Funds only honour the text and exchange filters; the remaining screener inputs are
  // company measures that have no equivalent in a fund's published data.
  const screenedFunds = useMemo(() => {
    const query = filters.query.trim().toLowerCase()
    const list = stockFundSymbols.filter((symbol) => {
      const item = fundamentals[symbol]
      if (!item) return true
      if (query && !`${item.symbol} ${item.name}`.toLowerCase().includes(query)) return false
      if (filters.exchange !== 'all' && item.exchange !== filters.exchange) return false
      return true
    })
    list.sort((leftSymbol, rightSymbol) => {
      const left = fundamentals[leftSymbol]
      const right = fundamentals[rightSymbol]
      if (!left || !right) return 0
      const leftValue = fundSortValue(left, fundSort.key)
      const rightValue = fundSortValue(right, fundSort.key)
      if (leftValue == null && rightValue == null) return 0
      if (leftValue == null) return 1
      if (rightValue == null) return -1
      const comparison = typeof leftValue === 'string'
        ? leftValue.localeCompare(String(rightValue))
        : leftValue - Number(rightValue)
      return fundSort.direction === 'asc' ? comparison : -comparison
    })
    return list
  }, [filters, fundamentals, stockFundSymbols, fundSort, fundConstituents])

  const screenedBondFunds = useMemo(() => {
    const query = filters.query.trim().toLowerCase()
    const list = bondFundSymbols.filter((symbol) => {
      const item = fundamentals[symbol]
      if (!item) return true
      if (query && !`${item.symbol} ${item.name}`.toLowerCase().includes(query)) return false
      if (filters.exchange !== 'all' && item.exchange !== filters.exchange) return false
      return true
    })
    list.sort((leftSymbol, rightSymbol) => {
      const left = fundamentals[leftSymbol]
      const right = fundamentals[rightSymbol]
      if (!left || !right) return 0
      const leftValue = bondSortValue(left, bondSort.key)
      const rightValue = bondSortValue(right, bondSort.key)
      if (leftValue == null && rightValue == null) return 0
      if (leftValue == null) return 1
      if (rightValue == null) return -1
      const comparison = typeof leftValue === 'string'
        ? leftValue.localeCompare(String(rightValue))
        : leftValue - Number(rightValue)
      return bondSort.direction === 'asc' ? comparison : -comparison
    })
    return list
  }, [filters, fundamentals, bondFundSymbols, bondSort])

  function fundSortValue(item: Fundamentals, key: 'symbol' | FundColumnId): number | string | null {
    if (key === 'symbol') return item.symbol
    if (key === 'region') return item.region ?? null
    if (key === 'fundCategory') return item.fundCategory ?? null
    if (key === 'assetMix') return item.stockPosition ?? null
    if (key === 'earningsGrowth' || key === 'ewEpsGrowth' || key === 'ewRevenueGrowth' || key === 'incrementalRoic') {
      return fundConstituents[item.symbol]?.[key] ?? item[key] ?? null
    }
    return (item[key] as number | null | undefined) ?? null
  }

  function bondSortValue(item: Fundamentals, key: 'symbol' | BondColumnId): number | string | null {
    if (key === 'symbol') return item.symbol
    if (key === 'region') return item.region ?? null
    if (key === 'fundCategory') return item.fundCategory ?? null
    if (key === 'creditQuality') return item.creditQuality ?? null
    if (key === 'assetMix') return item.bondPosition ?? null
    return (item[key] as number | null | undefined) ?? null
  }

  const colorFor = useCallback(
    (symbol: string) => colors[Math.max(0, chartSymbols.indexOf(symbol)) % colors.length],
    [chartSymbols],
  )
  const detailHistoryKey = openSymbol ? `${openSymbol}:${detailRange}` : ''

  // The Compare table's fund ratio columns (EPS growth, incremental ROIC, etc.) require
  // fanning out to each fund's holdings on the server, which is too expensive to run for
  // every visible fund at once — a burst of concurrent lookups previously tripped SEC
  // EDGAR's rate limit and broke stock loading too. So this fetches one fund at a time,
  // with a pause between each, only for funds currently shown in the table, and stops
  // once every visible fund has been requested.
  useEffect(() => {
    if (screenedFunds.length === 0) return
    let active = true
    const pending = screenedFunds.filter((symbol) => !fundConstituents[symbol] && !fundConstituentErrors[symbol])
    if (pending.length === 0) return
    ;(async () => {
      for (const symbol of pending) {
        if (!active) return
        try {
          const result = await api.fundConstituents(symbol)
          if (active) setFundConstituents((current) => ({ ...current, [symbol]: result }))
        } catch (reason) {
          if (active) {
            setFundConstituentErrors((current) => ({
              ...current,
              [symbol]: reason instanceof Error ? reason.message : 'Could not load fund constituents',
            }))
          }
        }
        if (active) await new Promise((resolve) => setTimeout(resolve, 1500))
      }
    })()
    return () => { active = false }
  }, [screenedFunds, fundConstituents, fundConstituentErrors])

  // Detail is fetched only when a symbol is actually opened, then kept. The underlying SEC
  // company-facts document is already cached server-side from the metric pass, so opening a
  // symbol that is on screen costs no new upstream request.
  useEffect(() => {
    if (!openSymbol || details[openSymbol] || detailErrors[openSymbol]) return
    let active = true
    api.detail(openSymbol)
      .then((result) => { if (active) setDetails((current) => ({ ...current, [openSymbol]: result })) })
      .catch((reason) => {
        if (active) {
          setDetailErrors((current) => ({
            ...current,
            [openSymbol]: reason instanceof Error ? reason.message : 'Could not load details',
          }))
        }
      })
    return () => { active = false }
  }, [openSymbol, details, detailErrors])

  // Constituent holdings and their weighted fundamentals are expensive (they fan out one
  // fetch per top holding), so they're only requested once we know the opened symbol is a
  // fund and the user has actually opened its detail panel — never during the aggregate load.
  useEffect(() => {
    if (!openSymbol || !details[openSymbol]?.isFund) return
    if (fundConstituents[openSymbol] || fundConstituentErrors[openSymbol]) return
    let active = true
    api.fundConstituents(openSymbol)
      .then((result) => { if (active) setFundConstituents((current) => ({ ...current, [openSymbol]: result })) })
      .catch((reason) => {
        if (active) {
          setFundConstituentErrors((current) => ({
            ...current,
            [openSymbol]: reason instanceof Error ? reason.message : 'Could not load fund constituents',
          }))
        }
      })
    return () => { active = false }
  }, [openSymbol, details, fundConstituents, fundConstituentErrors])

  // The table view never loads price series, so the detail panel pulls the history it needs
  // on demand rather than showing an empty chart.
  useEffect(() => {
    if (!openSymbol || !detailHistoryKey || (detailHistories[detailHistoryKey] && detailHistoryEvents[detailHistoryKey])) return
    let active = true
    api.history(openSymbol, detailRange)
      .then((result) => {
        if (active) {
          setDetailHistories((current) => ({ ...current, [detailHistoryKey]: result.points }))
          setDetailHistoryEvents((current) => ({ ...current, [detailHistoryKey]: result.events ?? [] }))
        }
      })
      .catch(() => undefined)
    return () => { active = false }
  }, [detailHistories, detailHistoryEvents, detailHistoryKey, detailRange, openSymbol])

  // Retry a previously failed symbol rather than showing the stale error forever.
  function openSymbolDetail(symbol: string) {
    setDetailRange(range)
    setDetailErrors((current) => {
      if (!current[symbol]) return current
      const next = { ...current }
      delete next[symbol]
      return next
    })
    setFundConstituentErrors((current) => {
      if (!current[symbol]) return current
      const next = { ...current }
      delete next[symbol]
      return next
    })
    setSymbolHistory([])
    setOpenSymbol(symbol)
  }

  // Drilling into a fund's constituent stock keeps the fund on a back-stack so the user can
  // return to it, rather than replacing it outright the way opening a fresh symbol does.
  function openNestedSymbolDetail(symbol: string) {
    if (openSymbol && openSymbol !== symbol) {
      setSymbolHistory((current) => [...current, openSymbol])
    }
    setDetailErrors((current) => {
      if (!current[symbol]) return current
      const next = { ...current }
      delete next[symbol]
      return next
    })
    setFundConstituentErrors((current) => {
      if (!current[symbol]) return current
      const next = { ...current }
      delete next[symbol]
      return next
    })
    setOpenSymbol(symbol)
  }

  function goBackSymbol() {
    setSymbolHistory((current) => {
      if (current.length === 0) return current
      const next = [...current]
      const previous = next.pop() as string
      setOpenSymbol(previous)
      return next
    })
  }

  useEffect(() => {
    if (!openSymbol) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpenSymbol(null); setSymbolHistory([]) } }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [openSymbol])

  function addSymbol(symbol: string) {
    const normalized = symbol.toUpperCase()
    updateActiveCollection((collection) => {
      const existing = collection.items.find((item) => item.symbol === normalized)
      if (existing) {
        return {
          ...collection,
          items: collection.items.map((item) => item.symbol === normalized ? { ...item, enabled: true } : item),
        }
      }
      return { ...collection, items: [...collection.items, { symbol: normalized, enabled: true }] }
    })
  }

  function updateActiveCollection(
    update: (collection: Portfolio | AnalysisCollection) => Portfolio | AnalysisCollection,
  ) {
    setWorkspace((current) => ({
      ...current,
      portfolios: current.activeKind === 'portfolio'
        ? current.portfolios.map((item) => item.id === current.activeId ? update(item) as Portfolio : item)
        : current.portfolios,
      analyses: current.activeKind === 'analysis'
        ? current.analyses.map((item) => item.id === current.activeId ? update(item) as AnalysisCollection : item)
        : current.analyses,
    }))
  }

  function removeSymbol(symbol: string) {
    updateActiveCollection((collection) => ({
      ...collection,
      items: collection.items.filter((item) => item.symbol !== symbol),
    }))
  }

  function toggleSymbolEnabled(symbol: string) {
    updateActiveCollection((collection) => ({
      ...collection,
      items: collection.items.map((item) =>
        item.symbol === symbol ? { ...item, enabled: !item.enabled } : item,
      ),
    }))
  }

  function compareVisibilityControl(symbol: string) {
    const enabled = enabledSymbolSet.has(symbol)
    return (
      <button
        className="compare-visibility"
        title={enabled ? `Hide ${symbol}` : `Show ${symbol}`}
        aria-label={enabled ? `Hide ${symbol}` : `Show ${symbol}`}
        onClick={() => toggleSymbolEnabled(symbol)}
      >
        {enabled ? <Eye size={14} /> : <EyeOff size={14} />}
      </button>
    )
  }

  function disableSymbol(symbol: string) {
    updateActiveCollection((collection) => ({
      ...collection,
      items: collection.items.map((item) =>
        item.symbol === symbol ? { ...item, enabled: false } : item,
      ),
    }))
  }

  function enableSymbol(symbol: string) {
    updateActiveCollection((collection) => ({
      ...collection,
      items: collection.items.map((item) =>
        item.symbol === symbol ? { ...item, enabled: true } : item,
      ),
    }))
  }

  function setAllSymbolsEnabled(enabled: boolean) {
    updateActiveCollection((collection) => ({
      ...collection,
      items: collection.items.map((item) => ({ ...item, enabled })),
    }))
  }

  function createCollection(kind: CollectionKind) {
    const existingCount = kind === 'portfolio' ? workspace.portfolios.length : workspace.analyses.length
    const suggested = kind === 'portfolio' ? `Portfolio ${existingCount + 1}` : `Analysis ${existingCount + 1}`
    const name = window.prompt(`Name this ${kind}:`, suggested)?.trim()
    if (!name) return
    const id = newId()
    setWorkspace((current) => ({
      ...current,
      portfolios: kind === 'portfolio' ? [...current.portfolios, { id, name, items: [] }] : current.portfolios,
      analyses: kind === 'analysis' ? [...current.analyses, { id, name, items: [] }] : current.analyses,
      activeKind: kind,
      activeId: id,
    }))
  }

  async function createRandomAnalysis() {
    const count = Number(randomCount)
    if (!Number.isInteger(count) || count < 1) {
      setError('Random sample size must be a whole number of at least 1.')
      return
    }
    if (randomRegions.length === 0) {
      setError('Select at least one geographic region for the random sample.')
      return
    }
    setRandomLoading(true)
    setError('')
    try {
      const minMarketCap = parseOptionalNumber(randomMinMarketCap)
      const maxMarketCap = parseOptionalNumber(randomMaxMarketCap)
      if (
        (minMarketCap != null && minMarketCap < 0) ||
        (maxMarketCap != null && maxMarketCap < 0) ||
        (minMarketCap != null && maxMarketCap != null && minMarketCap > maxMarketCap)
      ) {
        setError('Market-cap limits must be positive and the minimum cannot exceed the maximum.')
        return
      }
      const result = await api.randomSymbols({
        count,
        pool: randomPool,
        regions: randomRegions,
        minMarketCap: randomMinMarketCap,
        maxMarketCap: randomMaxMarketCap,
      })
      const id = newId()
      const timestamp = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date())
      const analysis: AnalysisCollection = {
        id,
        name: `${randomPool === 'volume' ? 'Active' : 'Random'} ${count} · ${randomRegions.length === 1 ? randomRegions[0] : `${randomRegions.length} regions`} · ${timestamp}`,
        items: result.symbols.map((item) => ({ symbol: item.symbol, enabled: true })),
      }
      setWorkspace((current) => ({
        ...current,
        analyses: [...current.analyses, analysis],
        activeKind: 'analysis',
        activeId: id,
      }))
      setView('compare')
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not generate the random sample')
    } finally {
      setRandomLoading(false)
    }
  }

  function renameCollection() {
    if (!activeCollection) return
    const name = window.prompt('Collection name:', activeCollection.name)?.trim()
    if (!name || name === activeCollection.name) return
    updateActiveCollection((collection) => ({ ...collection, name }))
  }

  function deleteCollection() {
    if (!activeCollection || !window.confirm(`Delete "${activeCollection.name}"?`)) return
    setWorkspace((current) => {
      const portfolios = current.activeKind === 'portfolio'
        ? current.portfolios.filter((item) => item.id !== current.activeId)
        : current.portfolios
      const analyses = current.activeKind === 'analysis'
        ? current.analyses.filter((item) => item.id !== current.activeId)
        : current.analyses
      const next = portfolios[0] ?? analyses[0]
      if (!next) {
        const replacement: Portfolio = { id: newId(), name: 'My portfolio', items: [] }
        return { portfolios: [replacement], analyses: [], activeKind: 'portfolio', activeId: replacement.id }
      }
      return {
        portfolios,
        analyses,
        activeKind: portfolios.includes(next as Portfolio) ? 'portfolio' : 'analysis',
        activeId: next.id,
      }
    })
  }

  function toggleColumn(column: ColumnId) {
    setVisibleColumns((current) =>
      current.includes(column)
        ? current.filter((item) => item !== column)
        : comparisonColumns.map((item) => item.id).filter((item) => current.includes(item) || item === column),
    )
  }

  function toggleFundColumn(column: FundColumnId) {
    setVisibleFundColumns((current) =>
      current.includes(column)
        ? current.filter((item) => item !== column)
        : fundColumns.map((item) => item.id).filter((item) => current.includes(item) || item === column),
    )
  }

  function toggleBondColumn(column: BondColumnId) {
    setVisibleBondColumns((current) =>
      current.includes(column)
        ? current.filter((item) => item !== column)
        : bondColumns.map((item) => item.id).filter((item) => current.includes(item) || item === column),
    )
  }

  const companyNames = useMemo(
    () => Object.fromEntries(Object.entries(fundamentals).map(([symbol, item]) => [symbol, item.name])),
    [fundamentals],
  )

  function pinLine(symbol: string) {    // Always sets (never toggles) so a double-click — which fires two click events —
    // lands on the same series instead of pinning and immediately unpinning.
    if (symbol) setPinnedSymbol(symbol)
  }

  function updateFilter(key: keyof ScreenerFilters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }))
  }

  function changeSort(key: SortKey) {
    setSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }))
  }

  function sortIcon(key: SortKey) {
    if (sort.key !== key) return <ArrowUpDown size={12} />
    return sort.direction === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />
  }

  function changeFundSort(key: 'symbol' | FundColumnId) {
    setFundSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }))
  }

  function fundSortIcon(key: 'symbol' | FundColumnId) {
    if (fundSort.key !== key) return <ArrowUpDown size={12} />
    return fundSort.direction === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />
  }

  function changeBondSort(key: 'symbol' | BondColumnId) {
    setBondSort((current) => ({
      key,
      direction: current.key === key && current.direction === 'desc' ? 'asc' : 'desc',
    }))
  }

  function bondSortIcon(key: 'symbol' | BondColumnId) {
    if (bondSort.key !== key) return <ArrowUpDown size={12} />
    return bondSort.direction === 'desc' ? <ArrowDown size={12} /> : <ArrowUp size={12} />
  }

  function renderFundCell(column: FundColumnId, item: Fundamentals) {
    const label = fundColumns.find((entry) => entry.id === column)?.label ?? column
    const note = item.metricNotes?.[column === 'assetMix' ? 'pe' : column]
    const constituentColumns: FundColumnId[] = ['earningsGrowth', 'ewEpsGrowth', 'ewRevenueGrowth', 'incrementalRoic']
    const constituentPending =
      constituentColumns.includes(column) && !fundConstituents[item.symbol] && !fundConstituentErrors[item.symbol]

    function unavailable() {
      if (constituentPending) {
        return <span className="metric-loading" title="Fetching from fund holdings…">…</span>
      }
      return <MissingMetric item={item} metric={column} label={label} note={note} touchOnlyPin />
    }

    function cell(value: number | null | undefined, formatted: string, className?: string, tooltipContent?: ReactNode) {
      if (value == null) return <td key={column}>{unavailable()}</td>
      if (tooltipContent) {
        return (
          <td key={column} className={className}>
            <HoverTip className="metric-tip-inline" ariaLabel={`${label} info`} content={tooltipContent}>
              {formatted}
            </HoverTip>
          </td>
        )
      }
      return (
        <td key={column} className={className}>
          {formatted}
        </td>
      )
    }

    const growthClass = (value: number | null | undefined) => ((value ?? 0) >= 0 ? 'positive' : 'negative')

    switch (column) {
      case 'region':
        return <td key={column}>{item.region ?? unavailable()}</td>
      case 'price': {
        const isForeign = item.currency && item.currency !== 'USD'
        const tooltip = isForeign ? (
          <>
            <p><strong>Price in USD</strong></p>
            <p>Converted from {item.currency} (1 {item.currency} = ${item.currencyRateToUsd ? (item.currencyRateToUsd >= 1 ? item.currencyRateToUsd.toFixed(4) : item.currencyRateToUsd.toPrecision(4)) : '1.00'} USD).</p>
            <p>Original price: <strong>{formatCurrency(item.rawPrice ?? item.price, item.currency)}</strong></p>
          </>
        ) : null
        return cell(item.price, `$${formatNumber(item.price)}`, undefined, tooltip)
      }
      case 'fundCategory':
        return (
          <td key={column}>
            {item.fundCategory ?? unavailable()}
            {item.fundFamily && <small className="report-detail">{item.fundFamily}</small>}
          </td>
        )
      case 'netAssets': {
        const isForeign = item.currency && item.currency !== 'USD'
        const tooltip = isForeign ? (
          <>
            <p><strong>Net assets in USD</strong></p>
            <p>Converted to USD from {item.currency} (1 {item.currency} = ${item.currencyRateToUsd ? (item.currencyRateToUsd >= 1 ? item.currencyRateToUsd.toFixed(4) : item.currencyRateToUsd.toPrecision(4)) : '1.00'} USD).</p>
            <p>Original net assets: <strong>{formatCompact(item.rawNetAssets)} {item.currency}</strong></p>
          </>
        ) : null
        return cell(item.netAssets, formatCompact(item.netAssets ?? null), undefined, tooltip)
      }
      case 'expenseRatio':
        return cell(item.expenseRatio, `${formatNumber(item.expenseRatio ?? null)}%`)
      case 'pe':
        return cell(item.pe, `${formatNumber(item.pe, 1)}×`)
      case 'priceToBook':
        return cell(item.priceToBook, `${formatNumber(item.priceToBook, 1)}×`)
      case 'dividendYield':
        return cell(item.dividendYield, formatGrowth(item.dividendYield), growthClass(item.dividendYield))
      case 'returnOnEquity':
        return cell(item.returnOnEquity, formatGrowth(item.returnOnEquity), growthClass(item.returnOnEquity))
      case 'sustainableGrowth':
        return cell(item.sustainableGrowth, formatGrowth(item.sustainableGrowth), growthClass(item.sustainableGrowth))
      case 'earningsGrowth': {
        const value = fundConstituents[item.symbol]?.earningsGrowth ?? item.earningsGrowth
        return cell(value, formatGrowth(value), growthClass(value))
      }
      case 'ewEpsGrowth': {
        const value = fundConstituents[item.symbol]?.ewEpsGrowth ?? item.ewEpsGrowth
        return cell(value, formatGrowth(value), growthClass(value))
      }
      case 'ewRevenueGrowth': {
        const value = fundConstituents[item.symbol]?.ewRevenueGrowth ?? item.ewRevenueGrowth
        return cell(value, formatGrowth(value), growthClass(value))
      }
      case 'incrementalRoic': {
        const value = fundConstituents[item.symbol]?.incrementalRoic ?? item.incrementalRoic
        return cell(value, formatGrowth(value), growthClass(value))
      }
      case 'impliedReturn':
        return cell(item.impliedReturn, formatGrowth(item.impliedReturn), growthClass(item.impliedReturn))
      case 'payoutRatio':
        return cell(item.payoutRatio ?? null, formatGrowth(item.payoutRatio ?? null), growthClass(item.payoutRatio))
      case 'assetMix':
        return (
          <td key={column}>
            {item.stockPosition == null && item.bondPosition == null ? unavailable() : (
              <span>
                {formatNumber(item.stockPosition ?? 0, 0)}% stocks · {formatNumber(item.bondPosition ?? 0, 0)}% bonds
              </span>
            )}
          </td>
        )
    }
  }

  function renderBondCell(column: BondColumnId, item: Fundamentals) {
    const label = bondColumns.find((entry) => entry.id === column)?.label ?? column
    const note = item.metricNotes?.[column === 'assetMix' || column === 'creditQuality' ? 'pe' : column]

    function unavailable() {
      return <MissingMetric item={item} metric={column} label={label} note={note} touchOnlyPin />
    }

    function cell(value: number | null | undefined, formatted: string, className?: string, tooltipContent?: ReactNode) {
      if (value == null) return <td key={column}>{unavailable()}</td>
      if (tooltipContent) {
        return (
          <td key={column} className={className}>
            <HoverTip className="metric-tip-inline" ariaLabel={`${label} info`} content={tooltipContent}>
              {formatted}
            </HoverTip>
          </td>
        )
      }
      return (
        <td key={column} className={className}>
          {formatted}
        </td>
      )
    }

    const growthClass = (value: number | null | undefined) => ((value ?? 0) >= 0 ? 'positive' : 'negative')

    switch (column) {
      case 'region':
        return <td key={column}>{item.region ?? unavailable()}</td>
      case 'price': {
        const isForeign = item.currency && item.currency !== 'USD'
        const tooltip = isForeign ? (
          <>
            <p><strong>Price in USD</strong></p>
            <p>Converted from {item.currency} (1 {item.currency} = ${item.currencyRateToUsd ? (item.currencyRateToUsd >= 1 ? item.currencyRateToUsd.toFixed(4) : item.currencyRateToUsd.toPrecision(4)) : '1.00'} USD).</p>
            <p>Original price: <strong>{formatCurrency(item.rawPrice ?? item.price, item.currency)}</strong></p>
          </>
        ) : null
        return cell(item.price, `$${formatNumber(item.price)}`, undefined, tooltip)
      }
      case 'fundCategory':
        return (
          <td key={column}>
            {item.fundCategory ?? unavailable()}
            {item.fundFamily && <small className="report-detail">{item.fundFamily}</small>}
          </td>
        )
      case 'netAssets': {
        const isForeign = item.currency && item.currency !== 'USD'
        const tooltip = isForeign ? (
          <>
            <p><strong>Net assets in USD</strong></p>
            <p>Converted to USD from {item.currency} (1 {item.currency} = ${item.currencyRateToUsd ? (item.currencyRateToUsd >= 1 ? item.currencyRateToUsd.toFixed(4) : item.currencyRateToUsd.toPrecision(4)) : '1.00'} USD).</p>
            <p>Original net assets: <strong>{formatCompact(item.rawNetAssets)} {item.currency}</strong></p>
          </>
        ) : null
        return cell(item.netAssets, formatCompact(item.netAssets ?? null), undefined, tooltip)
      }
      case 'expenseRatio':
        return cell(item.expenseRatio, `${formatNumber(item.expenseRatio ?? null)}%`)
      case 'dividendYield':
        return cell(item.dividendYield, formatGrowth(item.dividendYield), growthClass(item.dividendYield))
      case 'creditQuality':
        return <td key={column}>{item.creditQuality ?? unavailable()}</td>
      case 'assetMix':
        return (
          <td key={column}>
            {item.bondPosition == null && item.cashPosition == null ? unavailable() : (
              <span>
                {formatNumber(item.bondPosition ?? 0, 0)}% bonds · {formatNumber(item.cashPosition ?? 0, 0)}% cash
                {item.otherPosition != null && item.otherPosition > 0 ? ` · ${formatNumber(item.otherPosition, 0)}% other` : ''}
              </span>
            )}
          </td>
        )
    }
  }


  return (
    <div className="app-shell">
      <header>
        <nav>
          <button className={view === 'chart' ? 'active' : ''} onClick={() => setView('chart')}>
            <BarChart3 size={17} /> Chart
          </button>
          <button className={view === 'compare' ? 'active' : ''} onClick={() => setView('compare')}>
            <GitCompareArrows size={17} /> Compare
          </button>
        </nav>
        <SymbolSearch onSelect={openSymbolDetail} mode="open" />
        <button
          className="icon-action theme-toggle"
          onClick={() => setTheme((current) => (current === 'dark' ? 'light' : 'dark'))}
          aria-label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
          title={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
        >
          {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
        </button>
      </header>

      <main>
        <section className="hero-row">
          <div>
            <p className="eyebrow">US EQUITY RESEARCH</p>
            <h1>{view === 'chart' ? 'Performance over time' : 'Compare fundamentals'}</h1>
            <p className="subtitle">
              {view === 'chart'
                ? 'Explore price performance and filing-derived valuation across NYSE and Nasdaq stocks.'
                : 'A side-by-side view of valuation, earnings, and revenue momentum.'}
            </p>
          </div>
          <div className="status-pill"><span /> MARKET DATA</div>
        </section>

        <div className="collection-bar">
          <label>
            <span>{workspace.activeKind === 'portfolio' ? 'Portfolio' : 'Analysis collection'}</span>
            <select
              value={`${workspace.activeKind}:${workspace.activeId}`}
              onChange={(event) => {
                const [activeKind, activeId] = event.target.value.split(':') as [CollectionKind, string]
                setWorkspace((current) => ({ ...current, activeKind, activeId }))
              }}
            >
              {workspace.portfolios.length > 0 && (
                <optgroup label="Portfolios">
                  {workspace.portfolios.map((item) => <option key={item.id} value={`portfolio:${item.id}`}>{item.name}</option>)}
                </optgroup>
              )}
              {workspace.analyses.length > 0 && (
                <optgroup label="Analysis collections">
                  {workspace.analyses.map((item) => <option key={item.id} value={`analysis:${item.id}`}>{item.name}</option>)}
                </optgroup>
              )}
            </select>
          </label>
          <div className="collection-actions">
            <details className="random-picker">
              <summary><WandSparkles size={15} /> Random sample</summary>
              <div className="random-menu">
                <strong>Create filtered analysis</strong>
                <label>
                  <span>Number of symbols</span>
                  <input type="number" min="1" step="1" value={randomCount} onChange={(event) => setRandomCount(event.target.value)} />
                </label>
                <label>
                  <span>Sampling basis</span>
                  <select value={randomPool} onChange={(event) => setRandomPool(event.target.value as 'all' | 'volume')}>
                    <option value="all">Broad listed-stock pool</option>
                    <option value="volume">Highest-volume stocks</option>
                  </select>
                </label>
                <fieldset className="random-regions">
                  <div className="random-region-heading">
                    <legend>Candidate regions</legend>
                    <span>
                      <button type="button" onClick={() => setRandomRegions([...randomSampleRegionOptions])}>All regions</button>
                      <button type="button" onClick={() => setRandomRegions([])}>Unselect all</button>
                    </span>
                  </div>
                  <div className="random-region-options">
                    {randomSampleRegionOptions.map((region) => (
                      <label key={region}>
                        <input
                          type="checkbox"
                          checked={randomRegions.includes(region)}
                          onChange={(event) => setRandomRegions((current) =>
                            event.target.checked
                              ? [...current, region]
                              : current.filter((value) => value !== region),
                          )}
                        />
                        <span>{region}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
                <div className="random-grid">
                  <label><span>Min market cap ($B)</span><input type="number" min="0" value={randomMinMarketCap} onChange={(event) => setRandomMinMarketCap(event.target.value)} /></label>
                  <label><span>Max market cap ($B)</span><input type="number" min="0" value={randomMaxMarketCap} onChange={(event) => setRandomMaxMarketCap(event.target.value)} /></label>
                </div>
                <button className="primary-action" disabled={randomLoading} onClick={createRandomAnalysis}>
                  {randomLoading ? <span className="search-loader" /> : <WandSparkles size={15} />}
                  Create exact sample
                </button>
                <small>Market-cap filtering may take longer because candidate fundamentals are checked before selection.</small>
              </div>
            </details>
            <button onClick={() => createCollection('portfolio')}><FolderPlus size={15} /> New portfolio</button>
            <button onClick={() => createCollection('analysis')}><FlaskConical size={15} /> New analysis</button>
            <button className="icon-action" title="Rename collection" aria-label="Rename collection" onClick={renameCollection}><Pencil size={15} /></button>
            <button className="icon-action danger" title="Delete collection" aria-label="Delete collection" onClick={deleteCollection}><Trash2 size={15} /></button>
          </div>
        </div>

        <div className="ticker-section">
          <div className="ticker-header">
            <button
              className="ticker-toggle"
              onClick={() => setSymbolsCollapsed((current) => !current)}
              aria-expanded={!symbolsCollapsed}
            >
              {symbolsCollapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
              Symbols <b>{collectionItems.filter((item) => item.enabled).length}/{collectionItems.length}</b>
              {symbolsCollapsed && (
                <span className="ticker-summary">{alphabetizedCollectionItems.map((item) => item.symbol).join(', ') || 'None'}</span>
              )}
            </button>
            {collectionItems.length > 0 && (
              <button
                className="ticker-bulk"
                onClick={() => setAllSymbolsEnabled(!collectionItems.every((item) => item.enabled))}
              >
                {collectionItems.every((item) => item.enabled) ? <EyeOff size={14} /> : <Eye size={14} />}
                {collectionItems.every((item) => item.enabled) ? 'Hide all' : 'Show all'}
              </button>
            )}
            <SymbolSearch onSelect={addSymbol} mode="add" collectionKind={workspace.activeKind} />
          </div>
          {!symbolsCollapsed && (
            <div className="ticker-row">
              {alphabetizedCollectionItems.map(({ symbol, enabled }) => (
                <span className={`ticker-pill ${enabled ? '' : 'disabled'}`} key={symbol} style={{ '--ticker-color': colorFor(symbol) } as React.CSSProperties}>
                  <i /> {symbol}
                  <button
                    title={enabled ? `Hide ${symbol}` : `Show ${symbol}`}
                    aria-label={enabled ? `Hide ${symbol}` : `Show ${symbol}`}
                    onClick={() => toggleSymbolEnabled(symbol)}
                  >
                    {enabled ? <Eye size={14} /> : <EyeOff size={14} />}
                  </button>
                  <button aria-label={`Remove ${symbol}`} onClick={() => removeSymbol(symbol)}>
                    <X size={14} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>

        {error && <div className="error-banner">{error}</div>}
        {loading && loadProgress.total > 0 && (
          <div className="load-progress">
            <span style={{ width: `${(loadProgress.completed / loadProgress.total) * 100}%` }} />
            <small>Calculated {loadProgress.completed} of {loadProgress.total} symbols</small>
          </div>
        )}

        {view === 'chart' ? (
          <section className="panel chart-panel">
            <div className="panel-controls">
              <div className="segmented compact">
                {aggregateRangeOptions.map((value) => (
                  <button key={value} className={range === value ? 'active' : ''} onClick={() => setRange(value)}>{value.toUpperCase()}</button>
                ))}
              </div>
            </div>

            {chartSymbols.length === 0 ? (
              <div className="chart-area"><div className="empty-state">Add at least one ticker to begin.</div></div>
            ) : (
              <>
                {chartEquitySymbols.length > 0 && (
                  <SeriesChart
                    title={chartFundSymbols.length > 0 ? 'Companies' : undefined}
                    controls={
                      <div className="segmented compact chart-metrics">
                        {([
                          ['price', 'Price'],
                          ['pe', 'P / E'],
                          ['relative', 'Relative change'],
                          ['priceToBook', 'P / Book'],
                          ['priceToNetTangibleAssets', 'Price / net tangible assets'],
                          ['dividendYield', 'Dividend yield'],
                          ['impliedReturn', 'Implied return'],
                          ['earningsGrowth', 'EPS growth'],
                          ['ewEpsGrowth', 'EW EPS growth'],
                          ['ewRevenueGrowth', 'EW revenue growth'],
                          ['sustainableGrowth', 'Sustainable growth'],
                          ['incrementalRoic', 'Incremental ROIC'],
                        ] as const).map(([value, label]) => (
                          <ChartMetricControl key={value} value={value} label={label} active={metric === value} onSelect={() => setMetric(value)} />
                        ))}
                      </div>
                    }
                    loading={loading && chartData.length === 0}
                    symbols={chartEquitySymbols}
                    enabledSymbols={symbols}
                    data={chartData}
                    metric={metric}
                    pinnedSymbol={pinnedSymbol}
                    onPin={pinLine}
                    onDisable={disableSymbol}
                    onEnable={enableSymbol}
                    onOpenSymbol={openSymbolDetail}
                    fundamentals={fundamentals}
                    histories={histories}
                    names={companyNames}
                    colorFor={colorFor}
                  />
                )}
                {chartFundSymbols.length > 0 && (
                  <SeriesChart
                    title="Funds and ETFs"
                    controls={
                      <div className="segmented compact">
                        {([
                          ['price', 'Price'],
                          ['relative', 'Relative change'],
                          ['yield', 'Distribution yield'],
                        ] as const).map(([value, label]) => (
                          <ChartMetricControl key={value} value={value} label={label} active={fundMetric === value} onSelect={() => setFundMetric(value)} fund />
                        ))}
                      </div>
                    }
                    loading={loading && fundChartData.length === 0}
                    symbols={chartFundSymbols}
                    enabledSymbols={symbols}
                    data={fundChartData}
                    metric={fundMetric}
                    pinnedSymbol={pinnedSymbol}
                    onPin={pinLine}
                    onDisable={disableSymbol}
                    onEnable={enableSymbol}
                    onOpenSymbol={openSymbolDetail}
                    fundamentals={fundamentals}
                    histories={histories}
                    names={companyNames}
                    colorFor={colorFor}
                  />
                )}
              </>
            )}
            <p className="source-line">
              Click a trace or report dot to focus it, then Shift-click anywhere in the plot to deactivate it. Inactive series are gray and excluded from scaling while any series are active; double-click or use Symbols to re-enable. Report dots are connected by translucent interpolated lines, not reported values. Prices: Yahoo Finance · Company fundamentals: SEC EDGAR · Fund data: Yahoo Finance (Morningstar). Historical company metrics use up to 16 available quarters and reported filing dates; revised filings and missing data can affect results. Fund distribution yield holds the current trailing payout constant.
            </p>
          </section>
        ) : (
          <section className="panel comparison-panel">
            <div className="comparison-toolbar">
              <span><strong>{screenedSymbols.length + screenedFunds.length + screenedBondFunds.length}</strong> of {chartSymbols.length} symbols shown · {symbols.length} active</span>
              <div className="comparison-actions">
                <details className="filter-picker">
                  <summary><Filter size={15} /> Screener</summary>
                  <div className="filter-menu">
                    <div className="filter-heading">
                      <strong>Screen portfolio</strong>
                      <button type="button" onClick={() => setFilters(defaultFilters)}>Clear all</button>
                    </div>
                    <label className="wide-field">
                      <span>Ticker or company</span>
                      <input value={filters.query} onChange={(event) => updateFilter('query', event.target.value)} placeholder="e.g. Apple or AAPL" />
                    </label>
                    <label className="wide-field">
                      <span>Exchange</span>
                      <select value={filters.exchange} onChange={(event) => updateFilter('exchange', event.target.value)}>
                        <option value="all">All exchanges</option>
                        {[...new Set(Object.values(fundamentals).map((item) => item.exchange))].sort().map((exchange) => (
                          <option key={exchange} value={exchange}>{exchange}</option>
                        ))}
                      </select>
                    </label>
                    <div className="filter-grid">
                      <label><span>Min market cap ($B)</span><input type="number" value={filters.minMarketCap} onChange={(event) => updateFilter('minMarketCap', event.target.value)} /></label>
                      <label><span>Max market cap ($B)</span><input type="number" value={filters.maxMarketCap} onChange={(event) => updateFilter('maxMarketCap', event.target.value)} /></label>
                      <label><span>Min P / E</span><input type="number" value={filters.minPe} onChange={(event) => updateFilter('minPe', event.target.value)} /></label>
                      <label><span>Max P / E</span><input type="number" value={filters.maxPe} onChange={(event) => updateFilter('maxPe', event.target.value)} /></label>
                      <label><span>Min P / Book</span><input type="number" value={filters.minPriceToBook} onChange={(event) => updateFilter('minPriceToBook', event.target.value)} /></label>
                      <label><span>Max P / Book</span><input type="number" value={filters.maxPriceToBook} onChange={(event) => updateFilter('maxPriceToBook', event.target.value)} /></label>
                      <label><span>Min EPS growth (%)</span><input type="number" value={filters.minEarningsGrowth} onChange={(event) => updateFilter('minEarningsGrowth', event.target.value)} /></label>
                      <label><span>Min EW revenue growth (%)</span><input type="number" value={filters.minRevenueGrowth} onChange={(event) => updateFilter('minRevenueGrowth', event.target.value)} /></label>
                    </div>
                  </div>
                </details>
              </div>
            </div>

            {screenedSymbols.length > 0 && (
              <>
                <div className="table-group-header">
                  <h3 className="table-group-title">Companies</h3>
                  <details className="column-picker">
                    <summary><Settings2 size={15} /> Columns <b>{visibleColumns.length}</b></summary>
                    <div className="column-menu">
                      <div className="column-menu-heading">
                        <strong>Visible metrics</strong>
                        <button
                          type="button"
                          onClick={() =>
                            setVisibleColumns(visibleColumns.length === comparisonColumns.length ? [] : defaultColumns)
                          }
                        >
                          {visibleColumns.length === comparisonColumns.length ? 'Hide all' : 'Show all'}
                        </button>
                        <button type="button" onClick={() => setVisibleColumns(defaultColumns)}>Reset</button>
                      </div>
                      {comparisonColumns.map((column) => (
                        <label key={column.id}>
                          <input
                            type="checkbox"
                            checked={visibleColumns.includes(column.id)}
                            onChange={() => toggleColumn(column.id)}
                          />
                          <span>{column.label}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                <div className="table-scroll compare-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th><button className="sort-button" onClick={() => changeSort('symbol')}>Company {sortIcon('symbol')}</button></th>
                        {comparisonColumns
                          .filter((column) => visibleColumns.includes(column.id))
                          .map((column) => (
                            <th key={column.id}>
                              <button className="sort-button" onClick={() => changeSort(column.id)}>
                                {column.label} {sortIcon(column.id)}
                              </button>
                              <MetricInfo description={column.description} formula={column.formula} />
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {screenedSymbols.map((symbol) => {
                        const item = fundamentals[symbol]
                        if (!item) {
                          return (
                            <tr key={symbol} className={enabledSymbolSet.has(symbol) ? undefined : 'inactive-row'}>
                              <td><div className="company-cell">{compareVisibilityControl(symbol)}<strong>{symbol}</strong></div></td>
                              <td colSpan={visibleColumns.length} className={symbolErrors[symbol] ? 'load-error' : ''}>
                                {symbolErrors[symbol] ?? 'Calculating…'}
                              </td>
                            </tr>
                          )
                        }
                        return (
                          <tr key={symbol} className={enabledSymbolSet.has(symbol) ? undefined : 'inactive-row'}>
                            <td>
                              <div className="company-cell">
                                {compareVisibilityControl(symbol)}
                                <i style={{ background: enabledSymbolSet.has(symbol) ? colorFor(symbol) : inactiveTraceColor }} />
                                <button className="symbol-open" onClick={() => openSymbolDetail(symbol)} title={`Show source data for ${symbol}`}>
                                  <strong>{symbol}</strong>
                                  <small>{isMobile ? truncateAtWordBoundary(item.name, 16) : item.name}</small>
                                  <small className="symbol-exchange">{isMobile ? truncateAtWordBoundary(item.fullExchange || item.exchange, 16) : (item.fullExchange || item.exchange)}</small>
                                </button>
                              </div>
                            </td>
                            {visibleColumns.map((column) => renderMetricCell(column, item, true))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {screenedFunds.length > 0 && (
              <>
                <div className="table-group-header">
                  <h3 className="table-group-title">Funds and ETFs</h3>
                  <details className="column-picker">
                    <summary><Settings2 size={15} /> Columns <b>{visibleFundColumns.length}</b></summary>
                    <div className="column-menu">
                      <div className="column-menu-heading">
                        <strong>Visible metrics</strong>
                        <button
                          type="button"
                          onClick={() =>
                            setVisibleFundColumns(visibleFundColumns.length === fundColumns.length ? [] : defaultFundColumns)
                          }
                        >
                          {visibleFundColumns.length === fundColumns.length ? 'Hide all' : 'Show all'}
                        </button>
                        <button type="button" onClick={() => setVisibleFundColumns(defaultFundColumns)}>Reset</button>
                      </div>
                      {fundColumns.map((column) => (
                        <label key={column.id}>
                          <input
                            type="checkbox"
                            checked={visibleFundColumns.includes(column.id)}
                            onChange={() => toggleFundColumn(column.id)}
                          />
                          <span>{column.label}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                <div className="table-scroll compare-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th><button className="sort-button" onClick={() => changeFundSort('symbol')}>Fund {fundSortIcon('symbol')}</button></th>
                        {fundColumns
                          .filter((column) => visibleFundColumns.includes(column.id))
                          .map((column) => (
                            <th key={column.id}>
                              <button className="sort-button" onClick={() => changeFundSort(column.id)}>
                                {column.label} {fundSortIcon(column.id)}
                              </button>
                              <MetricInfo description={column.description} formula={column.formula} />
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {screenedFunds.map((symbol) => {
                        const item = fundamentals[symbol]
                        if (!item) {
                          return (
                            <tr key={symbol} className={enabledSymbolSet.has(symbol) ? undefined : 'inactive-row'}>
                              <td><div className="company-cell">{compareVisibilityControl(symbol)}<strong>{symbol}</strong></div></td>
                              <td colSpan={visibleFundColumns.length} className={symbolErrors[symbol] ? 'load-error' : ''}>
                                {symbolErrors[symbol] ?? 'Calculating…'}
                              </td>
                            </tr>
                          )
                        }
                        return (
                          <tr key={symbol} className={enabledSymbolSet.has(symbol) ? undefined : 'inactive-row'}>
                            <td>
                              <div className="company-cell">
                                {compareVisibilityControl(symbol)}
                                <i style={{ background: enabledSymbolSet.has(symbol) ? colorFor(symbol) : inactiveTraceColor }} />
                                <button className="symbol-open" onClick={() => openSymbolDetail(symbol)} title={`Show source data for ${symbol}`}>
                                  <strong>{symbol}</strong>
                                  <small>{isMobile ? truncateAtWordBoundary(item.name, 16) : item.name}</small>
                                  <small className="symbol-exchange">{isMobile ? truncateAtWordBoundary(item.fullExchange || item.exchange, 16) : (item.fullExchange || item.exchange)}</small>
                                </button>
                              </div>
                            </td>
                            {visibleFundColumns.map((column) => renderFundCell(column, item))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {screenedBondFunds.length > 0 && (
              <>
                <div className="table-group-header">
                  <h3 className="table-group-title">Bond funds</h3>
                  <details className="column-picker">
                    <summary><Settings2 size={15} /> Columns <b>{visibleBondColumns.length}</b></summary>
                    <div className="column-menu">
                      <div className="column-menu-heading">
                        <strong>Visible metrics</strong>
                        <button
                          type="button"
                          onClick={() =>
                            setVisibleBondColumns(visibleBondColumns.length === bondColumns.length ? [] : defaultBondColumns)
                          }
                        >
                          {visibleBondColumns.length === bondColumns.length ? 'Hide all' : 'Show all'}
                        </button>
                        <button type="button" onClick={() => setVisibleBondColumns(defaultBondColumns)}>Reset</button>
                      </div>
                      {bondColumns.map((column) => (
                        <label key={column.id}>
                          <input
                            type="checkbox"
                            checked={visibleBondColumns.includes(column.id)}
                            onChange={() => toggleBondColumn(column.id)}
                          />
                          <span>{column.label}</span>
                        </label>
                      ))}
                    </div>
                  </details>
                </div>
                <div className="table-scroll compare-table-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th><button className="sort-button" onClick={() => changeBondSort('symbol')}>Fund {bondSortIcon('symbol')}</button></th>
                        {bondColumns
                          .filter((column) => visibleBondColumns.includes(column.id))
                          .map((column) => (
                            <th key={column.id}>
                              <button className="sort-button" onClick={() => changeBondSort(column.id)}>
                                {column.label} {bondSortIcon(column.id)}
                              </button>
                              <MetricInfo description={column.description} formula={column.formula} />
                            </th>
                          ))}
                      </tr>
                    </thead>
                    <tbody>
                      {screenedBondFunds.map((symbol) => {
                        const item = fundamentals[symbol]
                        if (!item) {
                          return (
                            <tr key={symbol} className={enabledSymbolSet.has(symbol) ? undefined : 'inactive-row'}>
                              <td><div className="company-cell">{compareVisibilityControl(symbol)}<strong>{symbol}</strong></div></td>
                              <td colSpan={visibleBondColumns.length} className={symbolErrors[symbol] ? 'load-error' : ''}>
                                {symbolErrors[symbol] ?? 'Calculating…'}
                              </td>
                            </tr>
                          )
                        }
                        return (
                          <tr key={symbol} className={enabledSymbolSet.has(symbol) ? undefined : 'inactive-row'}>
                            <td>
                              <div className="company-cell">
                                {compareVisibilityControl(symbol)}
                                <i style={{ background: enabledSymbolSet.has(symbol) ? colorFor(symbol) : inactiveTraceColor }} />
                                <button className="symbol-open" onClick={() => openSymbolDetail(symbol)} title={`Show source data for ${symbol}`}>
                                  <strong>{symbol}</strong>
                                  <small>{isMobile ? truncateAtWordBoundary(item.name, 16) : item.name}</small>
                                  <small className="symbol-exchange">{isMobile ? truncateAtWordBoundary(item.fullExchange || item.exchange, 16) : (item.fullExchange || item.exchange)}</small>
                                </button>
                              </div>
                            </td>
                            {visibleBondColumns.map((column) => renderBondCell(column, item))}
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
            {!loading && screenedSymbols.length === 0 && screenedFunds.length === 0 && screenedBondFunds.length === 0 && (
              <p className="no-results">No portfolio symbols match the current filters.</p>
            )}
            <div className="method-note">
              <strong>Methodology</strong>
              <span>Growth metrics use reported quarterly SEC facts. Restatements are resolved to the latest filed value. “EW” applies α = 0.45, giving more weight to recent quarters.</span>
            </div>
          </section>
        )}
      </main>
      {openSymbol &&
        createPortal(
          <SymbolDetailPanel
            symbol={openSymbol}
            detail={details[openSymbol] ?? null}
            summary={fundamentals[openSymbol]}
            history={detailHistories[detailHistoryKey] ?? []}
            events={detailHistoryEvents[detailHistoryKey] ?? []}
            range={detailRange}
            onRangeChange={setDetailRange}
            error={detailErrors[openSymbol]}
            onClose={() => { setOpenSymbol(null); setSymbolHistory([]) }}
            onBack={symbolHistory.length > 0 ? goBackSymbol : undefined}
            colorFor={colorFor}
            constituents={fundConstituents[openSymbol] ?? null}
            constituentsError={fundConstituentErrors[openSymbol]}
            onOpenSymbol={openNestedSymbolDetail}
            news={newsBySymbol[`${openSymbol}:${detailRange}`] ?? null}
            newsLoading={newsLoading[`${openSymbol}:${detailRange}`] ?? false}
            newsError={newsErrors[`${openSymbol}:${detailRange}`]}
          />,
          getOverlayRoot()
        )}
      <footer>This research tool is not investment advice. Filing taxonomy differences may leave some metrics unavailable.</footer>
    </div>
  )
}

export default App
