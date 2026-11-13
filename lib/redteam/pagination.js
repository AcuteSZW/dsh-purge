const isMissing = (value) => value === undefined || value === null || (typeof value === 'string' && value.trim() === '')
const toFiniteNumber = (value) => {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** Normalize a caller-provided SQL/list limit; zero explicitly requests no rows. */
export function normalizeLimit(value, fallback, cap) {
  const defaultLimit = Math.min(cap, Math.max(0, Math.floor(fallback)))
  if (isMissing(value)) return defaultLimit
  const number = toFiniteNumber(value)
  if (number === null) return defaultLimit
  return Math.min(cap, Math.max(0, Math.floor(number)))
}

/** Normalize an offset to a finite non-negative safe integer. */
export function normalizeOffset(value) {
  if (isMissing(value)) return 0
  const number = toFiniteNumber(value)
  if (number === null) return 0
  return Math.min(Number.MAX_SAFE_INTEGER, Math.max(0, Math.floor(number)))
}
