/**
 * amount.ts — strict decimal amount parsing for payment paths.
 *
 * parseFloat silently accepts garbage prefixes ("1,000" parses as 1) and
 * loses precision on large or high-precision values. parseAmountStrict
 * validates the entire string against a strict decimal grammar and converts
 * to base units with pure string/BigInt math — no float rounding anywhere.
 */

// Strict decimal grammar (same idiom as budget.ts): optional integer part,
// optional single dot, mandatory trailing digits. Rejects empty strings,
// signs ("-5", "+5"), commas ("1,000"), exponents ("1e3"), hex ("0x10"),
// multiple dots ("1.2.3"), and trailing dots ("5.").
const STRICT_DECIMAL_RE = /^\d*\.?\d+$/;

/**
 * Strictly parse a human-readable amount string into base units (bigint).
 *
 * - Leading/trailing whitespace is trimmed (" 5 " → 5); every remaining
 *   character must match the strict decimal grammar above.
 * - At most `decimals` decimal places are allowed — excess precision is
 *   rejected, never silently truncated or rounded.
 * - Zero and negative amounts are rejected (all call sites require a
 *   positive amount).
 * - Conversion is exact: "1.00000000000000001" with decimals=18 →
 *   1000000000000000010n (the parseFloat path collapses this to 1 ETH).
 *
 * @param value    Human-readable amount, e.g. "1.5"
 * @param decimals Base-unit decimal places of the asset (6 for USDC, 18 for ETH)
 * @param label    Field name used in error messages (default: "amount")
 */
export function parseAmountStrict(value: string, decimals: number, label = 'amount'): bigint {
  if (!Number.isInteger(decimals) || decimals < 0) {
    throw new Error(`Invalid decimals: ${decimals}. Must be a non-negative integer.`);
  }

  const trimmed = value.trim();
  if (!STRICT_DECIMAL_RE.test(trimmed)) {
    throw new Error(`Invalid ${label}: "${value}". Must be a positive number.`);
  }

  const [intPart = '', fracPart = ''] = trimmed.split('.');
  if (fracPart.length > decimals) {
    throw new Error(`Invalid ${label}: "${value}". Too many decimal places (max ${decimals}).`);
  }

  const baseUnits = BigInt((intPart || '0') + fracPart.padEnd(decimals, '0'));
  if (baseUnits <= 0n) {
    throw new Error(`Invalid ${label}: "${value}". Must be a positive number.`);
  }

  return baseUnits;
}
