import assert from 'node:assert/strict'
import { test } from 'node:test'
import { yahooSymbol } from '../server/yahooSymbol'
import { submittedSymbol } from '../src/symbolSearch'
import type { SearchResult } from '../src/types'

const result = (symbol: string, name: string): SearchResult => ({ symbol, name, exchange: 'test' })

test('typed ticker is not replaced by a Canadian listing with the same name', () => {
  assert.equal(submittedSymbol('tsla', [result('TSLA.NE', 'TSLA')]), 'tsla')
  assert.equal(submittedSymbol('TSLA', [result('TSLA.NE', 'Tesla'), result('TSLA', 'Tesla')]), 'TSLA')
  assert.equal(submittedSymbol('TSLA.NE', [result('TSLA.NE', 'Tesla')]), 'TSLA.NE')
  assert.equal(submittedSymbol('Tesla, Inc.', [result('TSLA', 'Tesla, Inc.')]), 'TSLA')
})

test('Yahoo requests preserve Cboe Canada suffixes and normalize share classes', () => {
  assert.equal(yahooSymbol('TSLA.NE'), 'TSLA.NE')
  assert.equal(yahooSymbol('tsla.ne'), 'tsla.ne')
  assert.equal(yahooSymbol('BRK.A'), 'BRK-A')
  assert.equal(yahooSymbol('SHOP.TO'), 'SHOP.TO')
})
