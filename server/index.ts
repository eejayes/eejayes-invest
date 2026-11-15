import cors from 'cors'
import express from 'express'
import { sharesFromFiling } from './filingShares'
import { classEpsFromFiling } from './filingEps'
import { sourceLinks } from './sourceLinks'
import { netTangibleAssetsPerShare, preferredStockValue, priceToNetTangibleAssets, totalIntangibleAssets } from './tangibleAssets'
import { yahooSymbol } from './yahooSymbol'

// A single flaky upstream fetch (Yahoo/SEC rate-limiting, DNS blips, timeouts) must not take
// down the whole API: without these handlers Node 18 terminates the process on any unhandled
// promise rejection, which silently kills every in-flight and future request — including ones
// for symbols that have nothing to do with whatever triggered the rejection — until the
// process is manually restarted.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection (ignored, server stays up):', reason)
})
process.on('uncaughtException', (error) => {
  console.error('Uncaught exception (ignored, server stays up):', error)
})

const app = express()
const port = Number(process.env.PORT ?? 8787)
const yahooBase = 'https://query1.finance.yahoo.com'
const secHeaders = {
  'User-Agent': process.env.SEC_USER_AGENT ?? 'EquityResearchDashboard research-app contact@example.com',
  Accept: 'application/json',
}

type FactUnit = {
  start?: string
  end: string
  val: number
  accn: string
  fy?: number
  fp?: string
  form: string
  filed: string
  frame?: string
}

type CompanyFacts = {
  cik?: number
  entityName: string
  facts: {
    'us-gaap'?: Record<string, { label: string; units: Record<string, FactUnit[]> }>
    dei?: Record<string, { label: string; units: Record<string, FactUnit[]> }>
  }
}

const revenueFactNames = [
  'RevenueFromContractWithCustomerExcludingAssessedTax',
  'SalesRevenueNet',
  'Revenues',
  'RevenuesNetOfInterestExpense',
]
const combinedIntangibleFactNames = ['GoodwillAndIntangibleAssetsNet', 'IntangibleAssetsNetIncludingGoodwill']
const goodwillFactNames = ['Goodwill']
const otherIntangibleFactNames = ['IntangibleAssetsNetExcludingGoodwill']
const preferredStockFactNames = ['PreferredStockCarryingValue', 'PreferredStockValue']
const preferredSharesFactNames = ['PreferredStockSharesOutstanding']

type Quarter = {
  end: string
  filed: string
  eps: number | null
  revenue: number | null
  dividendsPerShare: number | null
  bookValuePerShare: number | null
  operatingIncome: number | null
  preTaxIncome: number | null
  incomeTaxExpense: number | null
  investedCapital: number | null
}

const cache = new Map<string, { expires: number; data: unknown }>()

async function cachedJson<T>(key: string, ttlMs: number, request: () => Promise<Response>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data as T

  const response = await request()
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`)
  const data = (await response.json()) as T
  cache.set(key, { expires: Date.now() + ttlMs, data })
  return data
}

async function cachedText(key: string, ttlMs: number, request: () => Promise<Response>): Promise<string> {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data as string

  const response = await request()
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`)
  const data = await response.text()
  cache.set(key, { expires: Date.now() + ttlMs, data })
  return data
}

async function cachedValue<T>(key: string, ttlMs: number, compute: () => Promise<T>): Promise<T> {
  const hit = cache.get(key)
  if (hit && hit.expires > Date.now()) return hit.data as T
  const data = await compute()
  cache.set(key, { expires: Date.now() + ttlMs, data })
  return data
}

function sendError(res: express.Response, error: unknown) {
  const message = error instanceof Error ? error.message : 'Unexpected server error'
  console.error(message)
  res.status(502).json({ error: message })
}

/**
 * Picks the best-populated tag from a list of synonyms.
 *
 * Taking the first tag that merely exists is unreliable: Coca-Cola still carries a
 * CommonStockDividendsPerShareDeclared series that stopped in 2018 alongside a current
 * CommonStockDividendsPerShareCashPaid series, so "first present" silently yielded stale
 * facts that matched no recent quarter. Preferring the most recently reported series keeps
 * the earlier names as genuine fallbacks without letting an abandoned tag win.
 */
function firstFact(facts: CompanyFacts, names: string[], namespaces: string[] = ['us-gaap']) {
  let best: { fact: NonNullable<ReturnType<typeof pickFact>>; end: string } | undefined
  for (const namespace of namespaces) {
    const group = facts.facts[namespace as keyof CompanyFacts['facts']] ?? {}
    for (const name of names) {
      const fact = group[name]
      if (!fact) continue
      const end = latestReportedEnd(fact)
      if (!end) continue
      if (!best || end > best.end) best = { fact, end }
    }
  }
  return best?.fact
}

function pickFact(facts: CompanyFacts, name: string) {
  return (facts.facts['us-gaap'] ?? {})[name]
}

function latestReportedEnd(fact: NonNullable<ReturnType<typeof pickFact>>) {
  let latest = ''
  for (const rows of Object.values(fact.units)) {
    for (const row of rows) {
      if (row.end > latest) latest = row.end
    }
  }
  return latest || null
}

function quarterlyValues(fact: ReturnType<typeof firstFact>, preferredUnit: string): FactUnit[] {
  if (!fact) return []
  const units = fact.units[preferredUnit] ?? Object.values(fact.units)[0] ?? []
  const candidates = units.filter(
    (row) =>
      ['10-Q', '10-K'].includes(row.form) &&
      row.start &&
      (new Date(row.end).getTime() - new Date(row.start).getTime()) / 86_400_000 < 150,
  )

  const latestByEnd = new Map<string, FactUnit>()
  for (const row of candidates) {
    const current = latestByEnd.get(row.end)
    if (!current || row.filed > current.filed) latestByEnd.set(row.end, row)
  }
  return [...latestByEnd.values()].sort((a, b) => a.end.localeCompare(b.end))
}

function instantValues(fact: ReturnType<typeof firstFact>, preferredUnit: string): FactUnit[] {
  if (!fact) return []
  const units = fact.units[preferredUnit] ?? Object.values(fact.units)[0] ?? []
  const latestByEnd = new Map<string, FactUnit>()
  for (const row of units.filter((item) => ['10-Q', '10-K'].includes(item.form))) {
    const current = latestByEnd.get(row.end)
    if (!current || row.filed > current.filed) latestByEnd.set(row.end, row)
  }
  return [...latestByEnd.values()].sort((a, b) => a.end.localeCompare(b.end))
}

function joinQuarters(
  eps: FactUnit[],
  revenue: FactUnit[],
  dividendsPerShare: FactUnit[],
  equity: FactUnit[],
  shares: FactUnit[],
  operatingIncome: FactUnit[] = [],
  preTaxIncome: FactUnit[] = [],
  incomeTaxExpense: FactUnit[] = [],
  cash: FactUnit[] = [],
  longTermDebt: FactUnit[] = [],
  shortTermDebt: FactUnit[] = [],
  sharesFromFilings = false,
): Quarter[] {
  const dates = [...new Set([...eps.map((x) => x.end), ...revenue.map((x) => x.end)])].sort()
  return dates.slice(-16).map((end) => {
    const epsRow = eps.find((x) => x.end === end)
    const revenueRow = revenue.find((x) => x.end === end)
    const filed = epsRow?.filed ?? revenueRow?.filed ?? end
    const equityAtEnd = valueAtEnd(equity, end)
    const sharesAtEnd = shares.find((row) => row.end === end && (!sharesFromFilings || row.filed <= filed))?.val ?? null
    const longDebtAtEnd = valueAtEnd(longTermDebt, end)
    const shortDebtAtEnd = valueAtEnd(shortTermDebt, end)
    const totalDebtAtEnd = longDebtAtEnd == null && shortDebtAtEnd == null ? null : (longDebtAtEnd ?? 0) + (shortDebtAtEnd ?? 0)
    const cashAtEnd = valueAtEnd(cash, end)
    const investedCapital = equityAtEnd != null
      ? equityAtEnd + (totalDebtAtEnd ?? 0) - (cashAtEnd ?? 0)
      : null
    return {
      end,
      filed,
      eps: epsRow?.val ?? null,
      revenue: revenueRow?.val ?? null,
      dividendsPerShare: valueAtEnd(dividendsPerShare, end),
      bookValuePerShare: equityAtEnd != null && sharesAtEnd ? equityAtEnd / sharesAtEnd : null,
      operatingIncome: valueAtEnd(operatingIncome, end),
      preTaxIncome: valueAtEnd(preTaxIncome, end),
      incomeTaxExpense: valueAtEnd(incomeTaxExpense, end),
      investedCapital,
    }
  })
}

function growth(current: number | null | undefined, previous: number | null | undefined) {
  if (current == null || previous == null || previous === 0) return null
  return ((current - previous) / Math.abs(previous)) * 100
}

function valueAtEnd(rows: FactUnit[], end: string): number | null {
  return rows.find((row) => row.end === end)?.val ?? null
}

function tangibleInputs(at: (id: string) => number | null) {
  const assets = at('assets')
  const reportedLiabilities = at('liabilities')
  const totalEquity = at('totalEquity')
  const liabilities = reportedLiabilities ?? (assets != null && totalEquity != null ? assets - totalEquity : null)
  const combined = at('intangibleAssets')
  const goodwill = at('goodwill')
  const otherIntangibles = at('otherIntangibleAssets')
  const preferred = preferredStockValue(at('preferredStock'), at('preferredShares'))
  const assumptions = [
    assets == null && 'total assets',
    liabilities == null && 'total liabilities',
    combined == null && goodwill == null && 'goodwill',
    combined == null && otherIntangibles == null && 'other intangible assets',
    preferred == null && 'preferred stock',
  ].filter((value): value is string => !!value)
  return {
    assets: assets ?? 0,
    liabilities: liabilities ?? 0,
    liabilitiesDerived: reportedLiabilities == null && liabilities != null,
    intangibleAssets: totalIntangibleAssets(combined, goodwill, otherIntangibles),
    preferredStock: preferred ?? 0,
    assumptions,
  }
}

function yahooTangibleInputs(bs: any, raw: (value: any) => number | null) {
  const values: Record<string, number | null> = {
    assets: raw(bs?.totalAssets),
    liabilities: raw(bs?.totalLiab),
    intangibleAssets: raw(bs?.goodwillAndOtherIntangibleAssets),
    goodwill: raw(bs?.goodWill),
    otherIntangibleAssets: raw(bs?.intangibleAssets),
    preferredStock: raw(bs?.preferredStock),
    preferredShares: raw(bs?.preferredStockSharesOutstanding),
  }
  return tangibleInputs((id) => values[id] ?? null)
}

function tangibleAssumptionsNote(assumptions: string[]) {
  return assumptions.length ? `Assumed zero for unreported ${assumptions.join(', ')}.` : undefined
}

function tangibleRatioNote(perShare: number | null, ratio: number | null, assumptions: string[], missingReason?: string) {
  const assumptionsNote = tangibleAssumptionsNote(assumptions.filter((item) => item !== 'preferred stock'))
  if (perShare == null) return missingReason
  const reason = perShare <= 0
    ? `Net tangible assets per share is ${perShare < 0 ? 'negative' : 'zero'}.`
    : ratio == null ? 'A positive price is required.' : undefined
  return [reason, assumptionsNote].filter(Boolean).join(' ') || undefined
}

function incrementalRoic(quarters: Quarter[]): { value: number | null; note?: string } {
  if (quarters.length < 8) {
    return { value: null, note: `Needs eight quarters to compare two trailing-year periods; SEC filings provide ${quarters.length}.` }
  }

  const missing = new Set<string>()
  const nopat = (window: Quarter[]) => {
    const operatingIncome = window.map((quarter) => quarter.operatingIncome)
    const preTaxIncome = window.map((quarter) => quarter.preTaxIncome)
    const incomeTaxExpense = window.map((quarter) => quarter.incomeTaxExpense)
    if (!operatingIncome.every((value): value is number => value != null)) {
      missing.add('operating income (OperatingIncomeLoss)')
      return null
    }
    if (!preTaxIncome.every((value): value is number => value != null)) {
      missing.add('pre-tax income')
      return null
    }
    if (!incomeTaxExpense.every((value): value is number => value != null)) {
      missing.add('income tax expense')
      return null
    }
    const operating = operatingIncome.reduce((sum, value) => sum + value, 0)
    const preTax = preTaxIncome.reduce((sum, value) => sum + value, 0)
    const tax = incomeTaxExpense.reduce((sum, value) => sum + value, 0)
    if (preTax <= 0 || tax < 0) {
      missing.add('positive pre-tax income and non-negative tax expense')
      return null
    }
    const taxRate = tax / preTax
    if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
      missing.add('a usable effective tax rate')
      return null
    }
    return operating * (1 - taxRate)
  }

  for (let index = quarters.length - 1; index >= 7; index -= 1) {
    const currentNopat = nopat(quarters.slice(index - 3, index + 1))
    const priorNopat = nopat(quarters.slice(index - 7, index - 3))
    const currentCapital = quarters[index].investedCapital
    const priorCapital = quarters[index - 4].investedCapital
    if (currentNopat == null || priorNopat == null) continue
    if (currentCapital == null || priorCapital == null) {
      missing.add('invested capital, from equity plus debt less cash')
      continue
    }
    const capitalAdded = currentCapital - priorCapital
    if (capitalAdded <= 0) {
      missing.add('a positive increase in invested capital')
      continue
    }
    return { value: ((currentNopat - priorNopat) / capitalAdded) * 100 }
  }

  return {
    value: null,
    note: `No trailing-year comparison had all required inputs. Missing or unusable from SEC filings: ${[...missing].join('; ')}.`,
  }
}

function exponentiallyWeightedGrowth(values: Array<number | null>, alpha = 0.45) {
  const valid = values.filter((value): value is number => value != null)
  if (valid.length < 2) return null
  const changes = valid.slice(1).map((value, index) => growth(value, valid[index])).filter((x): x is number => x != null)
  if (!changes.length) return null
  let weighted = changes[0]
  for (const change of changes.slice(1)) weighted = alpha * change + (1 - alpha) * weighted
  return weighted
}

async function tickerMap() {
  return cachedJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
    'sec-tickers',
    24 * 60 * 60 * 1000,
    () => fetch('https://www.sec.gov/files/company_tickers.json', { headers: secHeaders }),
  )
}

async function freshJson<T>(url: string, headers?: Record<string, string>): Promise<T> {
  const separator = url.includes('?') ? '&' : '?'
  const response = await fetch(`${url}${separator}_=${Date.now()}`, {
    headers: { ...headers, 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  })
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`)
  return response.json() as Promise<T>
}

async function freshText(url: string): Promise<string> {
  const separator = url.includes('?') ? '&' : '?'
  const response = await fetch(`${url}${separator}_=${Date.now()}`, {
    headers: { 'Cache-Control': 'no-cache', Pragma: 'no-cache' },
  })
  if (!response.ok) throw new Error(`Upstream request failed (${response.status})`)
  return response.text()
}

function parsePipeRows(text: string) {
  const lines = text.trim().split(/\r?\n/)
  const headers = lines[0].split('|')
  return lines.slice(1)
    .filter((line) => !line.startsWith('File Creation Time'))
    .map((line) => Object.fromEntries(headers.map((header, index) => [header, line.split('|')[index] ?? ''])))
}

function isCommonEquity(name: string) {
  // Non-common securities (preferred, debentures, notes) frequently share their issuer's CIK,
  // so a market cap built from that CIK's share count would be meaningless for them.
  // Plural forms matter: listings are named "- Warrants" / "- Rights", so \bWarrant\b alone
  // would let every warrant through.
  if (/\d(\.\d+)?\s*%/.test(name)) return false
  return !/\b(ETFs?|ETNs?|Warrants?|Rights?|Units?|Preferred|Preference|Depositary|Debentures?|Subordinated|Notes?|Bonds?|Funds?|Trusts?)\b/i.test(name)
}

function recentInstantFrames(count: number) {
  const frames: string[] = []
  const now = new Date()
  let year = now.getUTCFullYear()
  // Filings lag the period end, so start one quarter back from the current one.
  let quarter = Math.floor(now.getUTCMonth() / 3)
  for (let index = 0; index < count; index += 1) {
    if (quarter < 1) {
      quarter = 4
      year -= 1
    }
    frames.push(`CY${year}Q${quarter}I`)
    quarter -= 1
  }
  return frames
}

type FrameFact = { cik: number; val: number }

/**
 * Shares outstanding for every SEC filer in a handful of bulk requests.
 *
 * Screening market cap previously called fundamentals() per candidate, which downloads a
 * ~3.7 MB companyfacts document each time. The XBRL "frames" API returns one quarter of a
 * single tag for all ~4,500 filers in ~600 KB, so a whole screen costs a few requests
 * instead of thousands of multi-megabyte ones.
 */
async function sharesOutstandingByCik(): Promise<Map<number, number>> {
  const cacheKey = 'frames:shares-outstanding'
  const hit = cache.get(cacheKey)
  if (hit && hit.expires > Date.now()) return hit.data as Map<number, number>

  const merged = new Map<number, number>()
  const frames = recentInstantFrames(4)
  const results = await Promise.all(
    frames.map(async (frame) => {
      for (const tag of ['dei/EntityCommonStockSharesOutstanding', 'us-gaap/CommonStockSharesOutstanding']) {
        try {
          const response = await fetch(
            `https://data.sec.gov/api/xbrl/frames/${tag}/shares/${frame}.json`,
            { headers: secHeaders },
          )
          if (!response.ok) continue
          const body = (await response.json()) as { data?: FrameFact[] }
          if (body.data?.length) return body.data
        } catch {
          // Ignore and fall through to the next tag or frame.
        }
      }
      return [] as FrameFact[]
    }),
  )

  // Applied oldest-first so newer quarters overwrite stale share counts.
  for (const rows of results.reverse()) {
    for (const row of rows) {
      if (row.val > 0) merged.set(row.cik, row.val)
    }
  }

  if (merged.size) cache.set(cacheKey, { expires: Date.now() + 24 * 60 * 60 * 1000, data: merged })
  return merged
}

