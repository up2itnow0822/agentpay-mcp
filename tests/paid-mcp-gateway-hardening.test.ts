import { describe, expect, it } from 'vitest';
import { verifyPaidMcpGatewayHardening } from '../src/utils/paid-mcp-gateway-hardening.js';

const hardenedGateway = {
  signup: {
    enabled: true,
    challengeStatus: 402,
    challengeHeader: 'Payment realm="signup", protocol="x402"',
    validatesBeforeKeyMint: true,
  },
  challengeParsing: {
    validatesNetwork: true,
    validatesAsset: true,
    validatesAmount: true,
    validatesRecipient: true,
    rejectsBodyOnlyChallenge: true,
  },
  keyMinting: {
    rawTokenVisibleOnlyAtMint: true,
    tokenHashAlgorithm: 'sha256' as const,
    adminKeyTimingSafe: true,
    maxMintCeiling: true,
  },
  billing: {
    atomicDebit: true,
    concurrencyGuard: 'durable-object-blockConcurrencyWhile' as const,
    noChargeOnValidationFailure: true,
    refundPolicyForProviderFailure: true,
  },
  scopes: {
    defaultDeny: true,
    endpointScopeMapSingleSource: true,
  },
  browserSurface: {
    adminCorsDisabled: true,
    bodyReadLimitBytes: 16 * 1024,
  },
  buyerAudit: {
    recordsBuyer: true,
    recordsEndpoint: true,
    recordsAmount: true,
    recordsPaymentReceipt: true,
    recordsIdempotencyKey: true,
    recordsBalanceBeforeAfter: true,
  },
};

describe('paid MCP gateway hardening helper', () => {
  it('accepts a gateway template with x402 signup, key safety, atomic billing, scope defaults, no-charge validation failures, and buyer audit rows', () => {
    const result = verifyPaidMcpGatewayHardening(hardenedGateway);

    expect(result.ok).toBe(true);
    expect(result.score).toBe(100);
    expect(result.failures).toEqual([]);
  });

  it('fails closed for a demo gateway that charges before validation and stores unsafe bearer tokens', () => {
    const result = verifyPaidMcpGatewayHardening({
      ...hardenedGateway,
      signup: {
        enabled: true,
        challengeStatus: 200,
        challengeHeader: undefined,
        validatesBeforeKeyMint: false,
      },
      keyMinting: {
        rawTokenVisibleOnlyAtMint: false,
        tokenHashAlgorithm: 'plain',
        adminKeyTimingSafe: false,
        maxMintCeiling: false,
      },
      billing: {
        atomicDebit: false,
        concurrencyGuard: 'none',
        noChargeOnValidationFailure: false,
        refundPolicyForProviderFailure: false,
      },
      scopes: {
        defaultDeny: false,
        endpointScopeMapSingleSource: false,
      },
      buyerAudit: {
        recordsBuyer: true,
        recordsEndpoint: false,
        recordsAmount: false,
        recordsPaymentReceipt: false,
        recordsIdempotencyKey: false,
        recordsBalanceBeforeAfter: false,
      },
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'Signup must return HTTP 402 before a payment credential exists.',
        'Signup must expose an x402-aware payment challenge header.',
        'Signup must validate payment receipt before minting a bearer key.',
        'Raw bearer token must only be visible at mint time.',
        'Stored bearer token material must be hashed, never plain text.',
        'Billing debit must be atomic.',
        'Billing must use a real concurrency guard.',
        'Malformed requests must not charge the buyer.',
        'Scopes must default-deny when a key omits explicit scopes.',
        'Buyer audit must record idempotency key.',
      ])
    );
    expect(result.warnings).toContain('Provider failure refund policy is not documented. Add one before public production use.');
  });
});
