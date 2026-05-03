export type PaidMcpGatewayHardeningInput = {
  signup: {
    enabled: boolean;
    challengeStatus?: number;
    challengeHeader?: string;
    validatesBeforeKeyMint: boolean;
  };
  challengeParsing: {
    validatesNetwork: boolean;
    validatesAsset: boolean;
    validatesAmount: boolean;
    validatesRecipient: boolean;
    rejectsBodyOnlyChallenge: boolean;
  };
  keyMinting: {
    rawTokenVisibleOnlyAtMint: boolean;
    tokenHashAlgorithm?: 'sha256' | 'bcrypt' | 'argon2' | 'plain' | 'unknown';
    adminKeyTimingSafe: boolean;
    maxMintCeiling: boolean;
  };
  billing: {
    atomicDebit: boolean;
    concurrencyGuard: 'durable-object-blockConcurrencyWhile' | 'transaction' | 'mutex' | 'none';
    noChargeOnValidationFailure: boolean;
    refundPolicyForProviderFailure: boolean;
  };
  scopes: {
    defaultDeny: boolean;
    endpointScopeMapSingleSource: boolean;
  };
  browserSurface: {
    adminCorsDisabled: boolean;
    bodyReadLimitBytes?: number;
  };
  buyerAudit: {
    recordsBuyer: boolean;
    recordsEndpoint: boolean;
    recordsAmount: boolean;
    recordsPaymentReceipt: boolean;
    recordsIdempotencyKey: boolean;
    recordsBalanceBeforeAfter: boolean;
  };
};

export type PaidMcpGatewayHardeningResult = {
  ok: boolean;
  failures: string[];
  warnings: string[];
  score: number;
};

function headerLooksPaymentAware(header: string | undefined): boolean {
  if (!header) return false;
  const normalized = header.toLowerCase();
  return normalized.includes('payment') && (normalized.includes('x402') || normalized.includes('402'));
}

export function verifyPaidMcpGatewayHardening(input: PaidMcpGatewayHardeningInput): PaidMcpGatewayHardeningResult {
  const failures: string[] = [];
  const warnings: string[] = [];
  let passed = 0;
  let total = 0;

  const check = (condition: boolean, failure: string): void => {
    total += 1;
    if (condition) passed += 1;
    else failures.push(failure);
  };

  check(input.signup.enabled, 'Signup must be enabled for self-serve paid MCP access.');
  check(input.signup.challengeStatus === 402, 'Signup must return HTTP 402 before a payment credential exists.');
  check(headerLooksPaymentAware(input.signup.challengeHeader), 'Signup must expose an x402-aware payment challenge header.');
  check(input.signup.validatesBeforeKeyMint, 'Signup must validate payment receipt before minting a bearer key.');

  check(input.challengeParsing.validatesNetwork, 'Gateway must validate the offered network before charging.');
  check(input.challengeParsing.validatesAsset, 'Gateway must validate the offered asset before charging.');
  check(input.challengeParsing.validatesAmount, 'Gateway must validate amount and decimals before charging.');
  check(input.challengeParsing.validatesRecipient, 'Gateway must validate the recipient before charging.');
  check(input.challengeParsing.rejectsBodyOnlyChallenge, 'Gateway should reject body-only payment challenges for buyer verification.');

  check(input.keyMinting.rawTokenVisibleOnlyAtMint, 'Raw bearer token must only be visible at mint time.');
  check(
    input.keyMinting.tokenHashAlgorithm === 'sha256' ||
      input.keyMinting.tokenHashAlgorithm === 'bcrypt' ||
      input.keyMinting.tokenHashAlgorithm === 'argon2',
    'Stored bearer token material must be hashed, never plain text.'
  );
  check(input.keyMinting.adminKeyTimingSafe, 'Admin key comparison must be timing safe.');
  check(input.keyMinting.maxMintCeiling, 'Minting must have a maximum balance ceiling.');

  check(input.billing.atomicDebit, 'Billing debit must be atomic.');
  check(input.billing.concurrencyGuard !== 'none', 'Billing must use a real concurrency guard.');
  check(input.billing.noChargeOnValidationFailure, 'Malformed requests must not charge the buyer.');
  if (!input.billing.refundPolicyForProviderFailure) {
    warnings.push('Provider failure refund policy is not documented. Add one before public production use.');
  }

  check(input.scopes.defaultDeny, 'Scopes must default-deny when a key omits explicit scopes.');
  check(input.scopes.endpointScopeMapSingleSource, 'Endpoint to scope mapping must have one source of truth.');

  check(input.browserSurface.adminCorsDisabled, 'Admin routes must not expose browser CORS.');
  check(Boolean(input.browserSurface.bodyReadLimitBytes && input.browserSurface.bodyReadLimitBytes <= 16 * 1024), 'Request body reads should be bounded at or below 16 KB by default.');

  check(input.buyerAudit.recordsBuyer, 'Buyer audit must record buyer or key identity.');
  check(input.buyerAudit.recordsEndpoint, 'Buyer audit must record endpoint or tool name.');
  check(input.buyerAudit.recordsAmount, 'Buyer audit must record charged amount.');
  check(input.buyerAudit.recordsPaymentReceipt, 'Buyer audit must record payment receipt or transaction reference.');
  check(input.buyerAudit.recordsIdempotencyKey, 'Buyer audit must record idempotency key.');
  check(input.buyerAudit.recordsBalanceBeforeAfter, 'Buyer audit must record balance before and after charge.');

  return {
    ok: failures.length === 0,
    failures,
    warnings,
    score: total === 0 ? 0 : Math.round((passed / total) * 100),
  };
}
