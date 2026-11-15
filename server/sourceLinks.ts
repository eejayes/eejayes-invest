export function sourceLinks(yahooTicker: string, cik?: number | null, secSource = false) {
  const quote = `https://finance.yahoo.com/quote/${encodeURIComponent(yahooTicker)}`
  const secFilings = cik != null && Number.isSafeInteger(cik) && cik > 0
    ? `https://www.sec.gov/edgar/browse/?CIK=${cik}`
    : null
  return {
    quote,
    financials: secSource ? secFilings : `${quote}/financials/`,
    holdings: `${quote}/holdings/`,
    financialsLabel: secSource ? 'SEC company filings' : 'Yahoo Finance financials',
  }
}
