import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sourceLinks } from '../server/sourceLinks'
import { missingMetricSource } from '../src/metricSources'
import type { Fundamentals } from '../src/types'

test('SEC financial links use the actual CIK and fall back to Yahoo when absent', () => {
  const sec = sourceLinks('BRK-B', 1067983, true)
  assert.equal(sec.financials, 'https://www.sec.gov/edgar/browse/?CIK=1067983')
  assert.equal(sec.financialsLabel, 'SEC company filings')
  assert.equal(sourceLinks('VOD.L', null).financials, 'https://finance.yahoo.com/quote/VOD.L/financials/')
  assert.equal(sourceLinks('ABC', NaN, true).financials, null)
})

test('missing company metrics link to their financial or price source', () => {
  const item = { sourceLinks: sourceLinks('ABC', 42, true), sustainableGrowth: 5, dividendYield: null } as Fundamentals
  assert.equal(missingMetricSource(item, 'pe')?.label, 'SEC company filings')
  assert.equal(missingMetricSource(item, 'dividendYield')?.label, 'Yahoo Finance')
  assert.equal(missingMetricSource(item, 'impliedReturn')?.label, 'Yahoo Finance')
  assert.equal(missingMetricSource({} as Fundamentals, 'pe'), undefined)
})

test('specific metric filings take precedence without changing multi-filing fallbacks', () => {
  const filing = 'https://www.sec.gov/Archives/edgar/data/42/example/report.htm'
  const item = { sourceLinks: { ...sourceLinks('ABC', 42, true), metricFilings: { priceToBook: filing } } } as Fundamentals
  assert.deepEqual(missingMetricSource(item, 'priceToBook'), { url: filing, label: 'SEC filing' })
  assert.equal(missingMetricSource(item, 'ewRevenueGrowth')?.label, 'SEC company filings')
})

test('missing fund look-through metrics link to holdings, other metrics to the quote', () => {
  const item = { isFund: true, sourceLinks: sourceLinks('SPY') } as Fundamentals
  assert.equal(missingMetricSource(item, 'earningsGrowth')?.url, 'https://finance.yahoo.com/quote/SPY/holdings/')
  assert.equal(missingMetricSource(item, 'expenseRatio')?.url, 'https://finance.yahoo.com/quote/SPY')
})
