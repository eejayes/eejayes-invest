import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sharesFromFiling } from '../server/filingShares'

const filing = { accession: '0000000000-26-000001', form: '10-Q', filed: '2026-10-22' }
const context = (id: string, member: string, end = '2026-09-30', extra = '') => `
  <xbrli:context id="${id}"><xbrli:entity><xbrli:segment>
    <xbrldi:explicitMember dimension="us-gaap:StatementClassOfStockAxis">us-gaap:CommonClass${member}Member</xbrldi:explicitMember>
    ${extra}
  </xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>${end}</xbrli:instant></xbrli:period></xbrli:context>`
const fact = (contextRef: string, value: string, scale = 0) => `
  <ix:nonFraction name="us-gaap:CommonStockSharesOutstanding" unitRef="shares" contextRef="${contextRef}"
    format="ixt:num-dot-decimal" scale="${scale}">${value}</ix:nonFraction>`
const document = (body: string, conversion = 'Each share of Class B is convertible at the option of the holder, at any time, into one share of Class A.') => `
  <html><body><ix:header><xbrli:unit id="shares"><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unit>
  ${context('a', 'A')}${context('b', 'B')}${context('c', 'C')}
  </ix:header><p>${conversion}</p>${body}</body></html>`

test('sums same-date common classes when conversion is one-for-one', () => {
  const html = document(fact('a', '8,240', 6) + fact('b', '5,339', 6) + fact('c', '0'))
  assert.deepEqual(sharesFromFiling(html, filing), [{
    end: '2026-09-30', val: 13_579_000_000, form: filing.form, filed: filing.filed, accn: filing.accession,
  }])
})

test('does not combine unequal, unspecified, duplicate-conflicting, or further-dimensional classes', () => {
  const base = fact('a', '100') + fact('b', '50')
  assert.deepEqual(sharesFromFiling(document(base, 'One share of Class A converts into 1,500 shares of Class B.'), filing), [])
  assert.deepEqual(sharesFromFiling(document(base, ''), filing), [])
  assert.deepEqual(sharesFromFiling(document(base + fact('b', '51')), filing), [])
  assert.deepEqual(sharesFromFiling(document(base + fact('c', '10')), filing), [])
  const extra = '<xbrldi:explicitMember dimension="example:SegmentAxis">example:SegmentMember</xbrldi:explicitMember>'
  assert.deepEqual(sharesFromFiling(document(base + context('d', 'C', '2026-09-30', extra) + fact('d', '10')), filing), [])
  assert.equal(sharesFromFiling(document(base + context('d', 'C', '2026-09-30', extra) + fact('d', '0')), filing)[0].val, 150)
  assert.deepEqual(sharesFromFiling(document(fact('a', '') + fact('b', '50')), filing), [])
})

test('uses a reported consolidated common-share total rather than class guesses', () => {
  const totalContext = `<xbrli:context id="total"><xbrli:entity><xbrli:segment>
    <xbrldi:explicitMember dimension="us-gaap:StatementEquityComponentsAxis">us-gaap:CommonStockIncludingAdditionalPaidInCapitalMember</xbrldi:explicitMember>
    </xbrli:segment></xbrli:entity><xbrli:period><xbrli:instant>2026-09-30</xbrli:instant></xbrli:period></xbrli:context>`
  const epsContext = '<xbrli:context id="eps"><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>'
  const html = document(totalContext + epsContext + fact('total', '250') +
    '<ix:nonFraction name="us-gaap:EarningsPerShareBasic" unitRef="usd-per-share" contextRef="eps">1.2</ix:nonFraction>', '')
  assert.equal(sharesFromFiling(html, filing)[0].val, 250)
  assert.deepEqual(sharesFromFiling(html.replace('us-gaap:EarningsPerShareBasic', 'us-gaap:NetIncomeLoss'), filing), [])
})
