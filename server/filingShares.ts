import { Parser } from 'htmlparser2'

type Filing = { accession: string; form: string; filed: string }
type Context = { end?: string; dimensions: Array<{ axis: string; member: string }> }
type ShareFact = { context: string; name: string; unit: string; scale: number; sign: string; format: string; value: string }

export function sharesFromFiling(html: string, filing: Filing) {
  const contexts = new Map<string, Context>()
  const units = new Map<string, string>()
  const facts: ShareFact[] = []
  const stack: string[] = []
  let context: (Context & { id: string }) | undefined
  let unit: { id: string; measure: string } | undefined
  let fact: ShareFact | undefined
  let member: { axis: string; value: string } | undefined
  let bodyText = ''
  let headerDepth = 0

  const parser = new Parser({
    onopentag(name, attributes) {
      name = name.toLowerCase()
      stack.push(name)
      if (name === 'ix:header') headerDepth++
      if (name === 'xbrli:context' && attributes.id) context = { id: attributes.id, dimensions: [] }
      if (context && name === 'xbrldi:explicitmember') member = { axis: attributes.dimension ?? '', value: '' }
      if (name === 'xbrli:unit' && attributes.id) unit = { id: attributes.id, measure: '' }
      if (name === 'ix:nonfraction' && attributes.name && attributes.contextref && attributes.unitref) {
        fact = {
          name: attributes.name, context: attributes.contextref, unit: attributes.unitref,
          scale: Number(attributes.scale ?? 0), sign: attributes.sign ?? '',
          format: (attributes.format ?? '').toLowerCase(), value: '',
        }
      }
    },
    ontext(text) {
      const current = stack.at(-1)
      if (!headerDepth) bodyText += ` ${text}`
      if (context && current === 'xbrli:instant') context.end = (context.end ?? '') + text.trim()
      if (member && current === 'xbrldi:explicitmember') member.value += text.trim()
      if (unit && current === 'xbrli:measure') unit.measure += text.trim()
      if (fact) fact.value += text
    },
    onclosetag(name) {
      name = name.toLowerCase()
      if (name === 'xbrldi:explicitmember' && context && member) {
        context.dimensions.push({ axis: member.axis, member: member.value })
        member = undefined
      }
      if (name === 'xbrli:context' && context) {
        contexts.set(context.id, context)
        context = undefined
      }
      if (name === 'xbrli:unit' && unit) {
        units.set(unit.id, unit.measure)
        unit = undefined
      }
      if (name === 'ix:nonfraction' && fact) {
        facts.push(fact)
        fact = undefined
      }
      if (name === 'ix:header') headerDepth--
      stack.pop()
    },
  }, { decodeEntities: true })
  parser.end(html)

  const text = bodyText.replace(/\s+/g, ' ')
  const byEnd = new Map<string, Map<string, Map<string, number>>>()
  const extraClassDimensions = new Map<string, Map<string, Set<string>>>()
  const reportedTotals = new Map<string, number>()
  const hasUndividedEps = facts.some((item) =>
    /^us-gaap:earningspershare(?:basic|diluted|basicanddiluted)$/i.test(item.name) &&
    contexts.get(item.context)?.dimensions.length === 0,
  )
  for (const item of facts) {
    const tag = item.name.toLowerCase()
    if (tag !== 'us-gaap:commonstocksharesoutstanding' && tag !== 'dei:entitycommonstocksharesoutstanding') continue
    if (!/(^|:)shares$/i.test(units.get(item.unit) ?? '')) continue
    const period = contexts.get(item.context)
    if (!period?.end || item.sign === '-' || !Number.isInteger(item.scale) || Math.abs(item.scale) > 12) continue
    if (item.format && !/(?:num-dot-decimal|fixed-zero)$/i.test(item.format)) continue
    const numericText = item.value.trim().replace(/,/g, '')
    if (!/fixed-zero$/i.test(item.format) && !/^\d+(?:\.\d+)?$/.test(numericText)) continue
    const number = /fixed-zero$/i.test(item.format) ? 0 : Number(numericText)
    const value = number * 10 ** item.scale
    if (!Number.isSafeInteger(value) || value < 0) continue
    if (period.dimensions.length > 1) {
      const classDimension = period.dimensions.find((dimension) => /(^|:)statementclassofstockaxis$/i.test(dimension.axis))
      const className = classDimension?.member.match(/(?:^|:)CommonClass([A-Z])Member$/i)?.[1]?.toUpperCase()
      if (className && value > 0) {
        const groups = extraClassDimensions.get(period.end) ?? new Map<string, Set<string>>()
        const classes = groups.get(tag) ?? new Set<string>()
        classes.add(className)
        groups.set(tag, classes)
        extraClassDimensions.set(period.end, groups)
      }
      continue
    }
    if (period.dimensions.length !== 1) continue
    const dimension = period.dimensions[0]
    if (tag === 'us-gaap:commonstocksharesoutstanding' && hasUndividedEps &&
        /(^|:)statementequitycomponentsaxis$/i.test(dimension.axis) &&
        /(^|:)commonstockincludingadditionalpaidincapitalmember$/i.test(dimension.member)) {
      const existing = reportedTotals.get(period.end)
      reportedTotals.set(period.end, existing != null && existing !== value ? NaN : value)
      continue
    }
    if (!/(^|:)statementclassofstockaxis$/i.test(dimension.axis)) continue
    const match = dimension.member.match(/(?:^|:)CommonClass([A-Z])Member$/i)
    if (!match) continue
    const groups = byEnd.get(period.end) ?? new Map<string, Map<string, number>>()
    const classes = groups.get(tag) ?? new Map<string, number>()
    const className = match[1].toUpperCase()
    const existing = classes.get(className)
    if (existing != null && existing !== value) classes.set(className, NaN)
    else classes.set(className, value)
    groups.set(tag, classes)
    byEnd.set(period.end, groups)
  }

  const ends = [...new Set([...byEnd.keys(), ...reportedTotals.keys()])]
  return ends.flatMap((end) => {
    const total = reportedTotals.get(end)
    if (total != null && Number.isSafeInteger(total) && total > 0) {
      return [{ end, val: total, form: filing.form, filed: filing.filed, accn: filing.accession }]
    }
    const groups = byEnd.get(end)
    for (const tag of ['us-gaap:commonstocksharesoutstanding', 'dei:entitycommonstocksharesoutstanding']) {
      const classes = groups?.get(tag)
      if (!classes?.has('A') || [...classes.values()].some((value) => !Number.isFinite(value))) continue
      if ([...(extraClassDimensions.get(end)?.get(tag) ?? [])].some((className) => !classes.has(className))) continue
      const convertible = [...classes].every(([letter, value]) => {
        if (letter === 'A' || value === 0) return true
        const pattern = new RegExp(
          `each share of class ${letter}(?: common stock)? is convertible\\b[^.]{0,180}\\b(?:into|for) one share of class A\\b`,
          'i',
        )
        return pattern.test(text)
      })
      if (!convertible) continue
      const val = [...classes.values()].reduce((sum, value) => sum + value, 0)
      if (Number.isSafeInteger(val) && val > 0) return [{ end, val, form: filing.form, filed: filing.filed, accn: filing.accession }]
    }
    return []
  }).sort((a, b) => a.end.localeCompare(b.end))
}
