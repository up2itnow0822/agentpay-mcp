/**
 * x402 binding checks split for offline fail-closed regression tests (SDK 7 path).
 * Each export maps to one independent binding dimension.
 */
export {
  assertPayableX402Recipient as assertX402BindingPayTo,
  assertParsableX402Amount as assertX402BindingAmount,
  assertX402TermsApproved as assertX402BindingApprovedTerms,
  assertPaymentCap as assertX402BindingPaymentCap,
  effectiveCapBaseUnits as assertX402BindingEffectiveCap,
  x402Debit,
  defaultX402Asset,
} from './payment-cap.js'