/**
 * CIKs that report under US GAAP, used to exclude foreign private issuers.
 *
 * Foreign issuers (Toyota, Banco de Chile) file 20-F under IFRS and report their *local*
 * share count, while the US listing trades as an ADR representing many local shares. Mixing
 * the two produces wildly inflated market caps — Banco de Chile screened as a $500B company
 * against a real cap near $14B. They also report no us-gaap facts, so every fundamentals
 * column renders blank. Presence in a us-gaap frame is a reliable, bulk-fetchable signal.
 */
async function usGaapFilerCiks(): Promise<Set<number>> {
  const cacheKey = 'frames:us-gaap-filers'
  const hit = cache.get(cacheKey)
  if (hit && hit.expires > Date.now()) return hit.data as Set<number>

  const merged = new Set<number>()
  const results = await Promise.all(
    recentInstantFrames(4).map(async (frame) => {
      try {
        const response = await fetch(
          `https://data.sec.gov/api/xbrl/frames/us-gaap/Assets/USD/${frame}.json`,
          { headers: secHeaders },
        )
        if (!response.ok) return [] as FrameFact[]
        const body = (await response.json()) as { data?: FrameFact[] }
        return body.data ?? []
      } catch {
        return [] as FrameFact[]
      }
    }),
  )

  // Several quarters are merged because an instant frame only contains filers whose balance
  // sheet date falls in that quarter, so any single frame misses off-cycle reporters.
  for (const rows of results) {
    for (const row of rows) merged.add(row.cik)
  }

  if (merged.size) cache.set(cacheKey, { expires: Date.now() + 24 * 60 * 60 * 1000, data: merged })
  return merged
}

async function getUsdRate(currency: string): Promise<number> {
  const cur = (currency || 'USD').trim()
  const upper = cur.toUpperCase()
  if (upper === 'USD') return 1

  const cacheKey = `fx-rate-to-usd:${cur}`
  const hit = cache.get(cacheKey)
  if (hit && hit.expires > Date.now()) return hit.data as number

  let multiplier = 1
  let code = upper
  if (cur === 'GBp' || cur === 'GBX' || upper === 'GBP_PENCE') {
    multiplier = 0.01
    code = 'GBP'
  } else if (upper === 'ILA') {
    multiplier = 0.01
    code = 'ILS'
  } else if (upper === 'ZAC') {
    multiplier = 0.01
    code = 'ZAR'
  }

  let rate = 1
  try {
    const res = await fetch(`${yahooBase}/v8/finance/chart/${code}USD=X?range=1d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const data = (await res.json()) as any
    const p = data?.chart?.result?.[0]?.meta?.regularMarketPrice
    if (typeof p === 'number' && p > 0) {
      rate = p * multiplier
      cache.set(cacheKey, { expires: Date.now() + 60 * 60 * 1000, data: rate })
      return rate
    }
  } catch {}

  try {
    const res = await fetch(`${yahooBase}/v8/finance/chart/USD${code}=X?range=1d&interval=1d`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const data = (await res.json()) as any
    const p = data?.chart?.result?.[0]?.meta?.regularMarketPrice
    if (typeof p === 'number' && p > 0) {
      rate = (1 / p) * multiplier
      cache.set(cacheKey, { expires: Date.now() + 60 * 60 * 1000, data: rate })
      return rate
    }
  } catch {}

  cache.set(cacheKey, { expires: Date.now() + 10 * 60 * 1000, data: multiplier })
  return multiplier
}

function getExchangeAndRegion(meta: any = {}, symbol: string = ""): { full: string; region: string } {
  const exch = (meta.exchangeName || "").toUpperCase()
  const full = (meta.fullExchangeName || "").toUpperCase()
  const tz = meta.exchangeTimezoneName || ""
  const upperSym = symbol.toUpperCase()

  const exchangeMap: Record<string, { full: string; region: string }> = {
    NMS: { full: "NASDAQ", region: "USA" },
    NGM: { full: "NASDAQ", region: "USA" },
    NCM: { full: "NASDAQ Capital Market", region: "USA" },
    NYQ: { full: "New York Stock Exchange (NYSE)", region: "USA" },
    NYSE: { full: "New York Stock Exchange (NYSE)", region: "USA" },
    PCX: { full: "NYSE Arca", region: "USA" },
    ASE: { full: "NYSE American", region: "USA" },
    BTS: { full: "Cboe BZX", region: "USA" },
    BZX: { full: "Cboe BZX", region: "USA" },
    OQX: { full: "OTC Markets OTCQX", region: "USA" },
    OBB: { full: "OTC Markets OTCQB", region: "USA" },
    PNK: { full: "OTC Markets Pink", region: "USA" },
    
    // Canada
    TOR: { full: "Toronto Stock Exchange (TSX)", region: "North America" },
    TSX: { full: "Toronto Stock Exchange (TSX)", region: "North America" },
    VAN: { full: "TSX Venture Exchange", region: "North America" },
    TSXV: { full: "TSX Venture Exchange", region: "North America" },
    CNQ: { full: "Canadian Securities Exchange (CSE)", region: "North America" },
    NEO: { full: "Cboe Canada (NEO)", region: "North America" },

    // Europe - UK
    LSE: { full: "London Stock Exchange (LSE)", region: "Europe" },
    IOB: { full: "London Stock Exchange (IOB)", region: "Europe" },

    // Europe - Euronext
    PAR: { full: "Euronext Paris", region: "Europe" },
    AMS: { full: "Euronext Amsterdam", region: "Europe" },
    BRU: { full: "Euronext Brussels", region: "Europe" },
    LIS: { full: "Euronext Lisbon", region: "Europe" },
    DUB: { full: "Euronext Dublin", region: "Europe" },
    MIL: { full: "Borsa Italiana (Milan)", region: "Europe" },
    MTA: { full: "Borsa Italiana (Milan)", region: "Europe" },

    // Europe - Germany
    GER: { full: "Deutsche Börse XETRA", region: "Europe" },
    XETRA: { full: "Deutsche Börse XETRA", region: "Europe" },
    FRA: { full: "Frankfurt Stock Exchange", region: "Europe" },
    BER: { full: "Berlin Stock Exchange", region: "Europe" },
    MUN: { full: "Munich Stock Exchange", region: "Europe" },
    STU: { full: "Stuttgart Stock Exchange", region: "Europe" },
    DUS: { full: "Düsseldorf Stock Exchange", region: "Europe" },
    HAM: { full: "Hamburg Stock Exchange", region: "Europe" },

    // Europe - Other
    SWX: { full: "SIX Swiss Exchange (Zurich)", region: "Europe" },
    VTX: { full: "SIX Swiss Exchange (Zurich)", region: "Europe" },
    EBS: { full: "SIX Swiss Exchange (Zurich)", region: "Europe" },
    SIX: { full: "SIX Swiss Exchange (Zurich)", region: "Europe" },
    MCE: { full: "Bolsa de Madrid (BME)", region: "Europe" },
    MAD: { full: "Bolsa de Madrid (BME)", region: "Europe" },
    STO: { full: "Nasdaq Stockholm", region: "Europe" },
    CPH: { full: "Nasdaq Copenhagen", region: "Europe" },
    HEL: { full: "Nasdaq Helsinki", region: "Europe" },
    ICE: { full: "Nasdaq Iceland", region: "Europe" },
    OSL: { full: "Oslo Børs", region: "Europe" },
    VIE: { full: "Vienna Stock Exchange", region: "Europe" },
    WSE: { full: "Warsaw Stock Exchange", region: "Europe" },
    ATH: { full: "Athens Stock Exchange", region: "Europe" },
    PRA: { full: "Prague Stock Exchange", region: "Europe" },
    BUD: { full: "Budapest Stock Exchange", region: "Europe" },
    IST: { full: "Borsa Istanbul", region: "Europe" },

    // Asia
    JPX: { full: "Tokyo Stock Exchange (TSE)", region: "Asia" },
    TYO: { full: "Tokyo Stock Exchange (TSE)", region: "Asia" },
    TSE: { full: "Tokyo Stock Exchange (TSE)", region: "Asia" },
    FKA: { full: "Fukuoka Stock Exchange", region: "Asia" },
    SAP: { full: "Sapporo Securities Exchange", region: "Asia" },
    KSC: { full: "Korea Exchange (KRX)", region: "Asia" },
    KOE: { full: "Korea Exchange (KOSDAQ)", region: "Asia" },
    KSE: { full: "Korea Exchange (KRX)", region: "Asia" },
    KRX: { full: "Korea Exchange (KRX)", region: "Asia" },
    HKG: { full: "Hong Kong Stock Exchange (HKEX)", region: "Asia" },
    HKEX: { full: "Hong Kong Stock Exchange (HKEX)", region: "Asia" },
    SHH: { full: "Shanghai Stock Exchange (SSE)", region: "Asia" },
    SHZ: { full: "Shenzhen Stock Exchange (SZSE)", region: "Asia" },
    TAI: { full: "Taiwan Stock Exchange (TWSE)", region: "Asia" },
    TWO: { full: "Taipei Exchange (TPEx)", region: "Asia" },
    SES: { full: "Singapore Exchange (SGX)", region: "Asia" },
    SGX: { full: "Singapore Exchange (SGX)", region: "Asia" },
    NSI: { full: "National Stock Exchange of India (NSE)", region: "Asia" },
    BOM: { full: "BSE India (Bombay)", region: "Asia" },
    SET: { full: "Stock Exchange of Thailand (SET)", region: "Asia" },
    JKT: { full: "Indonesia Stock Exchange (IDX)", region: "Asia" },
    KLS: { full: "Bursa Malaysia", region: "Asia" },
    PSE: { full: "Philippine Stock Exchange (PSE)", region: "Asia" },
    VNM: { full: "Ho Chi Minh Stock Exchange (HOSE)", region: "Asia" },

    // Oceania
    ASX: { full: "Australian Securities Exchange (ASX)", region: "Oceania" },
    NZE: { full: "New Zealand Exchange (NZX)", region: "Oceania" },

    // Latin America / South & Central America
    SAO: { full: "B3 Brasil Bolsa Balcão (São Paulo)", region: "Latin America" },
    MEX: { full: "Bolsa Mexicana de Valores (BMV)", region: "Latin America" },
    BVA: { full: "Bolsa de Valores de Colombia (BVC)", region: "Latin America" },
    SGO: { full: "Bolsa de Santiago (Chile)", region: "Latin America" },
    BUE: { full: "Bolsas y Mercados Argentinos (BYMA)", region: "Latin America" },
    LIM: { full: "Bolsa de Valores de Lima (BVL)", region: "Latin America" },

    // Middle East
    TLV: { full: "Tel Aviv Stock Exchange (TASE)", region: "Middle East" },
    TASE: { full: "Tel Aviv Stock Exchange (TASE)", region: "Middle East" },
    SAU: { full: "Saudi Tadawul", region: "Middle East" },
    DFM: { full: "Dubai Financial Market (DFM)", region: "Middle East" },
    ADX: { full: "Abu Dhabi Securities Exchange (ADX)", region: "Middle East" },
    QSE: { full: "Qatar Stock Exchange", region: "Middle East" },

    // Africa
    JNB: { full: "Johannesburg Stock Exchange (JSE)", region: "Africa" },
    CAI: { full: "The Egyptian Exchange (EGX)", region: "Africa" },
  }

  const suffixMap: Record<string, { full: string; region: string }> = {
    ".AX": { full: "Australian Securities Exchange (ASX)", region: "Oceania" },
    ".L": { full: "London Stock Exchange (LSE)", region: "Europe" },
    ".IL": { full: "London Stock Exchange (IOB)", region: "Europe" },
    ".PA": { full: "Euronext Paris", region: "Europe" },
    ".AS": { full: "Euronext Amsterdam", region: "Europe" },
    ".BR": { full: "Euronext Brussels", region: "Europe" },
    ".LS": { full: "Euronext Lisbon", region: "Europe" },
    ".IR": { full: "Euronext Dublin", region: "Europe" },
    ".MI": { full: "Borsa Italiana (Milan)", region: "Europe" },
    ".MC": { full: "Bolsa de Madrid (BME)", region: "Europe" },
    ".DE": { full: "Deutsche Börse XETRA", region: "Europe" },
    ".F": { full: "Frankfurt Stock Exchange", region: "Europe" },
    ".SW": { full: "SIX Swiss Exchange (Zurich)", region: "Europe" },
    ".ST": { full: "Nasdaq Stockholm", region: "Europe" },
    ".CO": { full: "Nasdaq Copenhagen", region: "Europe" },
    ".HE": { full: "Nasdaq Helsinki", region: "Europe" },
    ".OL": { full: "Oslo Børs", region: "Europe" },
    ".VI": { full: "Vienna Stock Exchange", region: "Europe" },
    ".WA": { full: "Warsaw Stock Exchange", region: "Europe" },
    ".T": { full: "Tokyo Stock Exchange (TSE)", region: "Asia" },
    ".KS": { full: "Korea Exchange (KRX)", region: "Asia" },
    ".KQ": { full: "Korea Exchange (KOSDAQ)", region: "Asia" },
    ".HK": { full: "Hong Kong Stock Exchange (HKEX)", region: "Asia" },
    ".SS": { full: "Shanghai Stock Exchange (SSE)", region: "Asia" },
    ".SZ": { full: "Shenzhen Stock Exchange (SZSE)", region: "Asia" },
    ".TW": { full: "Taiwan Stock Exchange (TWSE)", region: "Asia" },
    ".TWO": { full: "Taipei Exchange (TPEx)", region: "Asia" },
    ".SI": { full: "Singapore Exchange (SGX)", region: "Asia" },
    ".NS": { full: "National Stock Exchange of India (NSE)", region: "Asia" },
    ".BO": { full: "BSE India (Bombay)", region: "Asia" },
    ".BK": { full: "Stock Exchange of Thailand (SET)", region: "Asia" },
    ".JK": { full: "Indonesia Stock Exchange (IDX)", region: "Asia" },
    ".KL": { full: "Bursa Malaysia", region: "Asia" },
    ".NZ": { full: "New Zealand Exchange (NZX)", region: "Oceania" },
    ".TO": { full: "Toronto Stock Exchange (TSX)", region: "North America" },
    ".V": { full: "TSX Venture Exchange", region: "North America" },
    ".CN": { full: "Canadian Securities Exchange (CSE)", region: "North America" },
    ".NE": { full: "Cboe Canada (NEO)", region: "North America" },
    ".SA": { full: "B3 Brasil Bolsa Balcão (São Paulo)", region: "Latin America" },
    ".MX": { full: "Bolsa Mexicana de Valores (BMV)", region: "Latin America" },
    ".SN": { full: "Bolsa de Santiago (Chile)", region: "Latin America" },
    ".TA": { full: "Tel Aviv Stock Exchange (TASE)", region: "Middle East" },
    ".SR": { full: "Saudi Tadawul", region: "Middle East" },
    ".JO": { full: "Johannesburg Stock Exchange (JSE)", region: "Africa" },
  }

  for (const [sfx, info] of Object.entries(suffixMap)) {
    if (upperSym.endsWith(sfx)) return info
  }

  if (exchangeMap[exch]) return exchangeMap[exch]
  if (exchangeMap[full]) return exchangeMap[full]

  let region = "USA"
  if (tz.startsWith("America/New_York") || tz.startsWith("America/Chicago") || tz.startsWith("America/Los_Angeles") || tz.startsWith("America/Denver")) {
    region = "USA"
  } else if (tz.startsWith("America/Toronto") || tz.startsWith("America/Vancouver") || tz.startsWith("America/Montreal") || tz.startsWith("America/Edmonton") || tz.startsWith("America/Halifax")) {
    region = "North America"
  } else if (tz.startsWith("America/Sao_Paulo") || tz.startsWith("America/Santiago") || tz.startsWith("America/Bogota") || tz.startsWith("America/Buenos_Aires") || tz.startsWith("America/Lima") || tz.startsWith("America/Mexico_City")) {
    region = "Latin America"
  } else if (tz.startsWith("Europe/")) {
    region = "Europe"
  } else if (tz.startsWith("Asia/Tokyo") || tz.startsWith("Asia/Seoul") || tz.startsWith("Asia/Hong_Kong") || tz.startsWith("Asia/Singapore") || tz.startsWith("Asia/Taipei") || tz.startsWith("Asia/Kolkata") || tz.startsWith("Asia/Bangkok") || tz.startsWith("Asia/Jakarta") || tz.startsWith("Asia/Kuala_Lumpur") || tz.startsWith("Asia/Shanghai")) {
    region = "Asia"
  } else if (tz.startsWith("Asia/Tel_Aviv") || tz.startsWith("Asia/Riyadh") || tz.startsWith("Asia/Dubai") || tz.startsWith("Asia/Qatar") || tz.startsWith("Asia/Jerusalem")) {
    region = "Middle East"
  } else if (tz.startsWith("Australia/") || tz.startsWith("Pacific/Auckland")) {
    region = "Oceania"
  } else if (tz.startsWith("Africa/")) {
    region = "Africa"
  }

  const fallbackFull = meta.fullExchangeName || meta.exchangeName || "—"
  return { full: fallbackFull, region }
}

function normalizeHoldingSymbol(symbol: string): string {
  const trimmed = symbol.trim()
  if (trimmed === '005930.KQ' || trimmed === '005930') return '005930.KS'
  if (trimmed === '7203') return '7203.T'
  if (trimmed === 'BP.') return 'BP.L'
  return trimmed
}

async function latestPrice(symbol: string): Promise<number | null> {  try {
    // range=1d keeps this near 1 KB; the full 1mo chart used elsewhere is ~3x larger.
    const data = await cachedJson<any>(`price:${symbol}`, 5 * 60 * 1000, () =>
      fetch(`${yahooBase}/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=1d&interval=1d`, {
        headers: { 'User-Agent': 'Mozilla/5.0' },
      }),
    )
    const price = data.chart?.result?.[0]?.meta?.regularMarketPrice
    return typeof price === 'number' ? price : null
  } catch {
    return null
  }
}

async function listedSymbolUniverse() {
  const [nasdaqText, otherText, companies, usGaapCiks] = await Promise.all([
    freshText('https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt'),
    freshText('https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt'),
    freshJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
      'https://www.sec.gov/files/company_tickers.json',
      secHeaders,
    ),
    usGaapFilerCiks(),
  ])
  // SEC spells share classes with a dash (BRK-A) while the exchange listing files use a dot
  // (BRK.A). Both spellings are indexed so dotted classes still resolve to a CIK.
  const cikBySymbol = new Map<string, number>()
  for (const company of Object.values(companies)) {
    const ticker = company.ticker.toUpperCase()
    cikBySymbol.set(ticker, company.cik_str)
    cikBySymbol.set(ticker.replace(/-/g, '.'), company.cik_str)
  }
  const nasdaq = parsePipeRows(nasdaqText)
    .filter((row) => row['Test Issue'] === 'N' && row.ETF === 'N')
    .map((row) => ({ symbol: row.Symbol, name: row['Security Name'], exchange: 'Nasdaq' }))
  const nyse = parsePipeRows(otherText)
    .filter((row) => row.Exchange === 'N' && row['Test Issue'] === 'N' && row.ETF === 'N')
    .map((row) => ({ symbol: row['ACT Symbol'], name: row['Security Name'], exchange: 'NYSE' }))
  const symbols = [...nasdaq, ...nyse]
    .filter(
      (item) =>
        /^[A-Z][A-Z.-]*$/.test(item.symbol) &&
        cikBySymbol.has(item.symbol) &&
        isCommonEquity(item.name) &&
        // Only keep US GAAP reporters: foreign issuers' share counts are denominated in local
        // shares rather than ADRs, which makes any derived market cap meaningless.
        (usGaapCiks.size === 0 || usGaapCiks.has(cikBySymbol.get(item.symbol) as number)),
    )
    .map((item) => ({ ...item, cik: cikBySymbol.get(item.symbol) as number }))
  return symbols
}

async function mostActiveSymbols() {
  const data = await freshJson<any>(
    `${yahooBase}/v1/finance/screener/predefined/saved?scrIds=most_actives&count=250`,
    { 'User-Agent': 'Mozilla/5.0' },
  )
  return (data.finance?.result?.[0]?.quotes ?? [])
    .filter((quote: any) => quote.quoteType === 'EQUITY')
    .map((quote: any) => ({
      symbol: String(quote.symbol),
      marketCap: typeof quote.marketCap === 'number' ? quote.marketCap : null,
    }))
}

const randomSampleRegions = [
  'USA',
  'North America',
  'Europe',
  'Asia',
  'Oceania',
  'Latin America',
  'Middle East',
  'Africa',
] as const
type RandomSampleRegion = typeof randomSampleRegions[number]

const yahooCountriesByRegion: Record<RandomSampleRegion, string[]> = {
  USA: ['us'],
  'North America': ['ca'],
  Europe: ['gb', 'de', 'fr', 'it', 'es', 'nl', 'ch', 'se', 'no', 'dk', 'fi', 'be', 'pt', 'ie', 'at', 'pl', 'cz', 'gr'],
  Asia: ['jp', 'hk', 'cn', 'kr', 'tw', 'in', 'sg', 'th', 'id', 'my', 'ph', 'vn'],
  Oceania: ['au', 'nz'],
  'Latin America': ['br', 'mx', 'cl', 'co', 'ar', 'pe'],
  'Middle East': ['il', 'sa', 'ae', 'qa'],
  Africa: ['za', 'eg'],
}

async function yahooScreenerSession() {
  return cachedValue('yahoo-screener-session', 30 * 60 * 1000, async () => {
    const consent = await fetch('https://fc.yahoo.com/', {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    const setCookie = consent.headers.get('set-cookie') ?? ''
    const token = setCookie.match(/(?:^|,\s*)A3=([^;]+)/)?.[1]
    if (!token) throw new Error('Yahoo did not provide a screener session cookie.')
    const cookie = `A3=${token}`
    const crumbResponse = await fetch(`${yahooBase}/v1/test/getcrumb`, {
      headers: { Cookie: cookie, 'User-Agent': 'Mozilla/5.0' },
    })
    if (!crumbResponse.ok) throw new Error(`Yahoo screener authentication failed (${crumbResponse.status}).`)
    const crumb = await crumbResponse.text()
    if (!crumb) throw new Error('Yahoo did not provide a screener authentication token.')
    return { cookie, crumb }
  })
}

async function yahooRegionalScreenerPage(
  region: RandomSampleRegion,
  pool: 'all' | 'volume',
  offset: number,
  size: number,
  retry = true,
) {
  const session = await yahooScreenerSession()
  const operands = yahooCountriesByRegion[region].map((country) => ({
    operator: 'eq',
    operands: ['region', country],
  }))
  const query = operands.length === 1 ? operands[0] : { operator: 'OR', operands }
  const response = await fetch(
    `${yahooBase}/v1/finance/screener?crumb=${encodeURIComponent(session.crumb)}`,
    {
      method: 'POST',
      headers: {
        Cookie: session.cookie,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
      },
      body: JSON.stringify({
        size,
        offset,
        sortField: pool === 'volume' ? 'dayvolume' : 'intradaymarketcap',
        sortType: 'DESC',
        quoteType: 'EQUITY',
        query,
      }),
    },
  )
  if ((response.status === 401 || response.status === 403) && retry) {
    cache.delete('yahoo-screener-session')
    return yahooRegionalScreenerPage(region, pool, offset, size, false)
  }
  if (!response.ok) throw new Error(`Yahoo regional screener failed (${response.status}).`)
  const body = await response.json() as any
  if (body.finance?.error) throw new Error(body.finance.error.description ?? 'Yahoo regional screener failed.')
  return body.finance?.result?.[0]?.quotes ?? []
}

async function regionalSymbolUniverse(
  regions: RandomSampleRegion[],
  pool: 'all' | 'volume',
  requestedCount: number,
) {
  const targetPerRegion = Math.max(250, Math.ceil((requestedCount * 2) / regions.length))
  const pagesPerRegion = Math.min(4, Math.ceil(targetPerRegion / 250))
  const pages = await Promise.all(
    regions.flatMap((region) =>
      Array.from({ length: pagesPerRegion }, (_, page) =>
        yahooRegionalScreenerPage(region, pool, page * 250, 250)
          .then((quotes) => ({ region, quotes })),
      ),
    ),
  )
  const seen = new Set<string>()
  const primaryUsExchanges = new Set(['NMS', 'NGM', 'NCM', 'NYQ', 'NYSE', 'PCX', 'ASE', 'BTS', 'BZX'])
  const candidates: Array<{
    symbol: string
    name: string
    exchange: string
    fullExchange: string
    region: string
    marketCap: number | null
  }> = []
  for (const page of pages) {
    for (const quote of page.quotes) {
      if (quote.quoteType !== 'EQUITY' || !quote.symbol) continue
      const symbol = String(quote.symbol).toUpperCase()
      if (seen.has(symbol)) continue
      const exchange = String(quote.exchange ?? quote.exchDisp ?? '—')
      if (page.region === 'USA' && !primaryUsExchanges.has(exchange.toUpperCase())) continue
      const info = getExchangeAndRegion(
        { exchangeName: exchange, fullExchangeName: quote.fullExchangeName ?? quote.exchDisp },
        symbol,
      )
      if (info.region !== page.region) continue
      seen.add(symbol)
      candidates.push({
        symbol,
        name: quote.longName ?? quote.shortName ?? symbol,
        exchange,
        fullExchange: info.full,
        region: info.region,
        marketCap: typeof quote.marketCap === 'number' ? quote.marketCap : null,
      })
    }
  }
  return candidates
}

function shuffle<T>(values: T[]) {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(Math.random() * (index + 1))
    ;[values[index], values[randomIndex]] = [values[randomIndex], values[index]]
  }
  return values
}

// Share counts are known in bulk, but prices are not. Bounding the plausible share price lets
// candidates be discarded before paying for a price lookup: a company cannot reach a $500B cap
// on a few million shares. $2,000 sits far above where virtually every US listing trades, while
// still pruning ~87% of the universe for a large minimum.
const maxPlausibleSharePrice = 2_000
const minPlausibleSharePrice = 0.01

// Exception to the ceiling above: the share classes that genuinely trade in the thousands or
// hundreds of thousands per share (Berkshire Class A at ~$700k) are precisely those with very
// few shares outstanding. Such candidates skip the prune and get a real price lookup, which
// costs little because there are so few of them.
const unprunedShareCount = 10_000_000

/**
 * Whether a filer reports on domestic forms (10-K/10-Q) rather than as a foreign private
 * issuer (20-F/40-F/6-K).
 *
 * Security names cannot be trusted for this — HDFC Bank's ADR is listed as "HDFC Bank Limited
 * Common Stock" — and a few foreign issuers do tag us-gaap facts, so the bulk frame check
 * alone lets them through. Their SEC share count covers local shares while the US quote is
 * priced per ADR, which inflates the derived market cap by the ADR ratio. The submissions
 * document is small (~130 KB) and only fetched for candidates that already matched, so this
 * runs at most a handful of times per screen.
 */
async function isDomesticFiler(cik: number): Promise<boolean> {
  try {
    const data = await cachedJson<any>(`submissions:${cik}`, 24 * 60 * 60 * 1000, () =>
      fetch(`https://data.sec.gov/submissions/CIK${String(cik).padStart(10, '0')}.json`, {
        headers: secHeaders,
      }),
    )
    const forms: string[] = data.filings?.recent?.form ?? []
    if (!forms.length) return true
    return forms.some((form) => form === '10-K' || form === '10-Q')
  } catch {
    // A lookup failure should not silently drop an otherwise valid match.
    return true
  }
}

