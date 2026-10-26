/**
 * test-seams.ts — dependency-free override slots for test setup.
 *
 * Global test setup must not import tool modules (that would load them, and
 * their dependencies, before a suite's vi.mock calls apply). Overrides are
 * therefore parked here and read by the tools at call time. Production code
 * never sets them.
 */
export type DecimalsVerifierOverride = (
  _chainId: number,
  _address: `0x${string}`,
  _claimed: number
) => Promise<void>

let decimalsVerifierOverride: DecimalsVerifierOverride | undefined

export function _setDecimalsVerifierOverride(verifier?: DecimalsVerifierOverride): void {
  decimalsVerifierOverride = verifier
}

export function decimalsVerifierOverride_(): DecimalsVerifierOverride | undefined {
  return decimalsVerifierOverride
}
