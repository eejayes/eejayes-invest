import assert from 'node:assert/strict'
import { test } from 'node:test'
import { classEpsFromFiling } from '../server/filingEps'

const filing = { accession: '0000000000-26-000001', form: '10-Q', filed: '2026-11-09' }
const context = (id: string, cls: string, start = '2026-07-01', extra = '') => `
  <xbrli:context id="${id}"><xbrli:entity><xbrli:segment>
  <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">brka:EquivalentClass${cls}Member</xbrldi:explicitMember>${extra}
  </xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>${start}</xbrli:startDate>
  <xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>`
const fact = (contextRef: string, value: string, attributes = '') =>
  `<ix:nonFraction name="us-gaap:EarningsPerShareBasic" contextRef="${contextRef}" unitRef="eps" format="ixt:num-dot-decimal" ${attributes}>${value}</ix:nonFraction>`
const document = (body: string) => `<html><ix:header>
  <xbrli:unit id="eps"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:USD</xbrli:measure></xbrli:unitNumerator>
  <xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator></xbrli:divide></xbrli:unit>
  ${context('a', 'A')}${context('b', 'B')}${context('ytd', 'A', '2026-01-01')}
  </ix:header>${body}</html>`

test('reads the requested class and quarter, without substituting year-to-date EPS', () => {
  const html = document(fact('a', '15,502') + fact('b', '10.33') + fact('ytd', '40,377'))
  assert.deepEqual(classEpsFromFiling(html, filing, 'A').map((item) => item.val), [15502])
  assert.deepEqual(classEpsFromFiling(html, filing, 'B').map((item) => item.val), [10.33])
})

test('rejects conflicting, extra-dimensional, or incorrectly denominated EPS', () => {
  assert.deepEqual(classEpsFromFiling(document(fact('a', '1') + fact('a', '2')), filing, 'A'), [])
  const extra = '<xbrldi:explicitMember dimension="brka:SegmentAxis">brka:SegmentMember</xbrldi:explicitMember>'
  assert.deepEqual(classEpsFromFiling(document(context('extra', 'A', '2026-07-01', extra) + fact('extra', '1')), filing, 'A'), [])
  assert.deepEqual(classEpsFromFiling(document(fact('a', '1')).replace('iso4217:USD', 'iso4217:EUR'), filing, 'A'), [])
  assert.deepEqual(classEpsFromFiling(document(fact('a', '1', 'sign="-"')), filing, 'A').map((item) => item.val), [-1])
})