async function filterByMarketCap<T extends {
  symbol: string
  name: string
  exchange: string
  cik?: number
  marketCap?: number | null
}>(
  candidates: T[],
  count: number,
  minimum: number | null,
  maximum: number | null,
) {
  if (minimum == null && maximum == null) {
    const picked: T[] = []
    for (let index = 0; index < candidates.length && picked.length < count; index += 24) {
      const batch = candidates.slice(index, index + 24)
      const verified = await Promise.all(
        batch.map(async (candidate) =>
          candidate.cik == null || (await isDomesticFiler(candidate.cik)) ? candidate : null,
        ),
      )
      for (const candidate of verified) {
        if (candidate) {
          picked.push(candidate)
          if (picked.length === count) break
        }
      }
    }
    return picked
  }

  const sharesByCik = await sharesOutstandingByCik()

  // Discard candidates whose share count makes the requested range unreachable at any
  // realistic price. For a high minimum this removes the large majority of the universe,
  // turning thousands of price lookups into a few dozen.
  const likely: T[] = []
  const exempt: T[] = []
  for (const candidate of candidates) {
    if (candidate.marketCap != null) {
      likely.push(candidate)
      continue
    }
    const shares = candidate.cik == null ? undefined : sharesByCik.get(candidate.cik)
    if (!shares) continue
    if (shares < unprunedShareCount) {
      exempt.push(candidate)
      continue
    }
    if (minimum != null && shares * maxPlausibleSharePrice < minimum) continue
    if (maximum != null && shares * minPlausibleSharePrice > maximum) continue
    likely.push(candidate)
  }

  // Exempt candidates are searched only after the plausible ones are exhausted: nearly every
  // real match comes from the likely group, so this keeps a high-minimum screen fast while
  // still letting an unusually high-priced, low-float name be found when it genuinely fits.
  const feasible = [...likely, ...exempt]

  const matches: T[] = []
  const batchSize = 48

  for (let index = 0; index < feasible.length && matches.length < count; index += batchSize) {
    const batch = feasible.slice(index, index + batchSize)
    const checked = await Promise.all(batch.map(async (candidate) => {
      if (candidate.marketCap != null) return { candidate, marketCap: candidate.marketCap }
      const shares = sharesByCik.get(candidate.cik as number) as number
      const price = await latestPrice(candidate.symbol)
      return { candidate, marketCap: price == null ? null : price * shares }
    }))

    const inRange = checked.filter(
      ({ marketCap }) =>
        marketCap != null &&
        (minimum == null || marketCap >= minimum) &&
        (maximum == null || marketCap <= maximum),
    )
    const verified = await Promise.all(
      inRange.map(async ({ candidate }) =>
        candidate.cik == null || (await isDomesticFiler(candidate.cik)) ? candidate : null,
      ),
    )

    for (const candidate of verified) {
      if (candidate) {
        matches.push(candidate)
        if (matches.length === count) break
      }
    }
  }
  return matches
}

async function cikForTicker(symbol: string) {
  const companies = await tickerMap()
  // Listing files write share classes as BRK.A, SEC as BRK-A; compare on a common spelling.
  const wanted = symbol.toUpperCase().replace(/\./g, '-')
  const company = Object.values(companies).find(
    (item) => item.ticker.toUpperCase().replace(/\./g, '-') === wanted,
  )
  return company ? String(company.cik_str).padStart(10, '0') : null
}

async function companyFacts(symbol: string) {
  const cik = await cikForTicker(symbol)
  if (!cik) return null
  const facts = await cachedJson<CompanyFacts>(`facts:${cik}`, 6 * 60 * 60 * 1000, () =>
    fetch(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, { headers: secHeaders }),
  )
  return { ...facts, cik: Number(cik) }
}

async function quoteChart(symbol: string, range: string, interval = '1d') {
  const safeRange = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'].includes(range) ? range : '1y'
  const url = `${yahooBase}/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=${safeRange}&interval=${interval}&events=div%2Csplits`
  return cachedJson<any>(`chart:${symbol}:${safeRange}:${interval}`, 5 * 60 * 1000, () =>
    fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }),
  )
}

/**
 * Sustainable growth, dividend yield, and their sum (the implied total return).
 *
 * Growth is the classic sustainable-growth identity: a company can compound equity at ROE
 * only on the share of earnings it keeps, so g = ROE x retention. Adding the dividend yield
 * gives the return an owner implicitly expects at an unchanged valuation multiple.
 *
 * Trailing four quarters are used for both earnings and dividends: a single quarter would
 * make the ratio swing on seasonality and on the uneven timing of dividend declarations.
 */
function impliedReturnMetrics(
  quarters: Quarter[],
  bookValuePerShare: number | null,
  price: number,
  hasDividendFacts: boolean,
) {
  const notes: Record<string, string> = {}
  const epsQuarters = quarters.filter((quarter) => quarter.eps != null).slice(-4)
  const ttmEps = epsQuarters.reduce((sum, quarter) => sum + (quarter.eps as number), 0)

  // A filer that never tags a dividend fact pays no dividend, which is a zero yield rather
  // than an unknown one. Filers that do tag dividends fall back to their reported quarters.
  const ttmDividends = hasDividendFacts
    ? quarters.slice(-4).reduce((sum, quarter) => sum + (quarter.dividendsPerShare ?? 0), 0)
    : 0

  const dividendYield = price > 0 ? ttmDividends / price : null
  if (dividendYield == null) notes.dividendYield = 'No positive market price is available, which the yield divides by.'

  let roe: number | null = null
  let sustainableGrowth: number | null = null
  if (epsQuarters.length < 4) {
    notes.sustainableGrowth = `Needs four quarters of EPS for a trailing figure; SEC filings provide ${epsQuarters.length}.`
  } else if (bookValuePerShare == null) {
    notes.sustainableGrowth = 'Book value per share is unavailable (needs both StockholdersEquity and shares outstanding), which ROE divides by.'
  } else if (bookValuePerShare <= 0) {
    notes.sustainableGrowth = 'Reported book value per share is zero or negative, so return on equity is not meaningful.'
  } else if (ttmEps <= 0) {
    notes.sustainableGrowth = `Trailing four-quarter EPS is ${ttmEps.toFixed(2)}; retained earnings cannot compound equity when earnings are not positive.`
  } else {
    roe = ttmEps / bookValuePerShare
    // Retention can go negative when a company pays out more than it earns; that genuinely
    // implies shrinking equity, so the value is kept rather than clamped to zero.
    const retention = 1 - ttmDividends / ttmEps
    sustainableGrowth = roe * retention
  }

  const impliedReturn =
    sustainableGrowth != null && dividendYield != null ? sustainableGrowth + dividendYield : null
  if (impliedReturn == null) {
    notes.impliedReturn =
      notes.sustainableGrowth ?? notes.dividendYield ?? 'One of its two components is unavailable.'
  }

  // Reported as percentages to match the other growth metrics, which the UI formats with a % sign.
  const asPercent = (value: number | null) => (value == null ? null : value * 100)
  return {
    roe: asPercent(roe),
    sustainableGrowth: asPercent(sustainableGrowth),
    dividendYield: asPercent(dividendYield),
    impliedReturn: asPercent(impliedReturn),
    notes,
  }
}

/**
 * Yahoo's quoteSummary endpoint requires a session cookie plus a matching "crumb" token.
 * Both are cached together because a crumb is only valid for the cookie it was issued with.
 */
