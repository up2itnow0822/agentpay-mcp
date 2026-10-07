/**
 * x402.ts — x402_pay tool.
 *
 * Fetches a URL, automatically handling 402 Payment Required responses
 * by paying with the Agent Wallet and retrying the request.
 *
 * v1.1.0: Auto-session detection. If an active x402 V2 session covers the
 * requested URL, session headers are injected and no new payment is made.
 * Pass skip_session_check=true to skip x402 V2 session reuse and take the
 * payment path. Identical paid retries still replay from the spend-intent
 * cache; use a new idempotencyKey for a second settlement.
 */
import { z } from 'zod';
import { createX402Client } from 'agentwallet-sdk';
import { getWallet, getConfig } from '../utils/client.js';
import {
  textContent,
  formatError,
  formatUntrustedBody,
  sanitizeUntrustedInline,
  sanitizeUntrustedList,
  sanitizeUntrustedUrl,
  describeFinalUrl,
  formatHttpStatus,
  noControlChars,
  chainName,
} from '../utils/format.js';
import {
  describeSupportedX402Networks,
  isTvmOrTonNetwork,
  supportedX402NetworksForChainId,
} from '../utils/x402-networks.js';
import {
  assertPayableX402Recipient,
  assertParsableX402Amount,
  maxPaymentBaseUnits,
  resolveX402AssetDecimals,
} from '../utils/payment-cap.js';
import { findSessionForUrl, buildSessionHeaders } from './session.js';
import { fetchWithSessionCredentials } from '../utils/session-fetch.js';
import { recordSessionCall } from '../session/manager.js';
import { enforceSpendPolicy } from './budget.js';
import {
  DefiniteSpendFailure,
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  IdempotencyKeyZodSchema,
  PostSettlementSpendError,
  requireSettlementHash,
  runClassifiedSpend,
  withSpendIntent,
  x402PayIntentIdentity,
} from '../utils/spend-intent.js';

/** 402 offers no payable Base option. Retryable; nothing was broadcast. */
class X402UnsupportedRequirementError extends DefiniteSpendFailure {
  constructor(body: string) {
    super(body);
    this.name = 'X402UnsupportedRequirementError';
  }
}

type X402PaymentAccept = {
  scheme?: string;
  network?: string;
  asset?: string;
  amount?: string;
  payTo?: string;
};

type X402PaymentRequired = {
  x402Version?: number;
  accepts?: X402PaymentAccept[];
};

function parsePaymentRequiredFromHeader(headerValue: string | null): X402PaymentRequired | null {
  if (!headerValue) return null;

  try {
    const decoded = Buffer.from(headerValue, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded) as X402PaymentRequired;
    return Array.isArray(parsed.accepts) ? parsed : null;
  } catch {
    return null;
  }
}

function parsePaymentRequiredFromBody(responseText: string): X402PaymentRequired | null {
  try {
    const parsed = JSON.parse(responseText) as X402PaymentRequired;
    return Array.isArray(parsed.accepts) ? parsed : null;
  } catch {
    return null;
  }
}

/** Max server-supplied network/scheme names echoed into the narration region. */
const MAX_OFFERED_LISTED = 8;

/**
 * Collect the distinct values of one `accepts[]` field from a 402 payload.
 *
 * The payload comes from `JSON.parse`, so a field declared `string?` in the
 * local type can be a number, array or object at runtime. Anything that is
 * not a string is dropped rather than coerced: these values are rendered as
 * network/scheme names, and a non-string is not one.
 */
function collectOfferedStrings(
  accepts: X402PaymentAccept[],
  field: 'network' | 'scheme'
): string[] {
  return Array.from(
    new Set(
      accepts
        .map((req) => (req as Record<string, unknown>)[field])
        .filter((value): value is string => typeof value === 'string' && value.length > 0)
    )
  );
}

