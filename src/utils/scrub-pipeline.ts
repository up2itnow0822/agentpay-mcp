import { PRE_SCRUB_CAP_BYTES, PRE_SCRUB_CUT_MARKER, PRE_SCRUB_TAIL_DROP_BYTES, testScrubBudgetMs } from './scrub-bounds.js'

export class ScrubBudgetExceededError extends Error {
  override readonly name = 'ScrubBudgetExceededError'
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** Truncate oversized bodies before scrub so straddled secrets cannot leak past the cap. */
export function truncateForPreScrub(text: string): string {
  const bytes = new TextEncoder().encode(text)
  const cutEnd = Math.max(0, PRE_SCRUB_CAP_BYTES - PRE_SCRUB_TAIL_DROP_BYTES)
  if (bytes.length <= cutEnd) return text
  let end = cutEnd
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--
  return new TextDecoder().decode(bytes.slice(0, end)) + PRE_SCRUB_CUT_MARKER
}

export function runWithScrubBudget<T>(work: () => T): T {
  const budgetMs = testScrubBudgetMs.value
  const started = performance.now()
  const result = work()
  if (budgetMs !== undefined && performance.now() - started > budgetMs) {
    throw new ScrubBudgetExceededError()
  }
  return result
}

export { PRE_SCRUB_CAP_BYTES, PRE_SCRUB_CUT_MARKER, PRE_SCRUB_TAIL_DROP_BYTES, utf8ByteLength }