let crumbSession: { cookie: string; crumb: string; expires: number } | null = null

async function yahooSession() {
  if (crumbSession && crumbSession.expires > Date.now()) return crumbSession

  const agent = { 'User-Agent': 'Mozilla/5.0' }
  const seed = await fetch('https://fc.yahoo.com', { headers: agent })
  const cookie = (seed.headers.getSetCookie?.() ?? [])
    .map((entry) => entry.split(';')[0])
    .join('; ')
  if (!cookie) throw new Error('Yahoo did not issue a session cookie')

  const response = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
    headers: { ...agent, Cookie: cookie },
  })
  const crumb = (await response.text()).trim()
  if (!crumb || crumb.includes('<')) throw new Error('Yahoo did not issue a crumb token')

  crumbSession = { cookie, crumb, expires: Date.now() + 60 * 60 * 1000 }
  return crumbSession
}

type FundMetrics = {
  category: string | null
  family: string | null
  netAssets: number | null
  expenseRatio: number | null
  stockPosition: number | null
  bondPosition: number | null
  cashPosition: number | null
  otherPosition: number | null
  creditQuality: string | null
  weightedMarketCap: number | null
  pe: number | null
  priceToBook: number | null
  earningsGrowth: number | null
  ewEpsGrowth: number | null
  ewRevenueGrowth: number | null
  incrementalRoic: number | null
  dividendYield: number | null
  returnOnEquity: number | null
  payoutRatio: number | null
  sustainableGrowth: number | null
  impliedReturn: number | null
  holdingCoverage: number | null
  weightedFinancials: {
    coverage: number | null
    revenue: number | null
    netIncome: number | null
    eps: number | null
    dividendsPerShare: number | null
    payoutRatio: number | null
    assets: number | null
    liabilities: number | null
    equity: number | null
    cash: number | null
    longTermDebt: number | null
    shortTermDebt: number | null
    totalDebt: number | null
    netDebt: number | null
    notes: Record<string, string>
  }
  notes: Record<string, string>
}

/**
 * Valuation metrics for a fund, derived from its look-through holdings.
 *
 * A fund has no financial statements of its own, so the equivalents of the company metrics
 * come from the weighted holdings Yahoo publishes. Yahoo's direct fund P/E field is
 * prospective, so trailing P/E is calculated from the listed holdings' own trailing P/E
 * values as a weighted earnings yield and then inverted.
 *
 * From P/E, P/B and the distribution yield the rest follows by identity:
 *   ROE    = (E/P) / (B/P) = P/B ÷ P/E
 *   payout = (D/P) / (E/P) = yield x P/E
 *   g      = ROE x (1 - payout)
 *   r      = g + yield - expenses
 * This mirrors the company-level sustainable-growth calculation, so the two tables stay
 * directly comparable. Fees are subtracted because, unlike a company, a fund's stated return
 * is only ever received net of them.
 */
async function fundMetrics(symbol: string): Promise<FundMetrics> {
  const notes: Record<string, string> = {}
  const empty = (reason: string): FundMetrics => ({
    category: null, family: null, netAssets: null, expenseRatio: null,
    stockPosition: null, bondPosition: null, cashPosition: null, otherPosition: null, creditQuality: null,
    weightedMarketCap: null, pe: null, priceToBook: null,
    earningsGrowth: null, ewEpsGrowth: null, ewRevenueGrowth: null, incrementalRoic: null,
    dividendYield: null, returnOnEquity: null, payoutRatio: null,
    sustainableGrowth: null, impliedReturn: null, holdingCoverage: null,
    weightedFinancials: {
      coverage: null, revenue: null, netIncome: null, eps: null, dividendsPerShare: null,
      payoutRatio: null, assets: null, liabilities: null, equity: null, cash: null,
      longTermDebt: null, shortTermDebt: null, totalDebt: null, netDebt: null,
      notes: { all: reason },
    },
    notes: {
      marketCap: reason, pe: reason, priceToBook: reason, earningsGrowth: reason,
      ewEpsGrowth: reason, ewRevenueGrowth: reason, incrementalRoic: reason,
      dividendYield: reason, returnOnEquity: reason,
      sustainableGrowth: reason, impliedReturn: reason, expenseRatio: reason,
    },
  })

  let summary: any
  let session: Awaited<ReturnType<typeof yahooSession>>
  try {
    session = await yahooSession()
    summary = await cachedJson<any>(`fund:${symbol}`, 6 * 60 * 60 * 1000, () =>
      fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol(symbol))}` +
        `?modules=topHoldings,summaryDetail,fundProfile&crumb=${encodeURIComponent(session.crumb)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: session.cookie } },
      ),
    )
  } catch {
    return empty('Yahoo did not return holdings data for this fund, so look-through valuation metrics are unavailable.')
  }

  const result = summary?.quoteSummary?.result?.[0]
  if (!result) return empty('Yahoo published no holdings breakdown for this fund.')

  const raw = (node: any): number | null => {
    const value = node?.raw
    return typeof value === 'number' && Number.isFinite(value) ? value : null
  }
  const holdings = result.topHoldings ?? {}
  const equity = holdings.equityHoldings ?? {}
  const detail = result.summaryDetail ?? {}
  const profile = result.fundProfile ?? {}

  // Yahoo reports these holdings ratios as yields; a zero means "not applicable",
  // which is the normal case for a bond fund holding no equities.
  const invert = (value: number | null) => (value != null && value > 0 ? 1 / value : null)
  const priceToBook = invert(raw(equity.priceToBook))
  const dividendYield = raw(detail.yield)
  const expenseRatio = raw(profile.feesExpensesInvestment?.annualReportExpenseRatio)
  const stockPosition = raw(holdings.stockPosition)
  const bondPosition = raw(holdings.bondPosition)
  const cashPosition = raw(holdings.cashPosition)
  const otherPosition = raw(holdings.otherPosition)

  // Yahoo reports the bond-rating breakdown as an array of single-key objects, one per
  // rating band, each holding that band's share of the portfolio (0-1). Reducing to the
  // single largest band gives a quick, comparable "average credit quality" label without
  // guessing at a numeric duration/maturity figure Yahoo does not reliably publish here.
  let creditQuality: string | null = null
  const ratingRows = Array.isArray(holdings.bondRatings) ? holdings.bondRatings : []
  const ratingLabels: Record<string, string> = {
    us_government: 'U.S. Government', aaa: 'AAA', aa: 'AA', a: 'A', bbb: 'BBB',
    bb: 'BB', b: 'B', below_b: 'Below B', other: 'Not rated',
  }
  let topBand: { label: string; weight: number } | null = null
  for (const entry of ratingRows) {
    for (const [key, value] of Object.entries(entry ?? {})) {
      const weight = raw(value as any)
      if (weight == null) continue
      if (!topBand || weight > topBand.weight) {
        topBand = { label: ratingLabels[key] ?? key, weight }
      }
    }
  }
  if (topBand && topBand.weight > 0) {
    creditQuality = `${topBand.label} (${Math.round(topBand.weight * 100)}%)`
  }
  let pe: number | null = null

  const holdingRows = Array.isArray(holdings.holdings) ? holdings.holdings : []
  const holdingWeights: Array<{ symbol: string; weight: number | null }> = holdingRows
    .map((holding: any) => ({
      symbol: normalizeHoldingSymbol(typeof holding.symbol === 'string' ? holding.symbol : ''),
      weight: raw(holding.holdingPercent),
    }))
    .filter((holding: { symbol: string; weight: number | null }) => holding.symbol && holding.weight != null && holding.weight > 0)
  const percent = (value: number | null) => (value == null ? null : value * 100)
  if (holdingWeights.length) {
    try {
      const symbols = holdingWeights.map((holding) => yahooSymbol(holding.symbol))
      const quotes = await cachedJson<any>(
        `holding-trailing-pe:${symbols.join(',')}`,
        60 * 60 * 1000,
        () => fetch(
          `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.map(encodeURIComponent).join(',')}` +
          `&fields=trailingPE&crumb=${encodeURIComponent(session.crumb)}`,
          { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: session.cookie } },
        ),
      )
      const peBySymbol = new Map<string, number>()
      for (const quote of quotes?.quoteResponse?.result ?? []) {
        const value = quote?.trailingPE
        if (quote?.symbol && typeof value === 'number' && Number.isFinite(value) && value > 0) {
          peBySymbol.set(String(quote.symbol).toUpperCase(), value)
        }
      }
      let coveredWeight = 0
      let earningsYield = 0
      for (const holding of holdingWeights) {
        const holdingPe = peBySymbol.get(yahooSymbol(holding.symbol).toUpperCase())
        if (!holdingPe || holding.weight == null) continue
        coveredWeight += holding.weight
        earningsYield += holding.weight / holdingPe
      }
      pe = earningsYield > 0 ? coveredWeight / earningsYield : null
      if (pe == null) {
        notes.pe = 'Yahoo publishes only prospective fund P/E directly. Trailing P/E could not be calculated because none of the listed holdings had positive trailing P/E values.'
      }
    } catch {
      notes.pe = 'Yahoo publishes only prospective fund P/E directly. Trailing P/E could not be calculated from the listed holdings.'
    }
  } else {
    notes.pe = 'Yahoo publishes only prospective fund P/E directly and did not publish holdings weights needed to calculate trailing P/E.'
  }

  const weightedMarketCap = null
  const earningsGrowth = null
  const ewEpsGrowth = null
  const ewRevenueGrowth = null
  const incrementalRoic = null
  const holdingCoverage = null
  notes.marketCap = 'Constituent-weighted company fundamentals were rolled back because they made loading unreliable.'
  notes.earningsGrowth = notes.marketCap
  notes.ewEpsGrowth = notes.marketCap
  notes.ewRevenueGrowth = notes.marketCap
  notes.incrementalRoic = notes.marketCap
  const weightedFinancials: FundMetrics['weightedFinancials'] = {
    coverage: null,
    revenue: null,
    netIncome: null,
    eps: null,
    dividendsPerShare: null,
    payoutRatio: null,
    assets: null,
    liabilities: null,
    equity: null,
    cash: null,
    longTermDebt: null,
    shortTermDebt: null,
    totalDebt: null,
    netDebt: null,
    notes: { all: notes.marketCap },
  }

  const mostlyBonds = stockPosition != null && stockPosition < 0.5
  const noEquityNote = mostlyBonds
    ? 'This fund holds little or no equity, so look-through earnings and book value do not apply. Its return comes from interest, which the distribution yield captures.'
    : 'Yahoo published no look-through earnings or book value for this fund.'

  if (pe == null && !notes.pe) notes.pe = noEquityNote
  if (priceToBook == null) notes.priceToBook = noEquityNote
  if (dividendYield == null) notes.dividendYield = 'Yahoo published no distribution yield for this fund.'
  if (expenseRatio == null) notes.expenseRatio = 'Yahoo published no expense ratio for this fund.'

  const returnOnEquity = pe != null && priceToBook != null ? priceToBook / pe : null
  if (returnOnEquity == null) notes.returnOnEquity = noEquityNote

  const payoutRatio = pe != null && dividendYield != null ? dividendYield * pe : null
  if (payoutRatio == null) notes.payoutRatio = notes.pe ?? notes.dividendYield ?? noEquityNote
  let sustainableGrowth: number | null = null
  if (returnOnEquity == null || payoutRatio == null) {
    notes.sustainableGrowth = noEquityNote
  } else {
    sustainableGrowth = returnOnEquity * (1 - payoutRatio)
  }

  let impliedReturn: number | null = null
  if (sustainableGrowth != null && dividendYield != null) {
    impliedReturn = sustainableGrowth + dividendYield - (expenseRatio ?? 0)
  } else if (mostlyBonds && dividendYield != null) {
    // A bond fund has no retained-earnings growth; its expected return is simply the yield
    // it distributes, net of fees.
    impliedReturn = dividendYield - (expenseRatio ?? 0)
  } else {
    notes.impliedReturn = notes.sustainableGrowth ?? notes.dividendYield ?? noEquityNote
  }

  return {
    category: profile.categoryName ?? null,
    family: profile.family ?? null,
    netAssets: raw(detail.totalAssets),
    expenseRatio: percent(expenseRatio),
    stockPosition: percent(stockPosition),
    bondPosition: percent(bondPosition),
    cashPosition: percent(cashPosition),
    otherPosition: percent(otherPosition),
    creditQuality,
    weightedMarketCap,
    pe,
    priceToBook,
    earningsGrowth,
    ewEpsGrowth,
    ewRevenueGrowth,
    incrementalRoic,
    dividendYield: percent(dividendYield),
    returnOnEquity: percent(returnOnEquity),
    payoutRatio: percent(payoutRatio),
    sustainableGrowth: percent(sustainableGrowth),
    impliedReturn: percent(impliedReturn),
    holdingCoverage: percent(holdingCoverage),
    weightedFinancials,
    notes,
  }
}

async function yahooQuoteSummary(symbol: string) {
  try {
    const session = await yahooSession()
    const modules =
      'financialData,defaultKeyStatistics,summaryDetail,summaryProfile,incomeStatementHistoryQuarterly,balanceSheetHistoryQuarterly,cashflowStatementHistoryQuarterly'
    return await cachedJson<any>(`quote-summary:${symbol}`, 60 * 60 * 1000, () =>
      fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol(symbol))}` +
          `?modules=${modules}&crumb=${encodeURIComponent(session.crumb)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: session.cookie } },
      ),
    )
  } catch {
    return null
  }
}

