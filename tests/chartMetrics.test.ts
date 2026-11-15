import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isPercentMetric, lastReportAt, mergeSeries, reportEvents } from '../src/chartMetrics'
import type { Fundamentals, PricePoint } from '../src/types'

const dates = [
  '2023-01-15', '2023-04-15', '2023-07-15', '2023-10-15',
  '2024-01-15', '2024-04-15', '2024-07-15', '2024-10-15',
]
const quarters: Fundamentals['quarters'] = dates.map((filed, index) => ({
  end: filed,
  filed,
  eps: index + 1,
  revenue: (index + 1) * 10,
  dividendsPerShare: 0.25,
  bookValuePerShare: 10,
  operatingIncome: (index + 1) * 10,
  preTaxIncome: (index + 1) * 10,
  incomeTaxExpense: (index + 1) * 2,
  investedCapital: 110 + index * 10,
}))
const facts = { quarters, price: 100, dividendYield: 4, currencyRateToUsd: 1 } as Fundamentals
const history: PricePoint[] = [
  { date: '2023-01-01', price: 80 },
  { date: '2024-10-14', price: 100 },
  { date: '2024-10-16', price: 100 },
]
const value = (metric: Parameters<typeof mergeSeries>[3], date: string, item = facts) =>
  mergeSeries(['ABC'], { ABC: history }, { ABC: item }, metric).find((row) => row.date === date)?.ABC

test('daily metrics use only quarterly data filed by the price date', () => {
  assert.equal(value('priceToBook', '2024-10-16'), 10)
  assert.equal(value('dividendYield', '2024-10-16'), 1)
  assert.equal(value('impliedReturn', '2024-10-16'), 251)
  assert.equal(value('impliedReturn', '2024-10-14'), 211)
  assert.ok(Number.isNaN(value('priceToBook', '2023-01-01')))
  assert.ok(Number.isNaN(value('dividendYield', '2023-01-01')))
})

test('report metrics use separate filing-date dots, including non-trading days', () => {
  assert.equal(value('earningsGrowth', '2024-10-15'), (1 / 7) * 100)
  assert.equal(value('sustainableGrowth', '2024-10-15'), 250)
  assert.equal(value('incrementalRoic', '2024-10-15'), 320)
  assert.equal(value('earningsGrowth', '2024-10-16'), undefined)
  assert.equal(value('earningsGrowth', '2023-01-15'), undefined)
  assert.equal(value('incrementalRoic', '2024-07-15'), undefined)
  const expectedEpsGrowth = [100, 50, 100 / 3, 25, 20, 100 / 6, 100 / 7]
    .reduce((previous, current, index) => index === 0 ? current : 0.45 * current + 0.55 * previous, 0)
  assert.ok(Math.abs(Number(value('ewEpsGrowth', '2024-10-15')) - expectedEpsGrowth) < 1e-10)
  assert.ok(Math.abs(Number(value('ewRevenueGrowth', '2024-10-15')) - expectedEpsGrowth) < 1e-10)
})

test('missing inputs leave gaps rather than fabricating historical values', () => {
  const missing = { ...facts, quarters: quarters.map((quarter) => ({ ...quarter, bookValuePerShare: null, investedCapital: null })) }
  assert.ok(Number.isNaN(value('priceToBook', '2024-10-16', missing)))
  assert.equal(value('sustainableGrowth', '2024-10-15', missing), undefined)
  assert.equal(value('incrementalRoic', '2024-10-15', missing), undefined)
})

test('dividend yield does not treat unreported dividends as zero', () => {
  const missing = { ...facts, quarters: quarters.map((quarter) => ({ ...quarter, dividendsPerShare: null })) }
  assert.ok(Number.isNaN(value('dividendYield', '2024-10-16', missing)))
  assert.equal(value('impliedReturn', '2024-10-16', missing), 260)

  const incomplete = { ...facts, quarters: quarters.map((quarter, index) => ({
    ...quarter, dividendsPerShare: index === quarters.length - 1 ? null : 0.25,
  })) }
  assert.ok(Number.isNaN(value('dividendYield', '2024-10-16', incomplete)))
  assert.equal(value('dividendYield', '2024-10-14', incomplete), 1)

  const zero = { ...facts, quarters: quarters.map((quarter) => ({ ...quarter, dividendsPerShare: 0 })) }
  assert.equal(value('dividendYield', '2024-10-16', zero), 0)
  const incompleteZero = { ...zero, quarters: zero.quarters.map((quarter, index) => ({
    ...quarter, dividendsPerShare: index === zero.quarters.length - 1 ? null : 0,
  })) }
  assert.ok(Number.isNaN(value('dividendYield', '2024-10-16', incompleteZero)))
  const nonFinite = { ...facts, quarters: quarters.map((quarter, index) => ({
    ...quarter, dividendsPerShare: index === quarters.length - 1 ? Number.NaN : 0.25,
  })) }
  assert.ok(Number.isNaN(value('dividendYield', '2024-10-16', nonFinite)))
})