function describeUnsupported402(
  input: X402PayInput,
  response: Response,
  responseText: string,
  chainId: number
): string {
  const requirements =
    parsePaymentRequiredFromHeader(response.headers.get('payment-required')) ??
    parsePaymentRequiredFromHeader(response.headers.get('x-payment-required')) ??
    parsePaymentRequiredFromBody(responseText);

  const accepts = requirements?.accepts ?? [];
  const supportedNetworks = describeSupportedX402Networks(chainId);
  const offeredNetworks = collectOfferedStrings(accepts, 'network');
  const offeredSchemes = collectOfferedStrings(accepts, 'scheme');
  const tvmDetected = offeredNetworks.some(isTvmOrTonNetwork);

  let out = `❌ **Unsupported x402 Payment Requirement - Failed Closed**\n\n`;
  out += `  URL:       ${sanitizeUntrustedUrl(input.url)}\n`;
  out += describeFinalUrl(input.url, response);
  out += `  Method:    ${input.method ?? 'GET'}\n`;
  out += `  Status:    ${formatHttpStatus(response.status)}\n`;
  out += `  Supported: ${supportedNetworks}\n`;
  out += `  Offered:   ${offeredNetworks.length > 0 ? sanitizeUntrustedList(offeredNetworks, MAX_OFFERED_LISTED) : 'not parseable'}\n`;
  if (offeredSchemes.length > 0) {
    out += `  Schemes:   ${sanitizeUntrustedList(offeredSchemes, MAX_OFFERED_LISTED)}\n`;
  }
  out += `\nAgentPay MCP did not sign or send a payment. The server returned HTTP 402, ` +
    `but none of the offered x402 payment options matched the configured AgentPay network.\n`;

  if (tvmDetected) {
    out += `\nTVM/TON exact-payment requirements are currently watch-only. AgentPay must add ` +
      `explicit support for TVM signing, account deployment, gas, jettons, facilitator settlement, ` +
      `and receipt audit rows before these payments can be enabled.\n`;
  }

  out += `\nGuidance: fund and publish a Base-compatible x402 exact option, or keep this ` +
    `endpoint disabled for AgentPay MCP until TVM support ships deliberately.\n`;
  out += `\n📄 **402 Response Body**\n`;
  out += formatUntrustedBody(responseText, 4000);

  return out;
}

// ─── Schema ────────────────────────────────────────────────────────────────

export const X402PaySchema = z.object({
  url: noControlChars(z.string().url())
    .describe('URL to fetch. If it returns HTTP 402, payment is handled automatically.'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    .optional()
    .default('GET')
    .describe('HTTP method (default: GET)'),
  headers: z
    .record(z.string())
    .optional()
    .describe('Additional HTTP request headers as key-value pairs'),
  body: z
    .string()
    .optional()
    .describe('Request body (for POST/PUT/PATCH). Use JSON string for JSON APIs.'),
  max_payment_eth: z
    .string()
    .optional()
    .describe(
      'Maximum ETH equivalent to pay for this request. ' +
      'Rejects the payment if the required amount exceeds this. ' +
      'E.g. "0.001" to cap at 0.001 ETH.'
    ),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .default(30000)
    .describe('Request timeout in milliseconds (default: 30000, max: 60000)'),
  skip_session_check: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      'Skip auto-session detection and take the x402 payment path instead of ' +
      'an active session token. Default: false. Does not bypass spend-intent ' +
      'replay; use a new idempotencyKey to settle twice.'
    ),
  idempotencyKey: IdempotencyKeyZodSchema.optional()
    .describe(
      'Caller-supplied idempotency key. Distinct keys allow two equal paid fetches; ' +
        'the same key replays the original payment; reusing it with a different ' +
        'payload is refused. MCP retries without a key still collapse on the ' +
        'settled URL/method/body for five minutes.'
    ),
});

export type X402PayInput = z.infer<typeof X402PaySchema>;

// ─── Tool definition ───────────────────────────────────────────────────────