async function fallbackYahooFundamentals(symbol: string, meta: any, price: number) {
  const currency = meta.currency ?? 'USD'
  const currencyRateToUsd = await getUsdRate(currency)
  const { full: fullExchange, region } = getExchangeAndRegion(meta, symbol)
  const rawPrice = price
  const usdPrice = rawPrice * currencyRateToUsd

  const summary = await yahooQuoteSummary(symbol)
  const result = summary?.quoteSummary?.result?.[0]
  if (!result) {
    const unmatched = 'No SEC EDGAR filer matches this ticker, and Yahoo quote summary was unavailable.'
    return {
      symbol,
      name: meta.longName ?? meta.shortName ?? symbol,
      exchange: meta.exchangeName ?? '—',
      fullExchange,
      region,
      price: usdPrice,
      rawPrice,
      currency,
      currencyRateToUsd,
      marketTime: meta.regularMarketTime,
      marketCap: null,
      rawMarketCap: null,
      pe: null,
      earningsGrowth: null,
      priceToBook: null,
      netTangibleAssetsPerShare: null,
      priceToNetTangibleAssets: null,
      ewEpsGrowth: null,
      ewRevenueGrowth: null,
      incrementalRoic: null,
      returnOnEquity: null,
      sustainableGrowth: null,
      dividendYield: null,
      impliedReturn: null,
      metricNotes: {
        marketCap: unmatched,
        pe: unmatched,
        earningsGrowth: unmatched,
        priceToBook: unmatched,
        netTangibleAssetsPerShare: unmatched,
        priceToNetTangibleAssets: unmatched,
        ewEpsGrowth: unmatched,
        ewRevenueGrowth: unmatched,
        incrementalRoic: unmatched,
        sustainableGrowth: unmatched,
        dividendYield: unmatched,
        impliedReturn: unmatched,
        lastReport: unmatched,
      },
      quarters: [] as Quarter[],
      sourceLinks: sourceLinks(yahooSymbol(symbol)),
      sourceNote: 'Price from Yahoo Finance. No fundamental data found.',
      isFund: false as const,
    }
  }

  const sd = result.summaryDetail ?? {}
  const ks = result.defaultKeyStatistics ?? {}
  const fd = result.financialData ?? {}
  const raw = (n: any): number | null => (typeof n?.raw === 'number' && Number.isFinite(n.raw) ? n.raw : null)
  const asPercent = (n: number | null) => (n == null ? null : +(n * 100).toFixed(2))

  const peRaw = raw(sd.trailingPE) ?? raw(ks.trailingPE) ?? (raw(ks.trailingEps) && raw(ks.trailingEps)! > 0 ? price / raw(ks.trailingEps)! : null)
  const pe = peRaw != null ? +peRaw.toFixed(2) : null
  const priceToBookRaw = raw(ks.priceToBook)
  const priceToBook = priceToBookRaw != null && priceToBookRaw > 0 ? +priceToBookRaw.toFixed(2) : null
  const returnOnEquity = asPercent(raw(fd.returnOnEquity)) ?? (pe != null && priceToBook != null ? +((priceToBook / pe) * 100).toFixed(2) : null)
  const dividendYield = asPercent(raw(sd.dividendYield) ?? raw(sd.trailingAnnualDividendYield) ?? (raw(sd.dividendRate) && price > 0 ? raw(sd.dividendRate)! / price : null))
  const payoutRatio = asPercent(raw(sd.payoutRatio)) ?? (pe != null && dividendYield != null ? +(dividendYield * pe / 100).toFixed(2) : null)
  const earningsGrowth = asPercent(raw(fd.earningsGrowth) ?? raw(ks.earningsQuarterlyGrowth))
  const revenueGrowth = asPercent(raw(fd.revenueGrowth))
  const rawMarketCap = raw(sd.marketCap) ?? (price && raw(ks.sharesOutstanding) ? price * raw(ks.sharesOutstanding)! : null)
  const usdMarketCap = rawMarketCap != null ? rawMarketCap * currencyRateToUsd : null

  const sustainableGrowth = returnOnEquity != null && payoutRatio != null
    ? +(returnOnEquity * (1 - payoutRatio / 100)).toFixed(2)
    : (returnOnEquity != null && dividendYield != null && pe != null ? +(returnOnEquity * (1 - (dividendYield * pe / 100))).toFixed(2) : null)
  const impliedReturn = sustainableGrowth != null && dividendYield != null ? +(sustainableGrowth + dividendYield).toFixed(2) : null

  const incList = (result.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? []).slice().reverse()
  const bsList = (result.balanceSheetHistoryQuarterly?.balanceSheetStatements ?? []).slice().reverse()
  const cfList = (result.cashflowStatementHistoryQuarterly?.cashflowStatements ?? []).slice().reverse()
  const dates = [...new Set([...incList.map((x: any) => x.endDate?.fmt), ...bsList.map((x: any) => x.endDate?.fmt), ...cfList.map((x: any) => x.endDate?.fmt)])].filter(Boolean).sort()
  const sharesOut = raw(ks.sharesOutstanding)
  const tangible = yahooTangibleInputs(bsList.find((bs: any) => bs.endDate?.fmt === dates.at(-1)), raw)
  const rawNetTangibleAssetsPerShare = dates.length
    ? netTangibleAssetsPerShare(tangible.assets, tangible.intangibleAssets, tangible.liabilities, tangible.preferredStock, sharesOut)
    : null
  const tangiblePerShareUsd = rawNetTangibleAssetsPerShare == null ? null : rawNetTangibleAssetsPerShare * currencyRateToUsd
  const tangibleRatio = priceToNetTangibleAssets(usdPrice, tangiblePerShareUsd)

  const quarters: Quarter[] = dates.map((end) => {
    const inc = incList.find((x: any) => x.endDate?.fmt === end)
    const bs = bsList.find((x: any) => x.endDate?.fmt === end)
    const cf = cfList.find((x: any) => x.endDate?.fmt === end)

    const netIncome = raw(inc?.netIncome)
    const eps = sharesOut && netIncome != null ? netIncome / sharesOut : null
    const equity = raw(bs?.totalStockholderEquity)
    const bookValuePerShare = sharesOut && equity != null ? equity / sharesOut : null
    const longTermDebt = raw(bs?.longTermDebt)
    const shortTermDebt = raw(bs?.shortLongTermDebt)
    const totalDebt = (longTermDebt ?? 0) + (shortTermDebt ?? 0)
    const cash = raw(bs?.cash)
    const investedCapital = equity != null ? equity + totalDebt - (cash ?? 0) : null

    return {
      end,
      filed: end,
      eps,
      revenue: raw(inc?.totalRevenue),
      operatingIncome: raw(inc?.operatingIncome) ?? raw(inc?.ebit),
      preTaxIncome: raw(inc?.incomeBeforeTax),
      incomeTaxExpense: raw(inc?.incomeTaxExpense),
      dividendsPerShare: sharesOut && raw(cf?.dividendsPaid) ? Math.abs(raw(cf?.dividendsPaid)!) / sharesOut : null,
      bookValuePerShare,
      investedCapital,
    }
  })

  const metricNotes: Record<string, string> = {}
  if (usdMarketCap == null) {
    metricNotes.marketCap = 'Yahoo Finance reported no market capitalization.'
  } else if (currency !== 'USD') {
    const rateDisp = currencyRateToUsd >= 1 ? currencyRateToUsd.toFixed(4) : currencyRateToUsd.toPrecision(4)
    metricNotes.marketCap = `Converted to USD from ${currency} (1 ${currency} = $${rateDisp} USD). Original market cap: ${rawMarketCap != null ? rawMarketCap.toLocaleString() : '—'} ${currency}.`
  }
  if (pe == null) metricNotes.pe = 'Yahoo Finance reported no trailing P/E.'
  if (priceToBook == null) {
    const book = raw(ks.bookValue) ?? raw(bsList.at(-1)?.totalStockholderEquity) ?? priceToBookRaw
    metricNotes.priceToBook = book != null && book <= 0
      ? `Reported book value is ${book < 0 ? 'negative' : 'zero'}, so price-to-book is not meaningful.`
      : 'Yahoo Finance reported no price-to-book ratio.'
  }
  if (earningsGrowth == null) metricNotes.earningsGrowth = 'Yahoo Finance reported no quarterly earnings growth.'
  if (revenueGrowth == null) metricNotes.ewRevenueGrowth = 'Yahoo Finance reported no revenue growth.'
  if (returnOnEquity == null) metricNotes.returnOnEquity = 'Yahoo Finance reported no return on equity.'
  if (sustainableGrowth == null) metricNotes.sustainableGrowth = 'Sustainable growth requires both ROE and payout ratio.'
  if (dividendYield == null) metricNotes.dividendYield = 'Yahoo Finance reported no dividend yield.'
  if (impliedReturn == null) metricNotes.impliedReturn = 'Implied return requires sustainable growth and dividend yield.'
  if (tangiblePerShareUsd == null) {
    metricNotes.netTangibleAssetsPerShare = dates.length ? 'Needs positive common shares outstanding; missing balance-sheet amounts are assumed zero.' : 'No financial-statement period was found.'
  } else {
    const note = tangibleAssumptionsNote(tangible.assumptions)
    if (note) metricNotes.netTangibleAssetsPerShare = note
  }
  const tangibleRatioReason = tangibleRatioNote(tangiblePerShareUsd, tangibleRatio, tangible.assumptions, metricNotes.netTangibleAssetsPerShare)
  if (tangibleRatioReason) metricNotes.priceToNetTangibleAssets = tangibleRatioReason
  if (quarters.length === 0) metricNotes.lastReport = 'No quarterly income statements were found on Yahoo Finance.'

  return {
    symbol,
    name: meta.longName ?? meta.shortName ?? symbol,
    exchange: meta.exchangeName ?? '—',
    fullExchange,
    region,
    price: usdPrice,
    rawPrice,
    currency,
    currencyRateToUsd,
    marketTime: meta.regularMarketTime,
    marketCap: usdMarketCap,
    rawMarketCap,
    pe,
    earningsGrowth,
    priceToBook,
    netTangibleAssetsPerShare: tangiblePerShareUsd,
    priceToNetTangibleAssets: tangibleRatio,
    ewEpsGrowth: earningsGrowth,
    ewRevenueGrowth: revenueGrowth,
    incrementalRoic: null,
    returnOnEquity,
    sustainableGrowth,
    dividendYield,
    impliedReturn,
    metricNotes,
    quarters,
    sourceLinks: sourceLinks(yahooSymbol(symbol)),
    sourceNote: 'Price and fundamentals from Yahoo Finance.',
    isFund: false as const,
  }
}

