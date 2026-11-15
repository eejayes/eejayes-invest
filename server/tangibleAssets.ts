export function totalIntangibleAssets(
  combined: number | null,
  goodwill: number | null,
  otherIntangibles: number | null,
) {
  if (combined != null) return combined
  return (goodwill ?? 0) + (otherIntangibles ?? 0)
}

export function preferredStockValue(amount: number | null, shares: number | null) {
  return amount ?? (shares === 0 ? 0 : null)
}

export function netTangibleAssetsPerShare(
  assets: number | null,
  intangibles: number | null,
  liabilities: number | null,
  preferred: number | null,
  shares: number | null,
) {
  const inputs = [assets, intangibles, liabilities, preferred]
  if (inputs.some((value) => value != null && !Number.isFinite(value)) ||
      shares == null || !Number.isFinite(shares) || shares <= 0) return null
  return ((assets ?? 0) - (intangibles ?? 0) - (liabilities ?? 0) - (preferred ?? 0)) / shares
}

export function priceToNetTangibleAssets(price: number | null, perShare: number | null) {
  return price != null && Number.isFinite(price) && price > 0 &&
    perShare != null && Number.isFinite(perShare) && perShare > 0
    ? price / perShare
    : null
}