export const x402PayTool = {
  name: 'x402_pay',
  description:
    'Use when an agent needs one capped x402 paid HTTP request and has already verified the URL, price, payTo, asset, and Base network. ' +
    'Automatically handles HTTP 402 Payment Required responses with the x402 v2.11 Payment-Signature flow. ' +
    'If an active x402 V2 session covers this URL, the session token is used instead of making a new payment. ' +
    'Identical retries replay the original paid result; pass idempotencyKey to distinguish two equal fetches. ' +
    'An RPC drop after payment fail-closes instead of signing a second settlement. ' +
    'Do not use when the endpoint is an uninitialized Streamable HTTP MCP session, the offered network is unsupported, the buyer lacks a spend cap, or a reusable entitlement should use x402_session_start instead.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'Absolute HTTP URL to fetch. Use only after verifying the endpoint, payTo, asset, and network metadata.',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        description: 'HTTP method (default: GET)',
        default: 'GET',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Additional request headers for the target endpoint. Do not put private keys here. Payment-Signature is generated by the x402 client after policy approval.',
      },
      body: {
        type: 'string',
        description: 'Request body string (for POST/PUT/PATCH)',
      },
      max_payment_eth: {
        type: 'string',
        description: 'Maximum ETH-equivalent payment cap for this request. The call fails closed before signing if the required payment exceeds this cap.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
        default: 30000,
      },
      skip_session_check: {
        type: 'boolean',
        description:
          'Skip local x402 session detection and take the payment path instead of an active session. Does not bypass spend-intent replay. Use a new idempotencyKey for a second settlement.',
        default: false,
      },
      idempotencyKey: {
        ...IDEMPOTENCY_KEY_JSON_SCHEMA,
        description:
          'Optional idempotency key (1-128 non-whitespace chars). Distinct keys allow two equal paid fetches.',
      },
    },
    required: ['url'],
  },
};

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleX402Pay(
  input: X402PayInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const config = getConfig();
    const timeoutMs = input.timeout_ms ?? 30000;

    // ── Auto-session detection (x402 V2 behaviour) ──────────────────────
    // If there's an active session for this URL and the caller hasn't
    // explicitly asked to skip it, use the session token instead of paying.
    if (!input.skip_session_check) {
      const activeSession = findSessionForUrl(input.url);
      if (activeSession) {
        const sessionHeaders = buildSessionHeaders(activeSession);
        const method = input.method ?? 'GET';
        const callerHeaders: Record<string, string> = {
          'Accept': 'application/json, text/plain, */*',
          ...(input.headers ?? {}),
        };

        if (input.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
          if (!callerHeaders['Content-Type']) {
            callerHeaders['Content-Type'] = 'application/json';
          }
        }

        const requestInit: RequestInit = {
          method,
          headers: callerHeaders,
          ...(input.body ? { body: input.body } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        };

        // Session headers win. Cross-origin redirects and same-origin redirects
        // outside the paid scope are refused so a 302 cannot leak the token or
        // turn into a second on-chain payment.
        const response = await fetchWithSessionCredentials(input.url, requestInit, sessionHeaders, {
          endpoint: activeSession.endpoint,
          scope: activeSession.scope,
        });

        // If server accepted the session (2xx/3xx), record it and return
        if (response.status !== 402) {
          const responseText = await response.text();
          recordSessionCall(activeSession.sessionId);

          const ttlRemaining = activeSession.expiresAt - Math.floor(Date.now() / 1000);

          let out = `🌐 **x402 Fetch Result** (session)\n\n`;
          out += `  URL:        ${sanitizeUntrustedUrl(input.url)}\n`;
          out += describeFinalUrl(input.url, response);
          out += `  Method:     ${method}\n`;
          out += `  Status:     ${formatHttpStatus(response.status)}\n`;
          out += `  Network:    ${chainName(config.chainId)}\n`;
          out += `\n🔐 **Session Used** (no payment)\n`;
          out += `  Session ID: ${activeSession.sessionId}\n`;
          if (activeSession.label) out += `  Label:      ${activeSession.label}\n`;
          out += `  TTL:        ${Math.ceil(ttlRemaining / 60)}m remaining\n`;
          out += `  Calls:      ${activeSession.callCount}\n`;
          out += `\n📄 **Response Body**\n`;
          out += formatUntrustedBody(responseText, 8000);

          return { content: [textContent(out)] };
        }

        // Server returned 402 despite session headers — fall through to payment
        // (session may be invalid on the server side)
      }
    }

    // ── Standard x402 payment flow ────────────────────────────────────────
    // Identical paid MCP retries replay from the spend-intent cache. Uncharged
    // responses are not settled. A drop after a wallet write or
    // onPaymentComplete locks the intent so a retry cannot sign twice.
    const method = input.method ?? 'GET';
    if (input.max_payment_eth) {
      const cap = parseFloat(input.max_payment_eth);
      if (isNaN(cap) || cap <= 0) {
        throw new DefiniteSpendFailure(
          `Invalid max_payment_eth: "${input.max_payment_eth}"`
        );
      }
    }

    const intent = x402PayIntentIdentity({
      url: input.url,
      method,
      body: input.body,
      headers: input.headers,
      idempotencyKey: input.idempotencyKey,
    });

    const { value, replayed } = await withSpendIntent(
      intent.key,
      async () => {
        let paymentMade = false;
        let paymentAmount = 0n;
        let paymentTxHash = '';
        let paymentRecipient = '';

        // Cap enforcement happens in onBeforePayment using the selected asset's
        // decimals — never compare USDC base units against ETH-wei.
        const x402Client = createX402Client(wallet, {
          autoPay: true,
          maxRetries: 1,
          supportedNetworks: supportedX402NetworksForChainId(config.chainId),
          onBeforePayment: async (req, _url) => {
            // The 402's payTo is remote-controlled and ends up inside error
            // messages (SDK allowlist rejection, viem InvalidAddressError).
            // Reject non-addresses before signing or interpolating.
            const merchant = assertPayableX402Recipient(req.payTo);
            // req.amount is remote-controlled; a raw BigInt() here would put the
            // whole value verbatim into V8's "Cannot convert <amount> to a
            // BigInt" message.
            const amount = assertParsableX402Amount(req.amount);
            if (input.max_payment_eth) {
              const maxRaw = maxPaymentBaseUnits(
                input.max_payment_eth,
                req.asset,
                config.chainId
              );
              if (amount > maxRaw) {
                throw new Error(
                  `Payment required (${amount} base units) exceeds max_payment_eth cap ` +
                  `(${maxRaw} base units for asset ${req.asset} = ${input.max_payment_eth}). ` +
                  `Increase max_payment_eth or the payment will not proceed.`
                );
              }
            }

            // amount is in the offered asset's base units; the decimals thunk
            // only runs when a policy is configured, and resolution failures
            // reject (fail closed) inside enforceSpendPolicy.
            const policyDecision = await enforceSpendPolicy({
              merchant,
              amount,
              decimals: () =>
                resolveX402AssetDecimals(
                  req.asset ?? '0x0000000000000000000000000000000000000000',
                  config.chainId
                ),
            });
            if (policyDecision.status !== 'approved') {
              throw new Error(
                policyDecision.reason ??
                  `x402 payment blocked by spend policy (${policyDecision.status}).`
              );
            }
            return true;
          },
          onPaymentComplete: (log) => {
            paymentMade = true;
            paymentAmount = log.amount;
            paymentTxHash = log.txHash;
            paymentRecipient = log.recipient;
          },
        });

        const headers: Record<string, string> = {
          'Accept': 'application/json, text/plain, */*',
          ...(input.headers ?? {}),
        };

        if (input.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
          if (!headers['Content-Type']) {
            headers['Content-Type'] = 'application/json';
          }
        }

        const requestInit: RequestInit = {
          method,
          headers,
          ...(input.body ? { body: input.body } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        };

        let response: Response;
        let responseText: string;
        try {
          const paid = await runClassifiedSpend(
            wallet.walletClient,
            async () => {
              const next = await x402Client.fetch(input.url, requestInit);
              return { response: next, responseText: await next.text() };
            },
            { lockAfterBroadcast: true }
          );
          response = paid.response;
          responseText = paid.responseText;
        } catch (error: unknown) {
          if (paymentMade) {
            throw new PostSettlementSpendError({
              txHash: paymentTxHash,
              amount: paymentAmount,
              recipient: paymentRecipient,
              cause: error,
            });
          }
          if (
            error instanceof DefiniteSpendFailure &&
            /abort/i.test(error.message)
          ) {
            throw new DefiniteSpendFailure(
              `Request timed out after ${timeoutMs}ms`
            );
          }
          // Post-broadcast AbortError stays generic so withSpendIntent locks.
          throw error;
        }

        if (response.status === 402 && !paymentMade) {
          throw new X402UnsupportedRequirementError(
            describeUnsupported402(input, response, responseText, config.chainId)
          );
        }

        if (paymentMade) {
          requireSettlementHash(paymentTxHash, 'x402_pay');
        }

        let out = `🌐 **x402 Fetch Result**\n\n`;
        out += `  URL:     ${sanitizeUntrustedUrl(input.url)}\n`;
        out += describeFinalUrl(input.url, response);
        out += `  Method:  ${method}\n`;
        out += `  Status:  ${formatHttpStatus(response.status)}\n`;
        out += `  Network: ${chainName(config.chainId)}\n`;

        if (paymentMade) {
          out += `\n💳 **Payment Made**\n`;
          out += `  Amount:    ${paymentAmount.toString()} (base units)\n`;
          // Both come from the SDK's payment log: `recipient` is the 402's own
          // `payTo`, i.e. remote text, and `txHash` is whatever the write returned.
          // They sit in the trusted narration region above the fence, so they are
          // flattened and capped like every other untrusted value echoed there.
          out += `  Recipient: ${sanitizeUntrustedInline(paymentRecipient, 64)}\n`;
          out += `  TX Hash:   ${sanitizeUntrustedInline(paymentTxHash, 80)}\n`;
          out += `\n💡 Tip: Use x402_session_start to pay once for a session and skip per-call payments.\n`;
        } else {
          out += `\n✅ No payment required\n`;
        }

        out += `\n📄 **Response Body**\n`;
        out += formatUntrustedBody(responseText, 8000);
        return { text: out, charged: paymentMade };
      },
      {
        durable: Boolean(input.idempotencyKey?.trim()),
        fingerprint: intent.fingerprint,
        shouldSettle: (result) => result.charged,
      }
    );

    const text = replayed
      ? `${value.text}\n♻️ Idempotent retry: original x402 result replayed; no second settlement.\n`
      : value.text;
    return { content: [textContent(text)] };
  } catch (error: unknown) {
    if (error instanceof X402UnsupportedRequirementError) {
      return {
        content: [textContent(error.message)],
        isError: true,
      };
    }
    if (error instanceof PostSettlementSpendError) {
      const cause =
        error.cause instanceof Error ? error.cause.message : undefined;
      let out =
        '❌ x402_pay failed after settlement. Do not resubmit this request.\n\n';
      out += `  Amount:    ${sanitizeUntrustedInline(error.amount, 64)} (base units)\n`;
      out += `  Recipient: ${sanitizeUntrustedInline(error.recipient, 64)}\n`;
      out += `  TX Hash:   ${sanitizeUntrustedInline(error.txHash, 80)}\n`;
      out +=
        '\nFunds may already have moved. Reconcile this transaction before any new payment.\n';
      if (cause) {
        out += '\nFollow-up error:\n';
        out += formatUntrustedBody(cause, 8000);
      }
      return {
        content: [textContent(out)],
        isError: true,
      };
    }
    if (
      (error instanceof Error && error.name === 'AbortError') ||
      (error instanceof DefiniteSpendFailure &&
        /Request timed out after \d+ms/.test(error.message))
    ) {
      const timeout = /Request timed out after (\d+)ms/.exec(
        error instanceof Error ? error.message : ''
      );
      return {
        content: [
          textContent(
            `❌ x402_pay failed: Request timed out after ${timeout?.[1] ?? input.timeout_ms ?? 30000}ms`
          ),
        ],
        isError: true,
      };
    }
    return {
      content: [textContent(formatError(error, 'x402_pay'))],
      isError: true,
    };
  }
}
