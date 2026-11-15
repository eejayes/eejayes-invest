import { Parser } from 'htmlparser2'

type Filing = { accession: string; form: string; filed: string }
type Context = { start: string; end: string; dimensions: Array<{ axis: string; member: string }> }
type Unit = { numerator: string[]; denominator: string[] }
type EpsFact = { name: string; context: string; unit: string; scale: number; sign: string; format: string; value: string }

export function classEpsFromFiling(html: string, filing: Filing, className: 'A' | 'B') {
  const contexts = new Map<string, Context>()
  const units = new Map<string, Unit>()
  const facts: EpsFact[] = []
  const stack: string[] = []
  let context: (Context & { id: string }) | undefined
  let unit: (Unit & { id: string }) | undefined
  let member: { axis: string; member: string } | undefined
  let fact: EpsFact | undefined
  const parser = new Parser({
    onopentag(name, attributes) {
      name = name.toLowerCase()
      stack.push(name)
      if (name === 'xbrli:context' && attributes.id) context = { id: attributes.id, start: '', end: '', dimensions: [] }
      if (context && name === 'xbrldi:explicitmember') member = { axis: attributes.dimension ?? '', member: '' }
      if (name === 'xbrli:unit' && attributes.id) unit = { id: attributes.id, numerator: [], denominator: [] }
      if (name === 'ix:nonfraction' && attributes.name && attributes.contextref && attributes.unitref &&
          /^us-gaap:earningspershare(?:basic|diluted|basicanddiluted)$/i.test(attributes.name)) {
        fact = {
          name: attributes.name.toLowerCase(), context: attributes.contextref, unit: attributes.unitref,
          scale: Number(attributes.scale ?? 0), sign: attributes.sign ?? '',
          format: (attributes.format ?? '').toLowerCase(), value: '',
        }
      }
    },
    ontext(text) {
      const current = stack.at(-1)
      if (context && current === 'xbrli:startdate') context.start += text.trim()
      if (context && current === 'xbrli:enddate') context.end += text.trim()
      if (member && current === 'xbrldi:explicitmember') member.member += text.trim()
      if (unit && current === 'xbrli:measure') {
        const measure = text.trim()
        if (measure) (stack.includes('xbrli:unitdenominator') ? unit.denominator : unit.numerator).push(measure)
      }
      if (fact) fact.value += text
    },
    onclosetag(name) {
      name = name.toLowerCase()
      if (name === 'xbrldi:explicitmember' && context && member) {
        context.dimensions.push(member)
        member = undefined
      }
      if (name === 'xbrli:context' && context) { contexts.set(context.id, context); context = undefined }
      if (name === 'xbrli:unit' && unit) { units.set(unit.id, unit); unit = undefined }
      if (name === 'ix:nonfraction' && fact) { facts.push(fact); fact = undefined }
      stack.pop()
    },
  }, { decodeEntities: true })
  parser.end(html)

  const byEnd = new Map<string, Map<string, { start: string; val: number }>>()
  for (const item of facts) {
    const period = contexts.get(item.context)
    const unit = units.get(item.unit)
    if (!period || period.dimensions.length !== 1 || !unit ||
        !/(^|:)statementclassofstockaxis$/i.test(period.dimensions[0].axis) ||
        !new RegExp(`(^|:)EquivalentClass${className}Member$`, 'i').test(period.dimensions[0].member) ||
        unit.numerator.length !== 1 || !/(^|:)USD$/i.test(unit.numerator[0]) ||
        unit.denominator.length !== 1 || !/(^|:)shares$/i.test(unit.denominator[0])) continue
    const days = (Date.parse(period.end) - Date.parse(period.start)) / 86_400_000
    if (!(days >= 50 && days < 150) || !Number.isInteger(item.scale) || Math.abs(item.scale) > 12 ||
        (item.sign !== '' && item.sign !== '-') || (item.format && !/(?:num-dot-decimal|fixed-zero)$/i.test(item.format))) continue
    const text = item.value.trim().replace(/,/g, '')
    if (!/fixed-zero$/i.test(item.format) && !/^\d+(?:\.\d+)?$/.test(text)) continue
    const value = (/fixed-zero$/i.test(item.format) ? 0 : Number(text)) * 10 ** item.scale * (item.sign === '-' ? -1 : 1)
    if (!Number.isFinite(value)) continue
    const tags = byEnd.get(period.end) ?? new Map<string, { start: string; val: number }>()
    const existing = tags.get(item.name)
    tags.set(item.name, { start: period.start, val: existing && (existing.val !== value || existing.start !== period.start) ? NaN : value })
    byEnd.set(period.end, tags)
  }
  return [...byEnd].flatMap(([end, tags]) => {
    const selected = tags.get('us-gaap:earningspersharediluted') ?? tags.get('us-gaap:earningspersharebasicanddiluted') ?? tags.get('us-gaap:earningspersharebasic')
    return selected && Number.isFinite(selected.val)
      ? [{ start: selected.start, end, val: selected.val, form: filing.form, filed: filing.filed, accn: filing.accession }]
      : []
  })
}
