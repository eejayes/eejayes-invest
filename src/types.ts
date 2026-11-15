export type SearchResult = {
  symbol: string
  name: string
  exchange: string
  fullExchange?: string
  region?: string
}

export type PricePoint = {
  date: string
  price: number
  volume?: number | null
}

export type PriceEvent =
  | { type: 'dividend'; date: string; amount: number | null }
  | { type: 'split'; date: string; numerator: number | null; denominator: number | null; ratio: string | null }

export type PriceHistory = {
  symbol: string
  currency: string
  currencyRateToUsd?: number
  points: PricePoint[]
  events: PriceEvent[]
}

export type SymbolNewsItem = {
  id: string
  title: string
  publisher: string
  source: 'Yahoo Finance' | 'Google News'
  url: string
  publishedAt: string
  relatedTickers: string[]
}

export type Fundamentals = {
  symbol: string
  name: string
  exchange: string
  fullExchange?: string
  region?: string
  price: number
  rawPrice?: number | null
  currency: string
  currencyRateToUsd?: number
  marketTime: number
  marketCap: number | null
  rawMarketCap?: number | null
  pe: number | null
  earningsGrowth: number | null
  priceToBook: number | null
  netTangibleAssetsPerShare: number | null
  priceToNetTangibleAssets: number | null
  tangibleAssetReports?: Array<{ end: string; date: string; value: number; assumptions?: string[] }>
  epsRequiresFourQuarters?: boolean
  ewEpsGrowth: number | null
  ewRevenueGrowth: number | null
  incrementalRoic: number | null
  returnOnEquity: number | null
  sustainableGrowth: number | null
  dividendYield: number | null
  impliedReturn: number | null
  /** Funds are valued from look-through holdings and are shown in their own table. */
  isFund?: boolean
  fundCategory?: string | null
  fundFamily?: string | null
  netAssets?: number | null
  rawNetAssets?: number | null
  expenseRatio?: number | null
  stockPosition?: number | null
  bondPosition?: number | null
  cashPosition?: number | null
  otherPosition?: number | null
  creditQuality?: string | null
  payoutRatio?: number | null
  holdingCoverage?: number | null
  fundWeightedFinancials?: {
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
  metricNotes?: Record<string, string>
  sourceLinks?: {
    quote: string
    financials: string | null
    holdings: string
    financialsLabel: string
    metricFilings?: Record<string, string>
  }
  quarters: Array<{
    end: string
    filed: string
    eps: number | null
    revenue: number | null
    dividendsPerShare: number | null
    bookValuePerShare: number | null
    operatingIncome?: number | null
    preTaxIncome?: number | null
    incomeTaxExpense?: number | null
    investedCapital?: number | null
  }>
  sourceNote: string
}

export type ChartMetric =
  | 'price' | 'relative' | 'pe' | 'yield' | 'priceToBook' | 'dividendYield' | 'impliedReturn'
  | 'priceToNetTangibleAssets'
  | 'earningsGrowth' | 'ewEpsGrowth' | 'ewRevenueGrowth' | 'sustainableGrowth' | 'incrementalRoic'
export type Range = '5d' | '1mo' | '3mo' | '6mo' | '1y' | '2y' | '5y' | '10y' | 'max'

export type CompanyProfile = {
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

export type FundWeightedFinancials = NonNullable<Fundamentals['fundWeightedFinancials']>

export type FundConstituentHolding = Fundamentals & { weight: number | null }

export type FundConstituentData = {
  holdings: FundConstituentHolding[]
  weightedMarketCap: number | null
  earningsGrowth: number | null
  ewEpsGrowth: number | null
  ewRevenueGrowth: number | null
  incrementalRoic: number | null
  holdingCoverage: number | null
  weightedFinancials: FundWeightedFinancials
  notes: Record<string, string>
}

export type FundDetailSummary = {
  fundCategory?: string | null
  fundFamily?: string | null
  netAssets?: number | null
  expenseRatio?: number | null
  stockPosition?: number | null
  bondPosition?: number | null
  cashPosition?: number | null
  otherPosition?: number | null
  creditQuality?: string | null
  holdingCoverage?: number | null
  marketCap: number | null
  pe: number | null
  priceToBook: number | null
  earningsGrowth: number | null
  ewEpsGrowth: number | null
  ewRevenueGrowth: number | null
  incrementalRoic: number | null
  returnOnEquity: number | null
  payoutRatio?: number | null
  sustainableGrowth: number | null
  dividendYield: number | null
  impliedReturn: number | null
  fundWeightedFinancials?: Fundamentals['fundWeightedFinancials']
  metricNotes?: Record<string, string>
}

export type SymbolDetail = {
  symbol: string
  name: string
  exchange: string
  fullExchange?: string
  region?: string
  currency: string
  currencyRateToUsd?: number
  price: number | null
  usdPrice?: number | null
  instrumentType: string | null
  cik: string | null
  entityName: string | null
  filingsUrl: string | null
  latestReportUrl: string | null
  latestReportForm: string | null
  fundSummary: FundDetailSummary | null
  insiderEvents: Array<{
    type: 'insider'
    date: string
    form: string
    eventClass: string
    accession: string
    filingUrl: string | null
    filingIndexUrl: string | null
  }>
  profile: CompanyProfile
  isFund: boolean
  sources: Array<{
    id: string
    label: string
    tag: string | null
    searched: string[]
    unit: string
    kind: string
    feeds: string[]
    count: number
    url: string | null
  }>
  periods: Array<{
    end: string
    filed: string | null
    form: string | null
    accession: string | null
    filingUrl: string | null
    filingIndexUrl: string | null
    fiscalYear: number | null
    fiscalPeriod: string | null
    revenue: number | null
    netIncome: number | null
    eps: number | null
    returnOnEquity: number | null
    dividendsPerShare: number | null
    payoutRatio: number | null
    operatingCashFlow: number | null
    assets: number | null
    liabilities: number | null
    liabilitiesDerived: boolean
    intangibleAssets: number | null
    preferredStock: number | null
    tangibleInputs: {
      assets: number
      liabilities: number
      liabilitiesDerived: boolean
      intangibleAssets: number
      preferredStock: number
      shares: number
      netTangibleAssetsPerShare: number | null
      assumptions: string[]
    }
    equity: number | null
    cash: number | null
    longTermDebt: number | null
    shortTermDebt: number | null
    totalDebt: number | null
    netDebt: number | null
    shares: number | null
    bookValuePerShare: number | null
    debtToEquity: number | null
  }>
}
