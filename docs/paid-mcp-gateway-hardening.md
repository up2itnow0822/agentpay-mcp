# Paid MCP gateway hardening checklist

`create-mcpay@0.7.1` makes Cloudflare Worker paid-agent gateways look easy to scaffold. Its README claims x402-compatible signup, hashed bearer keys, Durable Object atomic charging, validate-before-charge behavior, default-deny scopes, no admin CORS, and 36 attack-scenario coverage.

That raises the bar for AgentPay MCP docs. Builders will compare paid MCP gateways on security defaults, not just on whether an HTTP 402 handshake exists.

## Hardening checks

A paid MCP gateway should pass these checks before public use:

### Signup and challenge parsing

- `/v1/signup` or equivalent returns HTTP 402 before a payment credential exists.
- The challenge is visible in a payment-aware header, not only in a JSON body.
- Network, asset, amount, decimals, and recipient are parsed before any key is minted.
- Body-only payment metadata fails closed for buyer verification.

### Key minting

- Raw bearer token is visible only at mint time.
- Stored token material is hashed with `sha256`, `bcrypt`, or `argon2`.
- Admin key comparison is timing safe.
- Minting has a maximum balance ceiling.

### Atomic billing

- Debit is atomic.
- A real concurrency guard is present, such as Durable Object `blockConcurrencyWhile`, a transaction, or a lock.
- Malformed requests do not charge the buyer.
- Provider failure refund policy is documented before production use.

### Scope defaults and browser surface

- A key with no explicit scopes cannot call paid endpoints.
- Endpoint to scope mapping has one source of truth.
- Admin routes do not expose browser CORS.
- Request body reads are bounded, with 16 KB as the preferred default.

### Buyer audit trail

Each paid call needs an audit row with:

- buyer or key identity,
- endpoint or tool name,
- charged amount,
- payment receipt or transaction reference,
- idempotency key,
- balance before and after charge.

## Test fixture response

The helper added in this response is `src/utils/paid-mcp-gateway-hardening.ts`. It scores a gateway fixture and fails closed when a scaffold skips any required control.

```ts
import { verifyPaidMcpGatewayHardening } from './src/utils/paid-mcp-gateway-hardening.js';

const result = verifyPaidMcpGatewayHardening({
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
    tokenHashAlgorithm: 'sha256',
    adminKeyTimingSafe: true,
    maxMintCeiling: true,
  },
  billing: {
    atomicDebit: true,
    concurrencyGuard: 'durable-object-blockConcurrencyWhile',
    noChargeOnValidationFailure: true,
    refundPolicyForProviderFailure: true,
  },
  scopes: {
    defaultDeny: true,
    endpointScopeMapSingleSource: true,
  },
  browserSurface: {
    adminCorsDisabled: true,
    bodyReadLimitBytes: 16384,
  },
  buyerAudit: {
    recordsBuyer: true,
    recordsEndpoint: true,
    recordsAmount: true,
    recordsPaymentReceipt: true,
    recordsIdempotencyKey: true,
    recordsBalanceBeforeAfter: true,
  },
});

if (!result.ok) throw new Error(result.failures.join('\n'));
```

## create-mcpay response map

| Template claim | AgentPay hardening response |
|---|---|
| x402-compatible signup | Require HTTP 402 signup challenge and receipt validation before key minting |
| Hashed bearer keys | Require raw token only at mint time and hashed storage |
| Durable Object charging | Require atomic debit plus a named concurrency guard |
| Validate-before-charge | Require no-charge validation failures in tests |
| Default-deny scopes | Require explicit scopes and one endpoint-scope source of truth |
| No admin CORS | Require admin routes to stay outside browser CORS |
| Security posture claims | Convert claims into fixture checks and audit proof |

## Validation proof

- Helper: `src/utils/paid-mcp-gateway-hardening.ts`
- Tests: `tests/paid-mcp-gateway-hardening.test.ts`
- README link: `README.md`
- Validation command: `npm test -- --run tests/paid-mcp-gateway-hardening.test.ts`
