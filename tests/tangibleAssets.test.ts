import assert from 'node:assert/strict'
import { test } from 'node:test'
import { netTangibleAssetsPerShare, preferredStockValue, priceToNetTangibleAssets, totalIntangibleAssets } from '../server/tangibleAssets'

test('calculates net tangible assets per share including negative values', () => {
  assert.equal(netTangibleAssetsPerShare(1000, 100, 500, 50, 100), 3.5)
  assert.equal(netTangibleAssetsPerShare(1000, 200, 900, 0, 100), -1)
  assert.equal(netTangibleAssetsPerShare(1000, 0, 1000, 0, 100), 0)
})

test('price ratio requires positive price and positive net tangible assets per share', () => {
  assert.equal(priceToNetTangibleAssets(25, 5), 5)
  assert.equal(priceToNetTangibleAssets(25, -5), null)
  assert.equal(priceToNetTangibleAssets(25, 0), null)
  assert.equal(priceToNetTangibleAssets(25, null), null)
})

test('assumes missing balance-sheet amounts are zero but requires positive finite common shares', () => {
  assert.equal(netTangibleAssetsPerShare(null, 100, 500, 0, 100), -6)
  assert.equal(netTangibleAssetsPerShare(1000, null, 500, null, 100), 5)
  for (const inputs of [
    [1000, 100, 500, 0, null],
    [1000, 100, 500, 0, 0],
    [1000, Number.NaN, 500, 0, 100],
    [1000, 100, 500, 0, Number.NaN],
  ] as Array<Parameters<typeof netTangibleAssetsPerShare>>) {
    assert.equal(netTangibleAssetsPerShare(...inputs), null)
  }
})

test('retains reported intangibles when a component is missing', () => {
  assert.equal(totalIntangibleAssets(30, 50, 60), 30)
  assert.equal(totalIntangibleAssets(null, 50, 60), 110)
  assert.equal(totalIntangibleAssets(null, null, 60), 60)
  assert.equal(totalIntangibleAssets(null, null, null), 0)
  assert.equal(totalIntangibleAssets(null, 0, 0), 0)
  assert.equal(preferredStockValue(null, 0), 0)
  assert.equal(preferredStockValue(null, null), null)
  assert.equal(preferredStockValue(null, 100), null)
  assert.equal(preferredStockValue(50, 0), 50)
})
