import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { test } from 'node:test'

test('bank revenue is used for growth and reported consistently in source details', async (t) => {
  const listener = createServer()
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve))
  const address = listener.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((resolve, reject) => listener.close((error) => error ? reject(error) : resolve()))

  const mockUpstream = `
    const row = (start, end, val, filed) => ({
      start, end, val, filed, form: '10-Q', accn: '0001628280-26-069523'
    })
    const fact = (rows) => ({ label: 'Revenue', units: { USD: rows } })
    const bank = {
      cik: 19617, entityName: 'JPMORGAN CHASE & CO.',
      facts: { 'us-gaap': {
        Revenues: fact([row('2014-07-01', '2014-09-30', 24246000000, '2014-11-03')]),
        RevenuesNetOfInterestExpense: fact([
          row('2026-01-01', '2026-03-31', 49836000000, '2026-05-01'),
          row('2026-04-01', '2026-06-30', 57347000000, '2026-08-06'),
          row('2026-07-01', '2026-09-30', 50172000000, '2026-11-03')
        ])
      } }
    }
    const company = {
      cik: 123, entityName: 'Example Company',
      facts: { 'us-gaap': {
        RevenueFromContractWithCustomerExcludingAssessedTax: fact([
          row('2026-04-01', '2026-06-30', 100, '2026-08-06'),
          row('2026-07-01', '2026-09-30', 120, '2026-11-03')
        ]),
        RevenuesNetOfInterestExpense: fact([
          row('2026-07-01', '2026-09-30', 999, '2026-11-03')
        ]),
        Assets: fact([
          row(undefined, '2026-06-30', 1000, '2026-08-06'),
          row(undefined, '2026-09-30', 1200, '2026-11-03')
        ]),
        Liabilities: fact([
          row(undefined, '2026-06-30', 500, '2026-08-06'),
          row(undefined, '2026-09-30', 550, '2026-11-03')
        ]),
        GoodwillAndIntangibleAssetsNet: fact([
          row(undefined, '2026-06-30', 100, '2026-08-06'),
          row(undefined, '2026-09-30', 200, '2026-11-05')
        ]),
        PreferredStockValue: fact([
          row(undefined, '2026-06-30', 50, '2026-08-06'),
          row(undefined, '2026-09-30', 50, '2026-11-03')
        ]),
        CommonStockSharesOutstanding: { label:'Shares', units:{shares:[
          row(undefined, '2026-06-30', 100, '2026-08-06'),
          row(undefined, '2026-09-30', 100, '2026-11-03')
        ]} }
      } }
    }
    const classShares = {
      cik: '0000000321', entityName: 'Class Shares Company',
      facts: { 'us-gaap': {
        Revenues: fact([row('2026-07-01', '2026-09-30', 100, '2026-11-03')]),
        StockholdersEquity: fact([{end:'2026-09-30', val:3000, filed:'2026-11-03', form:'10-Q', accn:'0000000000-26-000001'}]),
        Assets: fact([row(undefined, '2026-09-30', 1000, '2026-11-03')]),
        StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest: fact([row(undefined, '2026-09-30', 400, '2026-11-03')]),
        Goodwill: fact([row(undefined, '2026-09-30', 100, '2026-11-03')]),
        IntangibleAssetsNetExcludingGoodwill: fact([row(undefined, '2026-09-30', 50, '2026-11-03')]),
        PreferredStockSharesOutstanding: { label:'Preferred shares', units:{shares:[row(undefined, '2026-09-30', 0, '2026-11-03')] } }
      } }
    }
    const negativeBook = {
      cik: 456, entityName: 'Negative Book Company',
      facts: { 'us-gaap': {
        Revenues: fact([row('2026-07-01', '2026-09-30', 100, '2026-11-03')]),
        StockholdersEquity: fact([{end:'2026-09-30', val:-100, filed:'2026-11-03', form:'10-Q', accn:'0000000000-26-000001'}])
      } }
    }
    const zeroEps = {
      cik: 789, entityName: 'Zero EPS Company',
      facts: { 'us-gaap': {
        EarningsPerShareDiluted: { label:'EPS', units:{'USD/shares':[
          {...row('2026-04-01', '2026-06-30', 0, '2026-08-03'), accn:'0000000000-26-000002'},
          row('2026-07-01', '2026-09-30', 1, '2026-11-03')
        ]} }
      } }
    }
    const missingInputs = {
      cik: 999, entityName: 'Missing Inputs Company',
      facts: { 'us-gaap': {
        Revenues: fact([row('2026-07-01', '2026-09-30', 100, '2026-11-03')]),
        Assets: fact([row(undefined, '2026-09-30', 1000, '2026-11-03')]),
        Liabilities: fact([row(undefined, '2026-09-30', 500, '2026-11-03')]),
        Goodwill: fact([row(undefined, '2026-09-30', 100, '2026-11-03')]),
        CommonStockSharesOutstanding: {label:'Shares', units:{shares:[row(undefined, '2026-09-30', 100, '2026-11-03')]}}
      } }
    }
    const missingAssets = {
      cik: 998, entityName: 'Missing Assets Company',
      facts: { 'us-gaap': {
        Revenues: fact([row('2026-07-01', '2026-09-30', 100, '2026-11-03')]),
        Liabilities: fact([row(undefined, '2026-09-30', 500, '2026-11-03')]),
        CommonStockSharesOutstanding: {label:'Shares', units:{shares:[row(undefined, '2026-09-30', 100, '2026-11-03')]}}
      } }
    }
    const preferredMissing = {
      cik: 997, entityName: 'Preferred Missing Company',
      facts: { 'us-gaap': { ...missingInputs.facts['us-gaap'],
        IntangibleAssetsNetExcludingGoodwill: fact([row(undefined, '2026-09-30', 0, '2026-11-03')])
      } }
    }
    const preferredMissingNegative = {
      cik: 996, entityName: 'Preferred Missing Negative Company',
      facts: { 'us-gaap': { ...preferredMissing.facts['us-gaap'],
        Liabilities: fact([row(undefined, '2026-09-30', 1000, '2026-11-03')])
      } }
    }
    const berkshire = {
      cik: 1067983, entityName: 'Berkshire Hathaway Inc.',
      facts: { 'us-gaap': {
        Revenues: fact([row('2026-07-01', '2026-09-30', 100, '2026-11-09')]),
        EarningsPerShareBasic: { label:'EPS', units:{'USD/shares':[
          row('2013-07-01', '2013-09-30', 3074, '2013-11-01')
        ]} }
      } }
    }
    const berkshireHtml = '<html><ix:header>' +
      '<xbrli:unit id="eps"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator>' +
      '<xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>' +
      ['A','B'].map(c => '<xbrli:context id="' + c + '"><xbrli:entity><xbrli:segment>' +
        '<xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">brka:EquivalentClass' + c + 'Member</xbrldi:explicitMember>' +
        '</xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>').join('') +
      '</ix:header><ix:nonFraction name="us-gaap:EarningsPerShareBasic" unitRef="eps" contextRef="A">15,502</ix:nonFraction>' +
      '<ix:nonFraction name="us-gaap:EarningsPerShareBasic" unitRef="eps" contextRef="B">10.33</ix:nonFraction></html>'
    const html = '<html><body><ix:header>' +
      '<xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>' +
      ['A','B'].map(c => '<xbrli:context id="' + c + '"><xbrli:entity><xbrli:segment>' +
        '<xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClass' + c + 'Member</xbrldi:explicitMember>' +
        '</xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-09-30</xbrli:instant></xbrli:period></xbrli:context>').join('') +
      '</ix:header><p>Each share of Class B is convertible into one share of Class A.</p>' +
      '<ix:nonFraction name="us-gaap:CommonStockSharesOutstanding" unitRef="shares" contextRef="A">100</ix:nonFraction>' +
      '<ix:nonFraction name="us-gaap:CommonStockSharesOutstanding" unitRef="shares" contextRef="B">50</ix:nonFraction>' +
      '</body></html>'
    globalThis.fetch = async (input) => {
      const url = String(input)
      let data
      if (url.includes('company_tickers.json')) data = {
        0: { cik_str: 19617, ticker: 'JPM-MD', title: 'JPMORGAN CHASE & CO.' },
        1: { cik_str: 123, ticker: 'ABC', title: 'Example Company' },
        2: { cik_str: 321, ticker: 'DCLS', title: 'Class Shares Company' },
        3: { cik_str: 456, ticker: 'NEG', title: 'Negative Book Company' },
        4: { cik_str: 789, ticker: 'ZERO', title: 'Zero EPS Company' },
        5: { cik_str: 1067983, ticker: 'BRK-A', title: 'Berkshire Hathaway Inc.' },
        6: { cik_str: 1067983, ticker: 'BRK-B', title: 'Berkshire Hathaway Inc.' },
        7: { cik_str: 999, ticker: 'MISS', title: 'Missing Inputs Company' },
        8: { cik_str: 998, ticker: 'NOASSET', title: 'Missing Assets Company' },
        9: { cik_str: 997, ticker: 'PREFMISS', title: 'Preferred Missing Company' },
        10: { cik_str: 996, ticker: 'PREFNEG', title: 'Preferred Missing Negative Company' }
      }
      else if (url.includes('companyfacts/CIK0000019617')) data = bank
      else if (url.includes('companyfacts/CIK0000000123')) data = company
      else if (url.includes('companyfacts/CIK0000000321')) data = classShares
      else if (url.includes('companyfacts/CIK0000000456')) data = negativeBook
      else if (url.includes('companyfacts/CIK0000000789')) data = zeroEps
      else if (url.includes('companyfacts/CIK0001067983')) data = berkshire
      else if (url.includes('companyfacts/CIK0000000999')) data = missingInputs
      else if (url.includes('companyfacts/CIK0000000998')) data = missingAssets
      else if (url.includes('companyfacts/CIK0000000997')) data = preferredMissing
      else if (url.includes('companyfacts/CIK0000000996')) data = preferredMissingNegative
      else if (url.includes('/v8/finance/chart/')) data = {
        chart: { result: [{ meta: { regularMarketPrice: 25, currency: 'USD', exchangeName: 'NYQ' } }] }
      }
      else if (url.includes('/submissions/CIK0000000321')) data = {
        filings: { recent: { accessionNumber:['0000000000-26-000001'], primaryDocument:['filing.htm'],
          form:['10-Q'], isInlineXBRL:[1], reportDate:['2026-09-30'], filingDate:['2026-11-03'] } }
      }
      else if (url.includes('/submissions/CIK0000000456')) data = {
        filings: { recent: { accessionNumber:['0000000000-26-000001'], primaryDocument:['negative.htm'],
          form:['10-Q'], isInlineXBRL:[0], reportDate:['2026-09-30'], filingDate:['2026-11-03'] } }
      }
      else if (url.includes('/submissions/CIK0000000789')) data = {
        filings: { recent: { accessionNumber:['0000000000-26-000002'], primaryDocument:['prior.htm'],
          form:['10-Q'], isInlineXBRL:[0], reportDate:['2026-06-30'], filingDate:['2026-08-03'] } }
      }
      else if (url.includes('/submissions/CIK0001067983')) data = {
        filings: { recent: { accessionNumber:['0001193125-26-452412'], primaryDocument:['brka.htm'],
          form:['10-Q'], isInlineXBRL:[1], reportDate:['2026-09-30'], filingDate:['2026-11-09'] } }
      }
      else if (url.includes('/Archives/edgar/data/321/')) return new Response(html)
      else if (url.includes('/Archives/edgar/data/1067983/')) return new Response(berkshireHtml)
      else if (url.includes('/submissions/')) data = {}
      else if (url === 'https://fc.yahoo.com') return new Response('', {headers:{'set-cookie':'test=1'}})
      else if (url.includes('/v1/test/getcrumb')) return new Response('test-crumb')
      else if (url.includes('/quoteSummary/FOREIGN')) data = {
        quoteSummary: { result: [{ defaultKeyStatistics: { priceToBook:{raw:-2}, bookValue:{raw:-10} } }] }
      }
      else if (url.includes('/quoteSummary/FORVAL')) data = {
        quoteSummary: { result: [{
          defaultKeyStatistics: { sharesOutstanding: {raw:100} },
          balanceSheetHistoryQuarterly: { balanceSheetStatements: [{
            endDate: {fmt:'2026-09-30'}, totalAssets:{raw:1000}, totalLiab:{raw:500}, goodWill:{raw:100}
          }] }
        }] }
      }
      else return new Response('', { status: 404 })
      return Response.json(data)
    }
    await import('./server/index.ts')
  `
  const server = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', mockUpstream], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port) },
    stdio: 'ignore',
  })
  t.after(() => server.kill())

  let ready = false
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok
      if (ready) break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  assert.ok(ready, 'API server did not start')

  const fundamentals = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/JPM-MD`)).json()
  assert.equal(fundamentals.quarters.at(-1).revenue, 50_172_000_000)
  assert.equal(fundamentals.quarters.filter((quarter: { revenue: number | null }) => quarter.revenue != null).length, 3)
  assert.ok(Number.isFinite(fundamentals.ewRevenueGrowth))
  assert.equal(fundamentals.metricNotes.ewRevenueGrowth, undefined)

  const detail = await (await fetch(`http://127.0.0.1:${port}/api/detail/JPM-MD`)).json()
  const source = detail.sources.find((item: { id: string }) => item.id === 'revenue')
  assert.equal(source.tag, 'us-gaap:RevenuesNetOfInterestExpense')
  assert.equal(source.count, 3)
  assert.equal(detail.periods.at(-1).revenue, 50_172_000_000)

  const standard = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/ABC`)).json()
  assert.equal(standard.quarters.at(-1).revenue, 120)
  assert.equal(standard.netTangibleAssetsPerShare, 4)
  assert.equal(standard.priceToNetTangibleAssets, 6.25)
  assert.deepEqual(standard.tangibleAssetReports, [
    { end: '2026-06-30', date: '2026-08-06', value: 3.5, assumptions: [] },
    { end: '2026-09-30', date: '2026-11-05', value: 4, assumptions: [] },
  ])
  const standardDetail = await (await fetch(`http://127.0.0.1:${port}/api/detail/ABC`)).json()
  assert.equal(standardDetail.sources.find((item: { id: string }) => item.id === 'revenue').tag, 'us-gaap:RevenueFromContractWithCustomerExcludingAssessedTax')
  assert.equal(standardDetail.periods.at(-1).intangibleAssets, 200)
  assert.equal(standardDetail.periods.at(-1).liabilities, 550)
  assert.equal(standardDetail.periods.at(-1).preferredStock, 50)
  assert.equal(standardDetail.sources.find((item: { id: string }) => item.id === 'intangibleAssets').tag, 'us-gaap:GoodwillAndIntangibleAssetsNet')

  const classes = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/DCLS`)).json()
  assert.equal(classes.priceToBook, 1.25)
  assert.equal(classes.marketCap, 3750)
  assert.equal(classes.quarters.at(-1).bookValuePerShare, 20)
  assert.equal(classes.netTangibleAssetsPerShare, 250 / 150)
  const classesDetail = await (await fetch(`http://127.0.0.1:${port}/api/detail/DCLS`)).json()
  const shareSource = classesDetail.sources.find((item: { id: string }) => item.id === 'shares')
  assert.equal(shareSource.tag, 'Common shares from SEC filing')
  assert.equal(shareSource.url, null)
  assert.equal(classesDetail.periods.at(-1).shares, 150)
  assert.equal(classesDetail.periods.at(-1).intangibleAssets, 150)
  assert.equal(classesDetail.periods.at(-1).liabilities, 600)
  assert.equal(classesDetail.periods.at(-1).preferredStock, 0)

  const negative = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/NEG`)).json()
  assert.equal(negative.priceToBook, null)
  assert.equal(negative.netTangibleAssetsPerShare, null)
  assert.match(negative.metricNotes.netTangibleAssetsPerShare, /positive common shares/)
  assert.match(negative.metricNotes.priceToBook, /book value.*negative/i)
  assert.equal(negative.sourceLinks.metricFilings.priceToBook, 'https://www.sec.gov/Archives/edgar/data/456/000000000026000001/negative.htm')
  assert.equal(negative.sourceLinks.metricFilings.ewRevenueGrowth, undefined)
  const zero = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/ZERO`)).json()
  assert.equal(zero.earningsGrowth, null)
  assert.equal(zero.sourceLinks.metricFilings.earningsGrowth, 'https://www.sec.gov/Archives/edgar/data/789/000000000026000002/prior.htm')
  const foreign = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/FOREIGN`)).json()
  assert.equal(foreign.priceToBook, null)
  assert.match(foreign.metricNotes.priceToBook, /book value.*negative/i)
  const missing = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/MISS`)).json()
  assert.equal(missing.netTangibleAssetsPerShare, 4)
  assert.equal(missing.priceToNetTangibleAssets, 6.25)
  assert.equal(missing.metricNotes.priceToNetTangibleAssets, 'Assumed zero for unreported other intangible assets.')
  assert.match(missing.metricNotes.netTangibleAssetsPerShare, /other intangible assets, preferred stock/)
  assert.deepEqual(missing.tangibleAssetReports[0].assumptions, ['other intangible assets', 'preferred stock'])
  const missingDetail = await (await fetch(`http://127.0.0.1:${port}/api/detail/MISS`)).json()
  assert.equal(missingDetail.periods.at(-1).tangibleInputs.intangibleAssets, 100)
  assert.equal(missingDetail.periods.at(-1).tangibleInputs.preferredStock, 0)
  assert.equal(missingDetail.periods.at(-1).tangibleInputs.netTangibleAssetsPerShare, 4)
  assert.deepEqual(missingDetail.periods.at(-1).tangibleInputs.assumptions, ['other intangible assets', 'preferred stock'])
  const noAssets = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/NOASSET`)).json()
  assert.equal(noAssets.netTangibleAssetsPerShare, -5)
  assert.equal(noAssets.priceToNetTangibleAssets, null)
  assert.match(noAssets.metricNotes.priceToNetTangibleAssets, /negative/)
  assert.doesNotMatch(noAssets.metricNotes.priceToNetTangibleAssets, /preferred stock|ratio is unavailable/)
  assert.equal(noAssets.tangibleAssetReports[0].value, -5)
  assert.match(noAssets.metricNotes.netTangibleAssetsPerShare, /total assets/)
  const yahooValue = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/FORVAL`)).json()
  assert.equal(yahooValue.netTangibleAssetsPerShare, 4)
  assert.match(yahooValue.metricNotes.netTangibleAssetsPerShare, /other intangible assets, preferred stock/)
  const yahooDetail = await (await fetch(`http://127.0.0.1:${port}/api/detail/FORVAL`)).json()
  assert.equal(yahooDetail.periods.at(-1).tangibleInputs.intangibleAssets, 100)
  assert.equal(yahooDetail.periods.at(-1).tangibleInputs.preferredStock, 0)
  const prefOnly = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/PREFMISS`)).json()
  assert.equal(prefOnly.priceToNetTangibleAssets, 6.25)
  assert.equal(prefOnly.metricNotes.priceToNetTangibleAssets, undefined)
  assert.match(prefOnly.metricNotes.netTangibleAssetsPerShare, /preferred stock/)
  const prefNegative = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/PREFNEG`)).json()
  assert.equal(prefNegative.metricNotes.priceToNetTangibleAssets, 'Net tangible assets per share is negative.')
  for (const [symbol, eps] of [['BRK-A', 15502], ['BRK-B', 10.33]] as const) {
    const berkshire = await (await fetch(`http://127.0.0.1:${port}/api/fundamentals/${symbol}`)).json()
    assert.equal(berkshire.quarters.at(-1).eps, eps)
    assert.equal(berkshire.pe, null)
    assert.match(berkshire.metricNotes.pe, /four consecutive/)
    const detail = await (await fetch(`http://127.0.0.1:${port}/api/detail/${symbol}`)).json()
    assert.equal(detail.periods.at(-1).eps, eps)
    assert.match(detail.sources.find((source: { id: string }) => source.id === 'epsDiluted').tag, /Class [AB] EPS from SEC filing/)
  }
})