test('cursor uses the latest calculated report at or before its time', () => {
  const events = reportEvents(quarters, 'earningsGrowth')
  const timestamp = (date: string) => Date.parse(`${date}T00:00:00Z`)
  assert.equal(lastReportAt(events, timestamp('2023-04-14')), undefined)
  assert.equal(lastReportAt(events, timestamp('2023-04-15'))?.value, 100)
  assert.equal(lastReportAt(events, timestamp('2023-07-14'))?.date, '2023-04-15')
  assert.equal(lastReportAt(events, timestamp('2025-01-01'))?.date, '2024-10-15')
  assert.equal(lastReportAt(events, timestamp('2024-10-15'))?.value, (1 / 7) * 100)
})

test('cursor can find a report preceding the displayed range', () => {
  const shortHistory: PricePoint[] = [
    { date: '2024-11-01', price: 100 },
    { date: '2024-11-30', price: 100 },
  ]
  const rows = mergeSeries(['ABC'], { ABC: shortHistory }, { ABC: facts }, 'earningsGrowth')
  assert.ok(rows.every((row) => row.ABC === undefined))
  assert.equal(lastReportAt(reportEvents(quarters, 'earningsGrowth'), Date.parse('2024-11-15T00:00:00Z'))?.date, '2024-10-15')
})

test('price to net tangible assets uses the latest price on or before the filing date', () => {
  const item = { ...facts, tangibleAssetReports: [
    { end: '2024-06-30', date: '2024-07-15', value: -2 },
    { end: '2024-09-30', date: '2024-10-15', value: 3.5 },
  ] }
  const rows = mergeSeries(['ABC'], { ABC: history }, { ABC: item }, 'priceToNetTangibleAssets')
  assert.equal(rows.find((row) => row.date === '2024-07-15')?.ABC, undefined)
  assert.equal(rows.find((row) => row.date === '2024-10-15')?.ABC, 100 / 3.5)
  assert.equal(rows.find((row) => row.date === '2024-10-14')?.ABC, undefined)
  const events = reportEvents(quarters, 'priceToNetTangibleAssets', item.tangibleAssetReports, history)
  assert.equal(lastReportAt(events, Date.parse('2024-10-14T00:00:00Z')), undefined)
  assert.equal(isPercentMetric('priceToNetTangibleAssets'), false)
  assert.deepEqual(reportEvents(quarters, 'priceToNetTangibleAssets', [
    { end: '2024-01-01', date: '2024-01-02', value: 5 },
  ], [{ date: '2024-01-03', price: 100 }]), [])
  assert.equal(reportEvents(quarters, 'priceToNetTangibleAssets', [
    { end: '2024-01-01', date: '2024-01-02', value: 20 },
  ], [{ date: '2024-01-01', price: 100 }], 2)[0].value, 10)
})

test('existing price, relative, P/E and fund yield series remain unchanged', () => {
  assert.equal(value('price', '2024-10-16'), 100)
  assert.equal(value('relative', '2024-10-16'), 25)
  assert.equal(value('pe', '2024-10-16'), 100 / 26)
  assert.equal(value('yield', '2024-10-16'), 4)
})

test('class-specific EPS does not produce P/E from incomplete or nonconsecutive quarters', () => {
  const incomplete = { ...facts, epsRequiresFourQuarters: true, quarters: quarters.slice(-3) }
  assert.ok(Number.isNaN(value('pe', '2024-10-16', incomplete)))
  const gap = { ...facts, epsRequiresFourQuarters: true, quarters: quarters.filter((_, index) => index !== 6) }
  assert.ok(Number.isNaN(value('pe', '2024-10-16', gap)))
  assert.equal(value('pe', '2024-10-16', { ...facts, epsRequiresFourQuarters: true }), 100 / 26)
})
