/**
 * Paid-body pre-scrub limits (commit 7 wires these into safeText / formatUntrustedBody).
 * Exported here so corpus cap_straddle rows can import the cap before scrub lands.
 */
export const PRE_SCRUB_CAP_BYTES = 1024 * 1024
export const PRE_SCRUB_TAIL_DROP_BYTES = 512
/** Inserted when input is truncated before scrub (full string defined in commit 7). */
export const PRE_SCRUB_CUT_MARKER = '\n... [body truncated before scrub]\n'

/** Test seam: when set, scrubbing must fail closed once elapsed exceeds this (ms). */
export const testScrubBudgetMs: { value: number | undefined } = { value: undefined }