async function fundamentals(symbol: string) {
  const [chart, facts] = await Promise.all([quoteChart(symbol, '1mo'), companyFacts(symbol)])
  const result = chart.chart?.result?.[0]
  if (!result) throw new Error(`No market data found for ${symbol}`)
  const meta = result.meta
  const price = meta.regularMarketPrice as number
  const currency = meta.currency ?? 'USD'
  const currencyRateToUsd = await getUsdRate(currency)
  const { full: fullExchange, region } = getExchangeAndRegion(meta, symbol)
  const rawPrice = price
  const usdPrice = rawPrice * currencyRateToUsd

  // Funds are valued from look-through holdings rather than filings, so they take a
  // different shape entirely and are presented in their own table.
  if (meta.instrumentType === 'ETF' || meta.instrumentType === 'MUTUALFUND') {
    const fund = await fundMetrics(symbol)
    const rawNetAssets = fund.netAssets
    const usdNetAssets = rawNetAssets != null ? rawNetAssets * currencyRateToUsd : null
    const rawMarketCap = fund.weightedMarketCap
    const usdMarketCap = rawMarketCap != null ? rawMarketCap * currencyRateToUsd : null

    if (currency !== 'USD' && usdMarketCap != null) {
      const rateDisp = currencyRateToUsd >= 1 ? currencyRateToUsd.toFixed(4) : currencyRateToUsd.toPrecision(4)
      fund.notes.marketCap = `Converted to USD from ${currency} (1 ${currency} = $${rateDisp} USD).`
    }

    return {
      symbol,
      name: meta.longName ?? meta.shortName ?? symbol,
      exchange: meta.exchangeName ?? '—',
      fullExchange,
      region,
      price: usdPrice,
      rawPrice,
      currency,
      currencyRateToUsd,
      marketTime: meta.regularMarketTime,
      isFund: true,
      fundCategory: fund.category,
      fundFamily: fund.family,
      netAssets: usdNetAssets,
      rawNetAssets,
      expenseRatio: fund.expenseRatio,
      stockPosition: fund.stockPosition,
      bondPosition: fund.bondPosition,
      cashPosition: fund.cashPosition,
      otherPosition: fund.otherPosition,
      creditQuality: fund.creditQuality,
      holdingCoverage: fund.holdingCoverage,
      fundWeightedFinancials: fund.weightedFinancials,
      marketCap: usdMarketCap,
      rawMarketCap,
      pe: fund.pe,
      priceToBook: fund.priceToBook,
      netTangibleAssetsPerShare: null,
      priceToNetTangibleAssets: null,
      earningsGrowth: fund.earningsGrowth,
      ewEpsGrowth: fund.ewEpsGrowth,
      ewRevenueGrowth: fund.ewRevenueGrowth,
      incrementalRoic: fund.incrementalRoic,
      returnOnEquity: fund.returnOnEquity,
      payoutRatio: fund.payoutRatio,
      sustainableGrowth: fund.sustainableGrowth,
      dividendYield: fund.dividendYield,
      impliedReturn: fund.impliedReturn,
      metricNotes: fund.notes,
      quarters: [],
      sourceLinks: sourceLinks(yahooSymbol(symbol)),
      sourceNote: 'Price from Yahoo Finance. Fund valuation derived from published look-through holdings; a fund files no company financial statements.',
    }
  }

  if (!facts) {
    return fallbackYahooFundamentals(symbol, meta, price)
  }

  let eps = quarterlyValues(
    firstFact(facts, ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic']),
    'USD/shares',
  )
  const revenue = quarterlyValues(
    firstFact(facts, revenueFactNames),
    'USD',
  )
  const latestFinancialEnd = [
    revenue.at(-1)?.end,
    instantValues(firstFact(facts, ['Assets']), 'USD').at(-1)?.end,
  ].filter((end): end is string => !!end).sort().at(-1)
  let epsFromFilings = false
  if (!eps.length || (latestFinancialEnd && (eps.at(-1)?.end ?? '') < latestFinancialEnd)) {
    const filingEps = await filingClassEps(symbol, facts.cik)
    if (filingEps.length && (filingEps.at(-1)?.end ?? '') > (eps.at(-1)?.end ?? '')) {
      eps = filingEps
      epsFromFilings = true
    }
  }
  const equity = instantValues(
    firstFact(facts, ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']),
    'USD',
  )
  let shares = instantValues(
    // Many large filers (Coca-Cola among them) never tag us-gaap CommonStockSharesOutstanding
    // and only report the cover-page dei value, so both namespaces are searched.
    firstFact(
      facts,
      ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding', 'CommonStockSharesIssued'],
      ['us-gaap', 'dei'],
    ),
    'shares',
  )
  let sharesFromFilings = false
  if (!shares.length) {
    shares = await filingClassShares(facts.cik)
    sharesFromFilings = shares.length > 0
  }
  const dividendsPerShareDirect = quarterlyValues(
    firstFact(facts, ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid']),
    'USD/shares',
  )
  const dividendsPaidAggregate = quarterlyValues(
    firstFact(facts, ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends']),
    'USD',
  )
  const operatingIncome = quarterlyValues(
    firstFact(facts, ['OperatingIncomeLoss']),
    'USD',
  )
  const preTaxIncome = quarterlyValues(
    firstFact(facts, [
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest',
      'IncomeLossFromContinuingOperationsBeforeIncomeTaxes',
    ]),
    'USD',
  )
  const incomeTaxExpense = quarterlyValues(
    firstFact(facts, ['IncomeTaxExpenseBenefit']),
    'USD',
  )
  const cash = instantValues(
    firstFact(facts, ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents']),
    'USD',
  )
  const longTermDebt = instantValues(
    firstFact(facts, ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations', 'LongTermDebt']),
    'USD',
  )
  const shortTermDebt = instantValues(
    firstFact(facts, ['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent', 'ShortTermBorrowings', 'OtherShortTermBorrowings', 'DebtCurrent']),
    'USD',
  )
  // Some filers only report aggregate cash dividends paid rather than a per-share figure; in
  // that case, derive per-share dividends using shares outstanding at the same period end.
  const dividendsPerShare = dividendsPerShareDirect.length
    ? dividendsPerShareDirect
    : dividendsPaidAggregate
        .map((row) => {
          const sharesAtEnd = valueAtEnd(shares, row.end)
          return sharesAtEnd ? { ...row, val: row.val / sharesAtEnd } : null
        })
        .filter((row): row is FactUnit => row != null)
  const quarters = joinQuarters(
    eps,
    revenue,
    dividendsPerShare,
    equity,
    shares,
    operatingIncome,
    preTaxIncome,
    incomeTaxExpense,
    cash,
    longTermDebt,
    shortTermDebt,
    sharesFromFilings,
  )
  const epsValues = quarters.map((quarter) => quarter.eps)
  const revenueValues = quarters.map((quarter) => quarter.revenue)
  const recentEps = epsValues.filter((value): value is number => value != null)
  const revenueCount = revenueValues.filter((value) => value != null).length
  const ttmEps = recentEps.slice(-4).reduce((sum, value) => sum + value, 0)
  const latestEquity = equity.at(-1)?.val
  const latestShares = shares.at(-1)?.val
  const tangibleIds = new Set(['assets', 'liabilities', 'totalEquity', 'intangibleAssets', 'goodwill', 'otherIntangibleAssets', 'preferredStock', 'preferredShares'])
  const tangibleSeries = new Map(sourceFactSpecs.filter((spec) => tangibleIds.has(spec.id))
    .map((spec) => [spec.id, instantValues(firstFact(facts, spec.names, spec.namespaces), spec.unit)]))
  const tangibleForEnd = (end: string) => {
    const row = (id: string) => (tangibleSeries.get(id) ?? []).find((fact) => fact.end === end)
    const inputs = tangibleInputs((id) => row(id)?.val ?? null)
    const shareRow = factAsOf(shares, end)
    const value = netTangibleAssetsPerShare(inputs.assets, inputs.intangibleAssets, inputs.liabilities, inputs.preferredStock, shareRow?.val ?? null)
    const periodFact = eps.find((fact) => fact.end === end) ?? revenue.find((fact) => fact.end === end)
    const dependencies = [
      row('assets'),
      row('liabilities') ?? row('totalEquity'),
      ...(row('intangibleAssets') ? [row('intangibleAssets')] : [row('goodwill'), row('otherIntangibleAssets')]),
      row('preferredStock') ?? row('preferredShares'),
      shareRow,
      periodFact,
    ]
    return {
      inputs,
      shares: shareRow?.val ?? null,
      value: value == null ? null : value * currencyRateToUsd,
      filed: dependencies.reduce((latest, fact) => fact && fact.filed > latest ? fact.filed : latest, ''),
    }
  }
  const assetEnds = (tangibleSeries.get('assets') ?? []).map((row) => row.end)
  const tangibleEnds = [...new Set([...assetEnds, ...quarters.map((quarter) => quarter.end).filter((end) =>
    !assetEnds.some((assetEnd) => Math.abs(Date.parse(end) - Date.parse(assetEnd)) <= 45 * 86_400_000),
  )])].sort()
  const tangibleEnd = tangibleEnds.at(-1)
  const latestTangible = tangibleEnd ? tangibleForEnd(tangibleEnd) : null
  const tangible = latestTangible?.inputs ?? tangibleInputs(() => null)
  const tangiblePerShareUsd = latestTangible?.value ?? null
  const tangibleRatio = priceToNetTangibleAssets(usdPrice, tangiblePerShareUsd)
  const tangibleAssetReports = tangibleEnds.flatMap((end) => {
    const result = tangibleForEnd(end)
    return result.value != null && result.filed ? [{ end, date: result.filed, value: result.value, assumptions: result.inputs.assumptions }] : []
  })
  const bookValuePerShare = latestEquity && latestShares ? latestEquity / latestShares : null

  const rawMarketCap = latestShares ? price * latestShares : null
  const usdMarketCap = rawMarketCap != null ? rawMarketCap * currencyRateToUsd : null
  const epsPeriods = quarters.filter((quarter) => quarter.eps != null).slice(-4)
  const completeFilingEps = epsPeriods.length === 4 && epsPeriods.slice(1).every((quarter, index) => {
    const days = (Date.parse(quarter.end) - Date.parse(epsPeriods[index].end)) / 86_400_000
    return days >= 60 && days <= 120
  })
  const pe = ttmEps > 0 && (!epsFromFilings || completeFilingEps) ? price / ttmEps : null
  const earningsGrowth = growth(recentEps.at(-1), recentEps.at(-2))
  const priceToBook = bookValuePerShare && bookValuePerShare > 0 ? price / bookValuePerShare : null
  const ewEpsGrowth = exponentiallyWeightedGrowth(epsValues)
  const ewRevenueGrowth = exponentiallyWeightedGrowth(revenueValues)
  const incremental = incrementalRoic(quarters)
  const implied = impliedReturnMetrics(quarters, bookValuePerShare, price, dividendsPerShare.length > 0)

  // Explains which upstream input is responsible whenever a metric cannot be calculated,
  // so a blank cell can be traced back to the specific missing SEC fact.
  const metricNotes: Record<string, string> = {}
  if (tangiblePerShareUsd == null) {
    metricNotes.netTangibleAssetsPerShare = !tangibleEnd
      ? 'No financial-statement period was found.'
      : 'Needs positive common shares outstanding; missing balance-sheet amounts are assumed zero.'
  } else {
    const note = tangibleAssumptionsNote(tangible.assumptions)
    if (note) metricNotes.netTangibleAssetsPerShare = note
  }
  const tangibleRatioReason = tangibleRatioNote(tangiblePerShareUsd, tangibleRatio, tangible.assumptions, metricNotes.netTangibleAssetsPerShare)
  if (tangibleRatioReason) metricNotes.priceToNetTangibleAssets = tangibleRatioReason
  if (usdMarketCap == null) {
    metricNotes.marketCap = 'SEC filings report no shares-outstanding fact (CommonStockSharesOutstanding), which market cap requires.'
  } else if (currency !== 'USD') {
    const rateDisp = currencyRateToUsd >= 1 ? currencyRateToUsd.toFixed(4) : currencyRateToUsd.toPrecision(4)
    metricNotes.marketCap = `Converted to USD from ${currency} (1 ${currency} = $${rateDisp} USD).`
  }
  if (pe == null) {
    metricNotes.pe = epsFromFilings && !completeFilingEps
      ? 'Needs four consecutive reported quarterly EPS values; the class-specific filing data is incomplete.'
      : recentEps.length === 0
      ? 'SEC filings report no quarterly EPS fact (EarningsPerShareDiluted).'
      : recentEps.length < 4
        ? `Only ${recentEps.length} of the 4 quarters of EPS needed for a trailing figure are reported in SEC filings.`
        : `Trailing four-quarter EPS is ${ttmEps.toFixed(2)}; P/E is undefined when earnings are not positive.`
  }
  if (priceToBook == null) {
    metricNotes.priceToBook = latestEquity == null
      ? 'SEC filings report no StockholdersEquity fact, which book value per share requires.'
      : latestEquity < 0
        ? 'Reported stockholders’ equity (book value) is negative, so price-to-book is not meaningful.'
        : latestEquity === 0
          ? 'Reported stockholders’ equity (book value) is zero, so price-to-book is not meaningful.'
          : latestShares == null
            ? 'SEC filings report no shares-outstanding fact, which book value per share requires.'
            : 'Reported book value per share is zero or negative, so the ratio is not meaningful.'
  }
  if (earningsGrowth == null) {
    metricNotes.earningsGrowth = recentEps.length < 2
      ? `Needs two quarters of EPS; SEC filings provide ${recentEps.length}.`
      : 'The preceding quarter reported zero EPS, so percentage growth is undefined.'
  }
  if (ewEpsGrowth == null) {
    metricNotes.ewEpsGrowth = `Needs at least two quarters of EPS; SEC filings provide ${recentEps.length}.`
  }
  if (ewRevenueGrowth == null) {
    metricNotes.ewRevenueGrowth = `Needs at least two quarters of revenue; SEC filings provide ${revenueCount}.`
  }
  if (incremental.note) metricNotes.incrementalRoic = incremental.note
  Object.assign(metricNotes, implied.notes)
  if (quarters.length === 0) {
    metricNotes.lastReport = 'No quarterly EPS or revenue facts were found in this filer\u2019s SEC company facts.'
    if (usdMarketCap == null && pe == null) {
      const yahooFallback = await fallbackYahooFundamentals(symbol, meta, price)
      if (yahooFallback.pe != null || yahooFallback.marketCap != null || yahooFallback.quarters.length > 0) {
        return yahooFallback
      }
    }
  }

  const specificFacts: Record<string, FactUnit | undefined> = {}
  if (priceToBook == null && latestEquity != null && latestEquity <= 0) {
    specificFacts.priceToBook = equity.at(-1)
  }
  if (implied.notes.sustainableGrowth === 'Reported book value per share is zero or negative, so return on equity is not meaningful.') {
    specificFacts.sustainableGrowth = equity.at(-1)
    if (implied.notes.impliedReturn === implied.notes.sustainableGrowth) specificFacts.impliedReturn = equity.at(-1)
  }
  if (earningsGrowth == null && recentEps.length >= 2 && recentEps.at(-2) === 0) {
    const previous = quarters.filter((quarter) => quarter.eps != null).at(-2)
    specificFacts.earningsGrowth = eps.find((row) => row.end === previous?.end)
  }
  const metricFilings: Record<string, string> = {}
  if (Object.keys(specificFacts).length) {
    const cik = String(facts.cik).padStart(10, '0')
    const documents = await filingDocuments(cik)
    for (const [metric, fact] of Object.entries(specificFacts)) {
      const url = readableFilingUrl(cik, fact?.accn, fact ? documents.get(fact.accn) : undefined)
      if (url) metricFilings[metric] = url
    }
  }

  return {
    symbol,
    name: facts.entityName,
    exchange: meta.exchangeName ?? '—',
    fullExchange,
    region,
    price: usdPrice,
    rawPrice,
    currency,
    currencyRateToUsd,
    marketTime: meta.regularMarketTime,
    marketCap: usdMarketCap,
    rawMarketCap,
    pe,
    earningsGrowth,
    priceToBook,
    netTangibleAssetsPerShare: tangiblePerShareUsd,
    priceToNetTangibleAssets: tangibleRatio,
    tangibleAssetReports,
    epsRequiresFourQuarters: epsFromFilings,
    ewEpsGrowth,
    ewRevenueGrowth,
    incrementalRoic: incremental.value,
    returnOnEquity: implied.roe,
    sustainableGrowth: implied.sustainableGrowth,
    dividendYield: implied.dividendYield,
    impliedReturn: implied.impliedReturn,
    metricNotes,
    quarters,
    sourceLinks: { ...sourceLinks(yahooSymbol(symbol), facts.cik, true), metricFilings },
    sourceNote: 'Price from Yahoo Finance; fundamentals calculated from SEC EDGAR company facts.',
    isFund: false as const,
  }
}

app.use(cors())
app.use(express.json())

app.get('/api/search', async (req, res) => {
  const query = String(req.query.q ?? '').trim()
  if (!query) return res.json([])
  try {
    const data = await cachedJson<any>(`search:${query.toLowerCase()}`, 30 * 60 * 1000, () =>
      fetch(
        `${yahooBase}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=8&newsCount=0`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
      ),
    )
    const quotes = (data.quotes ?? [])
      .filter((quote: any) =>
        ['EQUITY', 'ETF', 'MUTUALFUND'].includes(quote.quoteType) && quote.symbol,
      )
      .map((quote: any) => {
        const info = getExchangeAndRegion({ exchangeName: quote.exchange, fullExchangeName: quote.exchDisp }, quote.symbol)
        return {
          symbol: quote.symbol,
          name: quote.longname ?? quote.shortname ?? quote.symbol,
          exchange: quote.exchDisp ?? quote.exchange,
          fullExchange: info.full,
          region: info.region,
        }
      })
    res.json(quotes)
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/api/random-symbols', async (req, res) => {
  const count = Number(req.query.count)
  const pool = req.query.pool === 'volume' ? 'volume' : 'all'
  const requestedRegions = String(req.query.regions ?? 'USA')
    .split(',')
    .map((region) => region.trim())
    .filter((region): region is RandomSampleRegion =>
      randomSampleRegions.includes(region as RandomSampleRegion),
    )
  const regions = [...new Set(requestedRegions)]
  const minMarketCap = req.query.minMarketCap == null || req.query.minMarketCap === ''
    ? null
    : Number(req.query.minMarketCap) * 1_000_000_000
  const maxMarketCap = req.query.maxMarketCap == null || req.query.maxMarketCap === ''
    ? null
    : Number(req.query.maxMarketCap) * 1_000_000_000
  if (!Number.isInteger(count) || count < 1) {
    return res.status(400).json({ error: 'Count must be a whole number of at least 1.' })
  }
  if (regions.length === 0) {
    return res.status(400).json({ error: 'Select at least one geographic region.' })
  }
  if (
    (minMarketCap != null && (!Number.isFinite(minMarketCap) || minMarketCap < 0)) ||
    (maxMarketCap != null && (!Number.isFinite(maxMarketCap) || maxMarketCap < 0)) ||
    (minMarketCap != null && maxMarketCap != null && minMarketCap > maxMarketCap)
  ) {
    return res.status(400).json({ error: 'Market-cap limits must be valid positive values with minimum below maximum.' })
  }
  try {
    const candidates = await regionalSymbolUniverse(regions, pool, count)
    shuffle(candidates)
    const selected = await filterByMarketCap(candidates, count, minMarketCap, maxMarketCap)
    if (selected.length < count) {
      return res.status(422).json({
        error: `Only ${selected.length} symbols matched these criteria. Broaden the filters or request fewer symbols.`,
      })
    }
    res.json({
      symbols: selected.map(({ symbol, name, exchange, fullExchange, region }) => ({
        symbol,
        name,
        exchange,
        fullExchange,
        region,
      })),
      universeSize: candidates.length,
      refreshedAt: new Date().toISOString(),
      pool,
      regions,
    })
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/api/history/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase()
    const chart = await quoteChart(symbol, String(req.query.range ?? '1y'))
    const result = chart.chart?.result?.[0]
    if (!result) return res.status(404).json({ error: `No price history found for ${symbol}` })
    const currency = result.meta?.currency ?? 'USD'
    const currencyRateToUsd = await getUsdRate(currency)
    const closes: Array<number | null> = result.indicators?.adjclose?.[0]?.adjclose ?? result.indicators?.quote?.[0]?.close ?? []
    const volumes: Array<number | null> = result.indicators?.quote?.[0]?.volume ?? []
    const points = (result.timestamp ?? [])
      .map((timestamp: number, index: number) => ({
        date: new Date(timestamp * 1000).toISOString().slice(0, 10),
        price: closes[index],
        volume: volumes[index],
      }))
      .filter((point: { price: number | null }) => point.price != null)
    const dividends = Object.entries(result.events?.dividends ?? {}).map(([, event]: [string, any]) => ({
      type: 'dividend',
      date: new Date(event.date * 1000).toISOString().slice(0, 10),
      amount: typeof event.amount === 'number' ? event.amount : null,
    }))
    const splits = Object.entries(result.events?.splits ?? {}).map(([, event]: [string, any]) => ({
      type: 'split',
      date: new Date(event.date * 1000).toISOString().slice(0, 10),
      numerator: typeof event.numerator === 'number' ? event.numerator : null,
      denominator: typeof event.denominator === 'number' ? event.denominator : null,
      ratio: event.splitRatio ?? null,
    }))
    res.json({
      symbol,
      currency,
      currencyRateToUsd,
      points,
      events: [...dividends, ...splits].sort((a, b) => a.date.localeCompare(b.date)),
    })
  } catch (error) {
    sendError(res, error)
  }
})

/**
 * The raw filing facts behind every calculated metric.
 *
 * Each entry records the us-gaap tags that were searched, so the detail view can show not
 * just the value but which tag it actually came from and which metrics it feeds. Synonyms
 * are ordered the same way the metric code orders them.
 */
const sourceFactSpecs: Array<{
  id: string
  label: string
  kind: 'duration' | 'instant'
  unit: string
  names: string[]
  namespaces?: string[]
  feeds: string[]
}> = [
  { id: 'revenue', label: 'Revenue', kind: 'duration', unit: 'USD', feeds: ['Revenue growth (EW)'],
    names: revenueFactNames },
  { id: 'netIncome', label: 'Net income', kind: 'duration', unit: 'USD', feeds: ['Context for EPS'],
    names: ['NetIncomeLoss', 'ProfitLoss'] },
  { id: 'operatingIncome', label: 'Operating income', kind: 'duration', unit: 'USD', feeds: ['Incremental ROIC'],
    names: ['OperatingIncomeLoss'] },
  { id: 'preTaxIncome', label: 'Pre-tax income', kind: 'duration', unit: 'USD', feeds: ['Incremental ROIC tax rate'],
    names: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxes'] },
  { id: 'incomeTaxExpense', label: 'Income tax expense', kind: 'duration', unit: 'USD', feeds: ['Incremental ROIC tax rate'],
    names: ['IncomeTaxExpenseBenefit'] },
  { id: 'epsDiluted', label: 'EPS (diluted)', kind: 'duration', unit: 'USD/shares', feeds: ['P / E', 'Earnings growth', 'EPS growth (EW)', 'Return on equity'],
    names: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'] },
  { id: 'dividendsPerShare', label: 'Dividends declared per share', kind: 'duration', unit: 'USD/shares', feeds: ['Dividend yield', 'Sustainable growth', 'Payout ratio'],
    names: ['CommonStockDividendsPerShareDeclared', 'CommonStockDividendsPerShareCashPaid'] },
  { id: 'dividendsPaid', label: 'Dividends paid (total cash)', kind: 'duration', unit: 'USD', feeds: ['Dividends per share, when no per-share tag is filed'],
    names: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'] },
  { id: 'operatingCashFlow', label: 'Operating cash flow', kind: 'duration', unit: 'USD', feeds: ['Reference only'],
    names: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'] },
  { id: 'assets', label: 'Total assets', kind: 'instant', unit: 'USD', feeds: ['Balance-sheet context', 'Net tangible assets per share'],
    names: ['Assets'] },
  { id: 'liabilities', label: 'Total liabilities', kind: 'instant', unit: 'USD', feeds: ['Balance-sheet context', 'Net tangible assets per share'],
    names: ['Liabilities'] },
  { id: 'totalEquity', label: 'Total equity including noncontrolling interests', kind: 'instant', unit: 'USD', feeds: ['Total liabilities when not tagged directly'],
    names: ['StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  { id: 'intangibleAssets', label: 'Intangible assets including goodwill', kind: 'instant', unit: 'USD', feeds: ['Net tangible assets per share'],
    names: combinedIntangibleFactNames },
  { id: 'goodwill', label: 'Goodwill', kind: 'instant', unit: 'USD', feeds: ['Intangible assets including goodwill'],
    names: goodwillFactNames },
  { id: 'otherIntangibleAssets', label: 'Intangible assets excluding goodwill', kind: 'instant', unit: 'USD', feeds: ['Intangible assets including goodwill'],
    names: otherIntangibleFactNames },
  { id: 'preferredStock', label: 'Preferred stock', kind: 'instant', unit: 'USD', feeds: ['Net tangible assets per share'],
    names: preferredStockFactNames },
  { id: 'preferredShares', label: 'Preferred shares outstanding', kind: 'instant', unit: 'shares', feeds: ['Preferred stock when zero shares are outstanding'],
    names: preferredSharesFactNames },
  { id: 'equity', label: "Stockholders' equity", kind: 'instant', unit: 'USD', feeds: ['Book value per share', 'P / Book', 'Return on equity', 'Incremental ROIC'],
    names: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'] },
  { id: 'cash', label: 'Cash and equivalents', kind: 'instant', unit: 'USD', feeds: ['Net debt', 'Incremental ROIC'],
    names: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'] },
  // Filers migrate between these over time: Coca-Cola abandoned LongTermDebtNoncurrent in
  // 2024 for the capital-lease-inclusive tag, so both spellings must be searched.
  { id: 'longTermDebt', label: 'Long-term debt', kind: 'instant', unit: 'USD', feeds: ['Total debt', 'Net debt', 'Incremental ROIC'],
    names: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations', 'LongTermDebt'] },
  { id: 'shortTermDebt', label: 'Short-term and current debt', kind: 'instant', unit: 'USD', feeds: ['Total debt', 'Net debt', 'Incremental ROIC'],
    names: ['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent', 'ShortTermBorrowings', 'OtherShortTermBorrowings', 'DebtCurrent'] },
  { id: 'totalLiabilitiesAndEquity', label: 'Total liabilities and equity', kind: 'instant', unit: 'USD', feeds: ['Total liabilities, when not tagged directly'],
    names: ['LiabilitiesAndStockholdersEquity'] },
  { id: 'shares', label: 'Shares outstanding', kind: 'instant', unit: 'shares', namespaces: ['us-gaap', 'dei'], feeds: ['Market cap', 'Book value per share', 'Net tangible assets per share'],
    names: ['CommonStockSharesOutstanding', 'EntityCommonStockSharesOutstanding', 'CommonStockSharesIssued'] },
]

/**
 * Reports which tag firstFact would actually select.
 *
 * This must mirror firstFact's "most recently reported wins" rule across *all* namespaces
 * at once. Picking the first namespace that merely had a match reported us-gaap tags for
 * facts that were really taken from dei, which made the detail view disagree with the
 * metrics it was supposed to explain.
 */
function describeFactSource(facts: CompanyFacts, spec: (typeof sourceFactSpecs)[number]) {
  const namespaces = spec.namespaces ?? ['us-gaap']
  let best: { name: string; namespace: string; end: string } | undefined
  for (const namespace of namespaces) {
    const group = facts.facts[namespace as keyof CompanyFacts['facts']] ?? {}
    for (const name of spec.names) {
      const fact = group[name]
      if (!fact) continue
      const end = latestReportedEnd(fact)
      if (!end) continue
      if (!best || end > best.end) best = { name, namespace, end }
    }
  }
  return {
    tag: best ? `${best.namespace}:${best.name}` : null,
    searched: spec.names.map((name) => (namespaces.length > 1 ? name : name)),
  }
}

/**
 * Balance-sheet value aligned to an income-statement period.
 *
 * An exact date match is preferred, but instants do not always land on the period end:
 * cover-page share counts carry the filing date, and 52/53-week fiscal calendars drift by a
 * few days. Quarters are ~91 days apart, so a 45-day window cannot reach a neighbouring
 * quarter and therefore cannot mis-attribute a value.
 */
function valueAsOf(rows: FactUnit[], end: string, windowDays = 45): number | null {
  return factAsOf(rows, end, windowDays)?.val ?? null
}

function factAsOf(rows: FactUnit[], end: string, windowDays = 45): FactUnit | undefined {
  const exact = rows.find((row) => row.end === end)
  if (exact) return exact
  const target = new Date(end).getTime()
  let best: { row: FactUnit; distance: number } | undefined
  for (const row of rows) {
    const distance = Math.abs(new Date(row.end).getTime() - target) / 86_400_000
    if (distance > windowDays) continue
    if (!best || distance < best.distance) best = { row, distance }
  }
  return best?.row
}

/** Direct link to the exact filing an accession number identifies (all documents). */
function filingIndexUrl(cik: string | null, accession: string | null | undefined) {
  if (!cik || !accession) return null
  const bare = accession.replace(/-/g, '')
  return `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${bare}/${accession}-index.htm`
}

type FilingDoc = { primaryDocument: string; form: string; inlineXbrl: boolean; reportDate: string; filingDate: string }

/**
 * Maps accession numbers to their primary document so filings can be linked in readable
 * form. The XBRL company-facts API gives no document names, so this comes from the
 * submissions feed, which is already fetched and cached for domestic-filer checks.
 */
async function filingDocuments(cik: string | null): Promise<Map<string, FilingDoc>> {
  const result = new Map<string, FilingDoc>()
  if (!cik) return result
  try {
    const data = await cachedJson<any>(`submissions:${cik}`, 24 * 60 * 60 * 1000, () =>
      fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: secHeaders }),
    )
    const recent = data?.filings?.recent
    if (!recent?.accessionNumber) return result
    for (let index = 0; index < recent.accessionNumber.length; index += 1) {
      const document = recent.primaryDocument?.[index]
      if (!document) continue
      result.set(recent.accessionNumber[index], {
        primaryDocument: document,
        form: recent.form?.[index] ?? '',
        inlineXbrl: recent.isInlineXBRL?.[index] === 1,
        reportDate: recent.reportDate?.[index] ?? '',
        filingDate: recent.filingDate?.[index] ?? '',
      })
    }
  } catch {
    // A missing submissions feed only costs the readable link, not the data itself.
  }
  return result
}

async function filingClassShares(cik: number | undefined): Promise<FactUnit[]> {
  if (!cik || !Number.isSafeInteger(cik) || cik < 1) return []
  try {
    return await cachedValue(`filing-class-shares:${cik}`, 6 * 60 * 60 * 1000, async () => {
      const documents = await filingDocuments(String(cik).padStart(10, '0'))
      const latest = [...documents.entries()]
        .filter(([, doc]) => (doc.form === '10-Q' || doc.form === '10-K') && doc.inlineXbrl)
        .sort((a, b) => b[1].reportDate.localeCompare(a[1].reportDate) || b[1].filingDate.localeCompare(a[1].filingDate))[0]
      if (!latest) return []
      const [accession, doc] = latest
      const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${doc.primaryDocument}`
      const html = await cachedText(`filing:${cik}:${accession}`, 6 * 60 * 60 * 1000, () =>
        fetch(url, { headers: { ...secHeaders, Accept: 'text/html' } }),
      )
      return sharesFromFiling(html, { accession, form: doc.form, filed: doc.filingDate })
    })
  } catch (error) {
    console.warn('Could not read class-specific SEC shares:', error)
    return []
  }
}

async function filingClassEps(symbol: string, cik: number | undefined): Promise<FactUnit[]> {
  const ticker = symbol.toUpperCase().replace(/\./g, '-')
  if (cik !== 1067983 || (ticker !== 'BRK-A' && ticker !== 'BRK-B')) return []
  const className = ticker === 'BRK-A' ? 'A' : 'B'
  try {
    return await cachedValue(`filing-eps:${cik}:${className}`, 6 * 60 * 60 * 1000, async () => {
      const documents = await filingDocuments(String(cik).padStart(10, '0'))
      const recent = [...documents.entries()]
        .filter(([, doc]) => (doc.form === '10-Q' || doc.form === '10-K') && doc.inlineXbrl)
        .sort((a, b) => b[1].reportDate.localeCompare(a[1].reportDate) || b[1].filingDate.localeCompare(a[1].filingDate))
        .slice(0, 4)
      const rows = new Map<string, FactUnit>()
      for (const [accession, doc] of recent) {
        try {
          const url = `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, '')}/${doc.primaryDocument}`
          const html = await cachedText(`filing:${cik}:${accession}`, 6 * 60 * 60 * 1000, () =>
            fetch(url, { headers: { ...secHeaders, Accept: 'text/html' } }),
          )
          for (const row of classEpsFromFiling(html, { accession, form: doc.form, filed: doc.filingDate }, className)) {
            if (row.end !== doc.reportDate) continue
            const existing = rows.get(row.end)
            if (!existing || row.filed < existing.filed) rows.set(row.end, row)
          }
        } catch (error) {
          console.warn('Could not read EPS from SEC filing:', error)
        }
      }
      return [...rows.values()].sort((a, b) => a.end.localeCompare(b.end))
    })
  } catch (error) {
    console.warn('Could not read class-specific SEC EPS:', error)
    return []
  }
}

/**
 * The filing as a person would read it. Inline-XBRL filings open in SEC's viewer, which
 * renders the document and lets each tagged figure be inspected in place; older filings
 * fall back to the plain document.
 */
function readableFilingUrl(cik: string | null, accession: string | null | undefined, doc: FilingDoc | undefined) {
  if (!cik || !accession || !doc) return null
  const bare = accession.replace(/-/g, '')
  const path = `/Archives/edgar/data/${Number(cik)}/${bare}/${doc.primaryDocument}`
  return doc.inlineXbrl ? `https://www.sec.gov/ix?doc=${path}` : `https://www.sec.gov${path}`
}

function insiderEventClass(form: string) {
  if (form === '3') return 'Initial beneficial ownership'
  if (form === '4') return 'Change in beneficial ownership'
  if (form === '5') return 'Annual/deferred beneficial ownership statement'
  return 'Insider ownership filing'
}

/** Link to SEC's raw XBRL series for a single tag, which is the exact upstream payload. */
function conceptUrl(cik: string | null, tag: string | null) {
  if (!cik || !tag) return null
  const [namespace, name] = tag.split(':')
  if (!namespace || !name) return null
  return `https://data.sec.gov/api/xbrl/companyconcept/CIK${cik}/${namespace}/${name}.json`
}

type CompanyProfile = {
  description: string | null
  sector: string | null
  industry: string | null
  sic: string | null
  sicDescription: string | null
  employees: number | null
  location: string | null
  website: string | null
  financeProfileUrl: string
}

/**
 * "What does this company do?" — pulled from two independent sources so it still shows
 * something useful when either is missing: Yahoo's asset profile has the readable
 * paragraph, sector/industry, and site link; SEC's submissions feed has the official SIC
 * industry classification, which also covers funds (Yahoo rarely writes a description for
 * those). Both requests are cached, and the submissions fetch reuses the same cache entry
 * filingDocuments() already populates, so this costs no extra upstream call for a symbol
 * whose filings were already loaded.
 */
async function companyProfile(symbol: string, cik: string | null): Promise<CompanyProfile> {
  let sic: string | null = null
  let sicDescription: string | null = null
  if (cik) {
    try {
      const data = await cachedJson<any>(`submissions:${cik}`, 24 * 60 * 60 * 1000, () =>
        fetch(`https://data.sec.gov/submissions/CIK${cik}.json`, { headers: secHeaders }),
      )
      sic = data?.sic ?? null
      sicDescription = data?.sicDescription ?? null
    } catch {
      // A missing submissions feed only costs the SIC classification, not the Yahoo profile.
    }
  }

  let description: string | null = null
  let sector: string | null = null
  let industry: string | null = null
  let website: string | null = null
  let employees: number | null = null
  let location: string | null = null
  try {
    const session = await yahooSession()
    const summary = await cachedJson<any>(`profile:${symbol}`, 24 * 60 * 60 * 1000, () =>
      fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol(symbol))}` +
        `?modules=assetProfile&crumb=${encodeURIComponent(session.crumb)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: session.cookie } },
      ),
    )
    const profile = summary?.quoteSummary?.result?.[0]?.assetProfile
    if (profile) {
      description = profile.longBusinessSummary ?? null
      sector = profile.sector ?? null
      industry = profile.industry ?? null
      website = profile.website ?? null
      employees = typeof profile.fullTimeEmployees === 'number' ? profile.fullTimeEmployees : null
      location = [profile.city, profile.state, profile.country].filter(Boolean).join(', ') || null
    }
  } catch {
    // Funds and thinly-covered tickers often have no asset profile; the SIC classification
    // above still gives a usable, if terser, answer.
  }

  return {
    description,
    sector,
    industry,
    sic,
    sicDescription,
    employees,
    location,
    website,
    financeProfileUrl: `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}/profile`,
  }
}

async function companyDetail(symbol: string) {
  const [chart, facts] = await Promise.all([quoteChart(symbol, '1mo'), companyFacts(symbol)])
  const result = chart.chart?.result?.[0]
  if (!result) throw new Error(`No market data found for ${symbol}`)
  const meta = result.meta
  const isFund = meta.instrumentType === 'ETF' || meta.instrumentType === 'MUTUALFUND'
  const cik = await cikForTicker(symbol)
  const [documents, profile] = await Promise.all([
    filingDocuments(cik),
    companyProfile(symbol, cik),
  ])
  const { full: fullExchange, region } = getExchangeAndRegion(meta, symbol)
  const currency = meta.currency ?? 'USD'
  const currencyRateToUsd = await getUsdRate(currency)

  // The most recent annual or quarterly report, used as the readable landing point for the
  // tag list, where no single filing corresponds to a whole series.
  const latestReport = [...documents.entries()]
    .filter(([, doc]) => doc.form === '10-K' || doc.form === '10-Q')
    .sort((left, right) => right[1].reportDate.localeCompare(left[1].reportDate))[0]
  const insiderEvents = [...documents.entries()]
    .filter(([, doc]) => ['3', '4', '5'].includes(doc.form))
    .sort((left, right) => right[1].filingDate.localeCompare(left[1].filingDate))
    .slice(0, 40)
    .map(([accession, doc]) => ({
      type: 'insider',
      date: doc.filingDate || doc.reportDate,
      form: doc.form,
      eventClass: insiderEventClass(doc.form),
      accession,
      filingUrl: readableFilingUrl(cik, accession, doc),
      filingIndexUrl: filingIndexUrl(cik, accession),
    }))

  const rawPrice = meta.regularMarketPrice ?? null
  const usdPrice = rawPrice != null ? rawPrice * currencyRateToUsd : null

  const identity = {
    symbol,
    name: meta.longName ?? meta.shortName ?? symbol,
    exchange: meta.exchangeName ?? '—',
    fullExchange,
    region,
    currency,
    currencyRateToUsd,
    price: rawPrice,
    usdPrice,
    instrumentType: meta.instrumentType ?? null,
    cik,
    entityName: facts?.entityName ?? null,
    filingsUrl: cik ? `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K&dateb=&owner=include&count=40` : null,
    latestReportUrl: latestReport ? readableFilingUrl(cik, latestReport[0], latestReport[1]) : null,
    latestReportForm: latestReport ? latestReport[1].form : null,
    insiderEvents,
    fundSummary: null,
    profile,
  }

  if (!facts) {
    let fallbackPeriods: any[] = []
    try {
      const summary = await yahooQuoteSummary(symbol)
      const resultSummary = summary?.quoteSummary?.result?.[0]
      if (resultSummary) {
        const sd = resultSummary.summaryDetail ?? {}
        const ks = resultSummary.defaultKeyStatistics ?? {}
        const fd = resultSummary.financialData ?? {}
        const raw = (n: any): number | null => (typeof n?.raw === 'number' && Number.isFinite(n.raw) ? n.raw : null)
        const asPercent = (n: number | null) => (n == null ? null : +(n * 100).toFixed(2))

        const incList = (resultSummary.incomeStatementHistoryQuarterly?.incomeStatementHistory ?? []).slice().reverse()
        const bsList = (resultSummary.balanceSheetHistoryQuarterly?.balanceSheetStatements ?? []).slice().reverse()
        const cfList = (resultSummary.cashflowStatementHistoryQuarterly?.cashflowStatements ?? []).slice().reverse()
        const dates = [...new Set([...incList.map((x: any) => x.endDate?.fmt), ...bsList.map((x: any) => x.endDate?.fmt), ...cfList.map((x: any) => x.endDate?.fmt)])].filter(Boolean).sort()
        const sharesOut = raw(ks.sharesOutstanding)

        const pe = raw(sd.trailingPE) ?? raw(ks.trailingPE)
        const priceToBook = raw(ks.priceToBook)
        const returnOnEquity = asPercent(raw(fd.returnOnEquity)) ?? (pe && priceToBook ? +((priceToBook / pe) * 100).toFixed(2) : null)
        const payoutRatio = asPercent(raw(sd.payoutRatio))

        fallbackPeriods = dates.map((end) => {
          const inc = incList.find((x: any) => x.endDate?.fmt === end)
          const bs = bsList.find((x: any) => x.endDate?.fmt === end)
          const cf = cfList.find((x: any) => x.endDate?.fmt === end)

          const revenue = raw(inc?.totalRevenue)
          const netIncome = raw(inc?.netIncome)
          const eps = sharesOut && netIncome != null ? netIncome / sharesOut : (raw(ks.trailingEps) ?? null)
          const operatingCashFlow = raw(cf?.totalCashFromOperatingActivities) ?? raw(fd.operatingCashflow)
          const equity = raw(bs?.totalStockholderEquity) ?? (sharesOut && raw(ks.bookValue) ? sharesOut * raw(ks.bookValue)! : null)
          const totalDebtFromStatement = raw(bs?.longTermDebt) == null && raw(bs?.shortLongTermDebt) == null
            ? null
            : (raw(bs?.longTermDebt) ?? 0) + (raw(bs?.shortLongTermDebt) ?? 0)
          const totalDebt = totalDebtFromStatement ?? raw(fd.totalDebt)
          const assets = raw(bs?.totalAssets) ?? (equity != null && totalDebt != null ? equity + totalDebt : null)
          const liabilities = raw(bs?.totalLiab) ?? (assets != null && equity != null ? assets - equity : totalDebt)
          const cash = raw(bs?.cash) ?? raw(fd.totalCash)
          const longTermDebt = raw(bs?.longTermDebt)
          const shortTermDebt = raw(bs?.shortLongTermDebt)
          const netDebt = totalDebt == null ? null : totalDebt - (cash ?? 0)
          const dividendsPerShare = (sharesOut && raw(cf?.dividendsPaid) ? Math.abs(raw(cf?.dividendsPaid)!) / sharesOut : null) ?? raw(sd.dividendRate)
          const bookValuePerShare = raw(ks.bookValue) ?? (sharesOut && equity != null ? equity / sharesOut : null)
          const tangible = yahooTangibleInputs(bs, raw)

          return {
            end,
            filed: end,
            form: 'Quarterly',
            accession: null,
            filingUrl: null,
            filingIndexUrl: null,
            fiscalYear: null,
            fiscalPeriod: null,
            revenue,
            netIncome,
            eps,
            returnOnEquity,
            dividendsPerShare,
            payoutRatio,
            operatingCashFlow,
            assets,
            liabilities,
            intangibleAssets: tangible.intangibleAssets,
            preferredStock: tangible.preferredStock,
            tangibleInputs: {
              ...tangible,
              shares: sharesOut ?? 0,
              netTangibleAssetsPerShare: netTangibleAssetsPerShare(tangible.assets, tangible.intangibleAssets, tangible.liabilities, tangible.preferredStock, sharesOut),
              assumptions: sharesOut == null ? [...tangible.assumptions, 'common shares outstanding'] : tangible.assumptions,
            },
            liabilitiesDerived: raw(bs?.totalLiab) == null && liabilities != null,
            equity,
            cash,
            longTermDebt,
            shortTermDebt,
            totalDebt,
            netDebt,
            shares: sharesOut,
            bookValuePerShare,
            debtToEquity: totalDebt != null && equity && equity > 0 ? totalDebt / equity : null,
          }
        })
      }
    } catch {
      // Ignore fallback period failure
    }
    return { ...identity, isFund, series: [], periods: fallbackPeriods, sources: [] }
  }

  // Every fact is extracted with the same helpers the metric code uses, so the detail view
  // reports the exact values the metrics were computed from rather than a parallel reading.
  const series = new Map<string, FactUnit[]>()
  const sources: Array<{ id: string; label: string; tag: string | null; searched: string[]; unit: string; kind: string; feeds: string[]; count: number; url: string | null }> = []
  for (const spec of sourceFactSpecs) {
    const fact = firstFact(facts, spec.names, spec.namespaces)
    let rows = spec.kind === 'duration' ? quarterlyValues(fact, spec.unit) : instantValues(fact, spec.unit)
    const filingShares = spec.id === 'shares' && rows.length === 0 ? await filingClassShares(facts.cik) : []
    const latestFinancialEnd = [
      (series.get('revenue') ?? []).at(-1)?.end,
      instantValues(firstFact(facts, ['Assets']), 'USD').at(-1)?.end,
    ].filter((end): end is string => !!end).sort().at(-1)
    const filingEps = spec.id === 'epsDiluted' && (!rows.length || (latestFinancialEnd && (rows.at(-1)?.end ?? '') < latestFinancialEnd))
      ? await filingClassEps(symbol, facts.cik) : []
    if (filingShares.length) rows = filingShares
    const useFilingEps = filingEps.length > 0 && (filingEps.at(-1)?.end ?? '') > (rows.at(-1)?.end ?? '')
    if (useFilingEps) rows = filingEps
    series.set(spec.id, rows)
    const described = describeFactSource(facts, spec)
    sources.push({
      id: spec.id,
      label: spec.label,
      tag: filingShares.length ? 'Common shares from SEC filing' : useFilingEps ? `Class ${symbol.toUpperCase().endsWith('A') ? 'A' : 'B'} EPS from SEC filing` : described.tag,
      searched: described.searched,
      unit: spec.unit,
      kind: spec.kind,
      feeds: spec.feeds,
      count: rows.length,
      url: filingShares.length || useFilingEps ? null : conceptUrl(cik, described.tag),
    })
  }

  const durationEnds = sourceFactSpecs
    .filter((spec) => spec.kind === 'duration')
    .flatMap((spec) => (series.get(spec.id) ?? []).map((row) => row.end))
  const ends = [...new Set(durationEnds)].sort().slice(-20)

  // Instants use the windowed lookup; only a same-dated income-statement fact is exact.
  const at = (id: string, end: string) => valueAsOf(series.get(id) ?? [], end)
  const exactly = (id: string, end: string) => valueAtEnd(series.get(id) ?? [], end)

  const periods = ends.map((end) => {
    const row = (series.get('epsDiluted') ?? []).find((item) => item.end === end)
      ?? (series.get('revenue') ?? []).find((item) => item.end === end)
    const equity = at('equity', end)
    const shares = at('shares', end)
    const assets = at('assets', end)
    const tangible = tangibleInputs((id) => exactly(id, end))
    // Many filers never tag Liabilities, reporting only the balancing total. Backing it out
    // keeps the column populated rather than blank, and it is flagged as derived.
    const reportedLiabilities = at('liabilities', end)
    const totalLiabilitiesAndEquity = at('totalLiabilitiesAndEquity', end)
    const base = totalLiabilitiesAndEquity ?? assets
    const equityForLiabilities = at('totalEquity', end) ?? equity
    const liabilities = reportedLiabilities ?? (base != null && equityForLiabilities != null ? base - equityForLiabilities : null)
    const liabilitiesDerived = reportedLiabilities == null && liabilities != null
    const longTerm = at('longTermDebt', end)
    const shortTerm = at('shortTermDebt', end)
    const totalDebt = longTerm == null && shortTerm == null ? null : (longTerm ?? 0) + (shortTerm ?? 0)
    const cash = at('cash', end)
    const dividendsPerShare = exactly('dividendsPerShare', end)
      ?? (() => {
        const paid = exactly('dividendsPaid', end)
        return paid != null && shares ? paid / shares : null
      })()
    const eps = exactly('epsDiluted', end)
    const bookValuePerShare = equity != null && shares ? equity / shares : null
    return {
      end,
      filed: row?.filed ?? null,
      form: row?.form ?? null,
      accession: row?.accn ?? null,
      filingUrl: readableFilingUrl(cik, row?.accn, row ? documents.get(row.accn) : undefined),
      filingIndexUrl: filingIndexUrl(cik, row?.accn),
      fiscalYear: row?.fy ?? null,
      fiscalPeriod: row?.fp ?? null,
      revenue: exactly('revenue', end),
      netIncome: exactly('netIncome', end),
      eps,
      returnOnEquity: eps != null && bookValuePerShare && bookValuePerShare > 0 ? (eps / bookValuePerShare) * 100 : null,
      dividendsPerShare,
      payoutRatio: eps != null && eps > 0 && dividendsPerShare != null ? (dividendsPerShare / eps) * 100 : null,
      operatingCashFlow: exactly('operatingCashFlow', end),
      assets,
      liabilities,
      intangibleAssets: tangible.intangibleAssets,
      preferredStock: tangible.preferredStock,
      tangibleInputs: {
        ...tangible,
        shares: shares ?? 0,
        netTangibleAssetsPerShare: netTangibleAssetsPerShare(tangible.assets, tangible.intangibleAssets, tangible.liabilities, tangible.preferredStock, shares),
        assumptions: shares == null ? [...tangible.assumptions, 'common shares outstanding'] : tangible.assumptions,
      },
      liabilitiesDerived,
      equity,
      cash,
      longTermDebt: longTerm,
      shortTermDebt: shortTerm,
      totalDebt,
      netDebt: totalDebt == null ? null : totalDebt - (cash ?? 0),
      shares,
      bookValuePerShare,
      debtToEquity: totalDebt != null && equity && equity > 0 ? totalDebt / equity : null,
    }
  })

  return { ...identity, isFund: false, periods, sources }
}

type FundWeightedFinancials = FundMetrics['weightedFinancials']

function emptyWeightedFinancials(reason: string): FundWeightedFinancials {
  return {
    coverage: null, revenue: null, netIncome: null, eps: null, dividendsPerShare: null,
    payoutRatio: null, assets: null, liabilities: null, equity: null, cash: null,
    longTermDebt: null, shortTermDebt: null, totalDebt: null, netDebt: null,
    notes: { all: reason },
  }
}

/**
 * The stocks that make up a fund, with the same per-company metrics shown in the main
 * comparison table, plus constituent-weighted equivalents of the company-level metrics
 * and financial-statement figures.
 *
 * This is deliberately its own lazily-fetched endpoint rather than something computed
 * inside every /api/detail/:symbol call: it calls fundamentals() and companyDetail() for
 * every top holding, which is only affordable when a user has actually asked to see the
 * constituents, not on every fund load in an aggregate table.
 */
async function fundConstituentData(symbol: string) {
  const notes: Record<string, string> = {}

  let holdingWeights: Array<{ symbol: string; weight: number | null }> = []
  try {
    const session = await yahooSession()
    const summary = await cachedJson<any>(`fund:${symbol}`, 6 * 60 * 60 * 1000, () =>
      fetch(
        `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(yahooSymbol(symbol))}` +
        `?modules=topHoldings,summaryDetail,fundProfile&crumb=${encodeURIComponent(session.crumb)}`,
        { headers: { 'User-Agent': 'Mozilla/5.0', Cookie: session.cookie } },
      ),
    )
    const result = summary?.quoteSummary?.result?.[0]
    const holdingsNode = result?.topHoldings ?? {}
    const holdingRows = Array.isArray(holdingsNode.holdings) ? holdingsNode.holdings : []
    const raw = (node: any): number | null => {
      const value = node?.raw
      return typeof value === 'number' && Number.isFinite(value) ? value : null
    }
    holdingWeights = holdingRows
      .map((holding: any) => ({
        symbol: normalizeHoldingSymbol(typeof holding.symbol === 'string' ? holding.symbol : ''),
        weight: raw(holding.holdingPercent),
      }))
      .filter((holding: { symbol: string; weight: number | null }) => holding.symbol && holding.weight != null && holding.weight > 0)
  } catch {
    // Falls through to the empty result below.
  }

  if (!holdingWeights.length) {
    const reason = 'Yahoo did not publish holdings weights for this fund, so constituent-level detail is unavailable.'
    return {
      holdings: [] as Array<Awaited<ReturnType<typeof fundamentals>> & { weight: number | null }>,
      weightedMarketCap: null,
      earningsGrowth: null,
      ewEpsGrowth: null,
      ewRevenueGrowth: null,
      incrementalRoic: null,
      holdingCoverage: null,
      weightedFinancials: emptyWeightedFinancials(reason),
      notes: { marketCap: reason, earningsGrowth: reason, ewEpsGrowth: reason, ewRevenueGrowth: reason, incrementalRoic: reason },
    }
  }

  const others = holdingWeights.filter((holding) => holding.symbol.toUpperCase() !== symbol.toUpperCase())

  const fundamentalsResults = await Promise.allSettled(
    others.map(async (holding) => ({ holding, facts: await fundamentals(holding.symbol) })),
  )
  const successfulHoldings = fundamentalsResults
    .filter((result): result is PromiseFulfilledResult<{ holding: { symbol: string; weight: number | null }; facts: Awaited<ReturnType<typeof fundamentals>> }> =>
      result.status === 'fulfilled' && !result.value.facts.isFund,
    )
    .map((result) => result.value)

  const holdingCoverage = successfulHoldings.reduce((sum, item) => sum + (item.holding.weight ?? 0), 0)
  const weighted = (field: keyof Awaited<ReturnType<typeof fundamentals>>) => {
    let weight = 0
    let total = 0
    for (const item of successfulHoldings) {
      const value = item.facts[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || item.holding.weight == null) continue
      weight += item.holding.weight
      total += item.holding.weight * value
    }
    return weight > 0 ? total / weight : null
  }
  const weightedMarketCap = weighted('marketCap')
  const earningsGrowth = weighted('earningsGrowth')
  const ewEpsGrowth = weighted('ewEpsGrowth')
  const ewRevenueGrowth = weighted('ewRevenueGrowth')
  const incrementalRoic = weighted('incrementalRoic')

  if (holdingCoverage <= 0) {
    const reason = 'Could not calculate constituent-weighted company metrics from the published top holdings.'
    notes.marketCap = reason
    notes.earningsGrowth = reason
    notes.ewEpsGrowth = reason
    notes.ewRevenueGrowth = reason
    notes.incrementalRoic = reason
  } else {
    const reason = `Published holdings with usable company fundamentals cover ${(holdingCoverage * 100).toFixed(1)}% of the fund.`
    if (weightedMarketCap == null) notes.marketCap = `${reason} None reported market cap.`
    if (earningsGrowth == null) notes.earningsGrowth = `${reason} None had calculable EPS growth.`
    if (ewEpsGrowth == null) notes.ewEpsGrowth = `${reason} None had calculable EW EPS growth.`
    if (ewRevenueGrowth == null) notes.ewRevenueGrowth = `${reason} None had calculable EW revenue growth.`
    if (incrementalRoic == null) notes.incrementalRoic = `${reason} None had calculable incremental ROIC.`
  }

  const detailResults = await Promise.allSettled(
    others.map(async (holding) => ({ holding, detail: await companyDetail(holding.symbol) })),
  )
  const detailHoldings = detailResults
    .filter((result): result is PromiseFulfilledResult<{ holding: { symbol: string; weight: number | null }; detail: Awaited<ReturnType<typeof companyDetail>> }> =>
      result.status === 'fulfilled' && !result.value.detail.isFund,
    )
    .map((result) => ({
      holding: result.value.holding,
      period: result.value.detail.periods.at(-1),
    }))
    .filter((item): item is { holding: { symbol: string; weight: number | null }; period: NonNullable<Awaited<ReturnType<typeof companyDetail>>['periods'][number]> } =>
      item.period != null,
    )

  const weightedFinancialCoverage = detailHoldings.reduce((sum, item) => sum + (item.holding.weight ?? 0), 0)
  const weightedPeriodValue = (field: keyof (typeof detailHoldings)[number]['period']) => {
    let weight = 0
    let total = 0
    for (const item of detailHoldings) {
      const value = item.period[field]
      if (typeof value !== 'number' || !Number.isFinite(value) || item.holding.weight == null) continue
      weight += item.holding.weight
      total += item.holding.weight * value
    }
    return weight > 0 ? total / weight : null
  }
  const weightedFinancialNotes: Record<string, string> = {}
  const weightedFinancials: FundWeightedFinancials = {
    coverage: weightedFinancialCoverage > 0 ? weightedFinancialCoverage * 100 : null,
    revenue: weightedPeriodValue('revenue'),
    netIncome: weightedPeriodValue('netIncome'),
    eps: weightedPeriodValue('eps'),
    dividendsPerShare: weightedPeriodValue('dividendsPerShare'),
    payoutRatio: weightedPeriodValue('payoutRatio'),
    assets: weightedPeriodValue('assets'),
    liabilities: weightedPeriodValue('liabilities'),
    equity: weightedPeriodValue('equity'),
    cash: weightedPeriodValue('cash'),
    longTermDebt: weightedPeriodValue('longTermDebt'),
    shortTermDebt: weightedPeriodValue('shortTermDebt'),
    totalDebt: weightedPeriodValue('totalDebt'),
    netDebt: weightedPeriodValue('netDebt'),
    notes: weightedFinancialNotes,
  }
  for (const key of ['revenue', 'netIncome', 'eps', 'dividendsPerShare', 'payoutRatio', 'assets', 'liabilities', 'equity', 'cash', 'longTermDebt', 'shortTermDebt', 'totalDebt', 'netDebt'] as const) {
    if (weightedFinancials[key] == null) {
      weightedFinancialNotes[key] = `No published top holding with usable company detail data reported ${key}. Coverage: ${weightedFinancials.coverage == null ? '—' : weightedFinancials.coverage.toFixed(1)}%.`
    }
  }

  return {
    holdings: successfulHoldings.map((item) => ({ ...item.facts, weight: item.holding.weight })),
    weightedMarketCap,
    earningsGrowth,
    ewEpsGrowth,
    ewRevenueGrowth,
    incrementalRoic,
    holdingCoverage: holdingCoverage > 0 ? holdingCoverage * 100 : null,
    weightedFinancials,
    notes,
  }
}

app.get('/api/fundamentals/:symbol', async (req, res) => {
  try {
    res.json(await fundamentals(req.params.symbol.toUpperCase()))
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/api/detail/:symbol', async (req, res) => {
  try {
    res.json(await companyDetail(req.params.symbol.toUpperCase()))
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/api/news/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase()
    const range = ['5d', '1mo', '3mo', '6mo', '1y', '2y', '5y', '10y', 'max'].includes(String(req.query.range))
      ? String(req.query.range)
      : '1y'
    const rangeStart = (() => {
      if (range === 'max') return null
      const start = new Date()
      if (range.endsWith('d')) start.setUTCDate(start.getUTCDate() - Number.parseInt(range, 10))
      else if (range.endsWith('mo')) start.setUTCMonth(start.getUTCMonth() - Number.parseInt(range, 10))
      else start.setUTCFullYear(start.getUTCFullYear() - Number.parseInt(range, 10))
      return start.getTime()
    })()
    const yahooTicker = yahooSymbol(symbol).toUpperCase()
    const baseTicker = yahooTicker.split('.')[0]
    const queries = baseTicker === yahooTicker ? [yahooTicker] : [yahooTicker, baseTicker]
    const aliases = new Set(queries)
    const responses: any[] = []
    for (const query of queries) {
      const data = await cachedJson<any>(`news-query:${query}`, 10 * 60 * 1000, () =>
        fetch(
          `${yahooBase}/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=0&newsCount=100`,
          { headers: { 'User-Agent': 'Mozilla/5.0' } },
        ),
      )
      responses.push(...(data.news ?? []))
      if (responses.length >= 60) break
    }
    const seen = new Set<string>()
    const items = responses
      .filter((item: any) =>
        item.title &&
        item.link &&
        Array.isArray(item.relatedTickers) &&
        item.relatedTickers.some((ticker: unknown) =>
          typeof ticker === 'string' && aliases.has(ticker.toUpperCase()),
        ),
      )
      .filter((item: any) => {
        const id = String(item.uuid ?? item.link)
        if (seen.has(id)) return false
        seen.add(id)
        return true
      })
      .slice(0, 60)
      .map((item: any) => ({
        id: String(item.uuid ?? item.link),
        title: String(item.title),
        publisher: String(item.publisher ?? 'Unknown publisher'),
        source: 'Yahoo Finance' as const,
        url: String(item.link),
        publishedAt: new Date(Number(item.providerPublishTime) * 1000).toISOString(),
        relatedTickers: item.relatedTickers.filter((ticker: unknown): ticker is string => typeof ticker === 'string'),
      }))

    const chart = await quoteChart(symbol, '1mo')
    const meta = chart.chart?.result?.[0]?.meta ?? {}
    const companyName = String(meta.longName ?? meta.shortName ?? baseTicker)
      .replace(/\s+(Inc\.?|Incorporated|Corporation|Corp\.?|Limited|Ltd\.?|plc|PLC)$/i, '')
      .trim()
    const googleQuery = `"${companyName}"${range === 'max' ? '' : ` when:${range.replace('mo', 'm')}`}`
    const googleXml = await cachedText(`google-news:${symbol}:${range}`, 30 * 60 * 1000, () =>
      fetch(
        `https://news.google.com/rss/search?q=${encodeURIComponent(googleQuery)}&hl=en-US&gl=US&ceid=US:en`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } },
      ),
    )
    const decodeXml = (value: string) => value
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;|&apos;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
    const tagValue = (xml: string, tag: string) => {
      const match = xml.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, 'i'))
      return match ? decodeXml(match[1].trim()) : ''
    }
    const googleItems = [...googleXml.matchAll(/<item>([\s\S]*?)<\/item>/gi)]
      .map((match) => {
        const xml = match[1]
        const title = tagValue(xml, 'title')
        const url = tagValue(xml, 'link')
        const publishedAt = new Date(tagValue(xml, 'pubDate'))
        if (!title || !url || !Number.isFinite(publishedAt.getTime())) return null
        return {
          id: `google:${tagValue(xml, 'guid') || url}`,
          title,
          publisher: tagValue(xml, 'source') || 'Unknown publisher',
          source: 'Google News' as const,
          url,
          publishedAt: publishedAt.toISOString(),
          relatedTickers: [symbol],
        }
      })
      .filter((item): item is NonNullable<typeof item> => item != null)

    const merged = [...items, ...googleItems]
      .filter((item) => rangeStart == null || new Date(item.publishedAt).getTime() >= rangeStart)
      .sort((left, right) => right.publishedAt.localeCompare(left.publishedAt))
      .filter((item, index, all) => {
        const normalized = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
        return all.findIndex((candidate) =>
          candidate.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim() === normalized,
        ) === index
      })
    res.json({ symbol, items: merged })
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/api/fund-constituents/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase()
    res.json(await cachedValue(`fund-constituents:${symbol}`, 10 * 60 * 1000, () => fundConstituentData(symbol)))
  } catch (error) {
    sendError(res, error)
  }
})

app.get('/api/health', (_req, res) => res.json({ ok: true }))
const server = app.listen(port, () => {
  console.log(`Research API listening on http://localhost:${port}`)
})
server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`Research API could not start: port ${port} is already in use. Stop the previous development process and run npm run dev again.`)
  } else {
    console.error('Research API could not start:', error)
  }
  process.exit(1)
})
