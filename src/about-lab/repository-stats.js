const exactFormatter = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
const compactFormatter = new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 1 });

/** Public GitHub counts are integer numbers; absent or malformed values stay unknown. */
export function normalizeRepositoryCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? (value === 0 ? 0 : value) : null;
}

export function formatRepositoryCount(value, { compact = false } = {}) {
  const count = normalizeRepositoryCount(value);
  return count === null ? '—' : (compact ? compactFormatter : exactFormatter).format(count);
}
