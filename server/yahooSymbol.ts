export function yahooSymbol(symbol: string) {
  if (/\.(L|PA|AX|KS|KQ|T|MC|SW|DE|MI|HK|TO|V|NE|ST|CO|AS|BR|LS|VI|IR|HE|NZ|SA|SG|JK|BK|TW|TWO|SS|SZ)$/i.test(symbol)) {
    return symbol
  }
  return symbol.replace(/\./g, '-')
}
