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
} from '../utils/x402-networks.js';
import { createAgentPayX402Client } from '../utils/x402-client.js';
import { findSessionForUrl, buildSessionHeaders } from './session.js';
import { fetchWithSessionCredentials } from '../utils/session-fetch.js';
import {
  assertSafeUrl,
  createSafeTransport,
  readLimitedText,
} from '../utils/safe-fetch.js';
import {
  assertPaymentCap,
  assertPayableX402Recipient,
} from '../utils/payment-cap.js';
import { supportedX402NetworksForChainId } from '../utils/x402-networks.js';
import { recordSessionCall } from '../session/manager.js';
import {
  DefiniteSpendFailure,
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  IdempotencyKeyZodSchema,
  PostSettlementSpendError,
  requireSettlementHash,
  runClassifiedSpend,
  withSpendIntent,
  x402LockScope,
  x402PayIntentIdentity,
  x402PaymentScope,
} from '../utils/spend-intent.js';
import {
  recordX402Settlement,
  nextX402SettlementSeq,
  recordX402SettlementReplay,
} from '../utils/x402-receipt-log.js';

/** 402 offers no payable Base option. Retryable; nothing was broadcast. */
class X402UnsupportedRequirementError extends DefiniteSpendFailure {
  constructor(body: string) {
    super(body);
    this.name = 'X402UnsupportedRequirementError';
  }
}

function persistX402Settlement(entry: {
  intentKey: string;
  url: string;
  requestedUrl?: string;
  settledAt?: number;
  seq?: number;
  finalUrlUnknown?: boolean;
  method: string;
  amount: bigint | string;
  token: string;
  recipient: string;
  txHash: string;
}): string {
  const txHash = requireSettlementHash(entry.txHash, 'x402_pay');
  recordX402Settlement({
    intentKey: entry.intentKey,
    url: entry.url,
    ...(entry.requestedUrl && entry.requestedUrl !== entry.url
      ? { requestedUrl: entry.requestedUrl }
      : {}),
    ...(typeof entry.seq === 'number' ? { seq: entry.seq } : {}),
    ...(entry.finalUrlUnknown ? { finalUrlUnknown: true } : {}),
    ...(typeof entry.settledAt === 'number' && Number.isFinite(entry.settledAt)
      ? { settledAt: entry.settledAt }
      : {}),
    method: entry.method,
    amount: typeof entry.amount === 'bigint' ? entry.amount.toString() : entry.amount,
    token: entry.token,
    recipient: entry.recipient,
    txHash,
  });
  return txHash;
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
    .record(z.string(), z.string())
    .optional()
    .describe('Additional HTTP request headers as key-value pairs'),
  body: z
    .string()
    .optional()
    .describe('Request body (for POST/PUT/PATCH). Use JSON string for JSON APIs.'),
  max_payment_eth: z
    .string()
    .describe(
      'REQUIRED. Maximum amount to pay for this request, in whole units of the asset the ' +
      'server selects (e.g. "0.01" = 0.01 USDC for a USDC offer). The call fails closed ' +
      'before signing if the required amount exceeds this cap.'
    ),
  pay_to: z
    .string()
    .describe(
      'REQUIRED. The payee address you approved (from x402_quote or provider docs). ' +
      'A 402 that names any other payee is refused before signing.'
    ),
  asset: z
    .string()
    .max(64)
    .optional()
    .describe('Optional approved asset (contract address or symbol). Other assets are refused.'),
  network: z
    .string()
    .max(64)
    .optional()
    .describe('Optional approved x402 network (e.g. "base:8453"). Other networks are refused.'),
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
    'Use when an agent needs one capped x402 paid HTTP request and has already verified the URL, price, payTo, asset, and Base network (use x402_quote to read the offered terms without paying). ' +
    'max_payment_eth and pay_to are required: a 402 that names another payee or exceeds the cap is refused before signing. ' +
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
        description: 'REQUIRED payment cap in whole units of the selected asset (e.g. "0.01" USDC). The call fails closed before signing if the required payment exceeds this cap.',
      },
      pay_to: {
        type: 'string',
        description: 'REQUIRED approved payee address (from x402_quote). A 402 naming any other payee is refused before signing.',
      },
      asset: {
        type: 'string',
        description: 'Optional approved asset (address or symbol). Other assets are refused.',
      },
      network: {
        type: 'string',
        description: 'Optional approved x402 network (e.g. "base:8453"). Other networks are refused.',
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
    required: ['url', 'max_payment_eth', 'pay_to'],
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
    // Fail fast on an unsafe destination before any session or payment work.
    assertSafeUrl(input.url);
    // One pinned, byte-capped transport for every hop of this call.
    const transport = createSafeTransport();

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
        }, transport);

        // If server accepted the session (2xx/3xx), record it and return
        if (response.status !== 402) {
          const { text: responseText } = await readLimitedText(response);
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
        await response.body?.cancel().catch(() => undefined);
      }
    }

    // ── Standard x402 payment flow ────────────────────────────────────────
    // Identical paid MCP retries replay from the spend-intent cache. Uncharged
    // responses are not settled. A drop after a wallet write or
    // onPaymentComplete locks the intent so a retry cannot sign twice.
    const method = input.method ?? 'GET';
    const cap = assertPaymentCap(input.max_payment_eth);
    const approvedPayTo = assertPayableX402Recipient(input.pay_to);
    // A host or payee that has taken a payment without delivering is locked
    // for every new payment until reconciled (F1/F14) — any path, port, host
    // alias, and (for the payee) any other host. Enforced by withSpendIntent
    // admission through `lockScope`.
    const paymentScope = x402PaymentScope(input.url, approvedPayTo);

    const intent = x402PayIntentIdentity({
      url: input.url,
      method,
      body: input.body,
      headers: input.headers,
      idempotencyKey: input.idempotencyKey,
      terms: {
        cap,
        payTo: approvedPayTo.toLowerCase(),
        asset: input.asset ?? '',
        network: input.network ?? '',
      },
    });

    const { value, replayed } = await withSpendIntent(
      intent.key,
      async () => {
        let paymentMade = false;
        let paymentAmount = 0n;
        let paymentTxHash = '';
        let paymentRecipient = '';
        let paymentToken = '';
        let paymentSettledAt: number | undefined;
        let paymentSeq: number | undefined;

        // Cap enforcement happens in onBeforePayment using the selected asset's
        // decimals — never compare USDC base units against ETH-wei.
        const paidClient = createAgentPayX402Client(
          wallet,
          {
            chainId: config.chainId,
            maxPaymentEth: cap,
            approved: { payTo: approvedPayTo, asset: input.asset, network: input.network },
            transport,
            kind: 'payment',
            onPaymentComplete: (log) => {
              paymentMade = true;
              paymentAmount = log.amount;
              paymentTxHash = log.txHash;
              paymentRecipient = log.recipient;
              paymentToken = log.token;
              paymentSeq = nextX402SettlementSeq();
              paymentSettledAt = log.timestamp;
            },
          }
        );
        const x402Client = paidClient.client;

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
        // Captured before the body read so a body-read failure keeps the paid-response URL.
        let paidResponseUrl: string | undefined;
        try {
          const paid = await runClassifiedSpend(
            wallet.walletClient,
            async () => {
              const next = await x402Client.fetch(input.url, requestInit);
              paidResponseUrl = next.url || undefined;
              if (paymentMade && !next.ok) {
                // Paid, but the server answered 402/3xx/4xx/5xx: nothing was
                // delivered. Post-settlement failure — locks host and payee.
                await next.body?.cancel().catch(() => undefined);
                throw new Error(
                  `The paid request was answered with HTTP ${next.status}; the paid response was not delivered.`
                );
              }
              // Bounded read: the body is truncated for display, never
              // buffered whole (F8). A stream error after payment is still
              // classified post-settlement below.
              const { text } = await readLimitedText(next);
              return { response: next, responseText: text };
            },
            { lockAfterBroadcast: true }
          );
          response = paid.response;
          responseText = paid.responseText;
        } catch (error: unknown) {
          if (!paymentMade) {
            paidClient.disposeUnusedReservation(error);
          }
          if (paymentMade) {
            try {
              paymentTxHash = persistX402Settlement({
                intentKey: intent.key,
                // If the paid response arrived but its body read failed, keep its URL;
                // otherwise the redirect target that issued the 402 is unknown.
                url: paidResponseUrl ?? input.url,
                ...(paidResponseUrl ? {} : { finalUrlUnknown: true }),
                requestedUrl: input.url,
                settledAt: paymentSettledAt,
                seq: paymentSeq,
                method,
                amount: paymentAmount,
                token: paymentToken,
                recipient: paymentRecipient,
                txHash: paymentTxHash,
              });
            } catch {
              // Still fail closed on the post-settlement error even if the
              // callback hash cannot be recorded as a history receipt.
            }
            // withSpendIntent locks this intent, and with it the host and
            // payee (lockScope), until an operator reconciles it.
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
          paidClient.releaseUnusedReservation();
          throw new X402UnsupportedRequirementError(
            describeUnsupported402(input, response, responseText, config.chainId)
          );
        }

        if (paymentMade) {
          try {
            paymentTxHash = persistX402Settlement({
              intentKey: intent.key,
              // Record the URL that issued the paid 402 (after redirects).
              // response.url is the final URL of the paid response; under
              // redirects it may differ from the endpoint that issued the 402.
              url: response.url || input.url,
              requestedUrl: input.url,
              settledAt: paymentSettledAt,
              seq: paymentSeq,
              method,
              amount: paymentAmount,
              token: paymentToken,
              recipient: paymentRecipient,
              txHash: paymentTxHash,
            });
          } catch (error: unknown) {
            // Settled, but the receipt cannot be recorded (e.g. a malformed
            // hash from the SDK): fail closed as post-settlement so the
            // caller is told not to resubmit and host + payee lock.
            throw new PostSettlementSpendError({
              txHash: paymentTxHash,
              amount: paymentAmount,
              recipient: paymentRecipient,
              cause: error,
            });
          }
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
          paidClient.releaseUnusedReservation();
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
        lockScope: x402LockScope(paymentScope),
      }
    );

    if (replayed && value.charged) {
      recordX402SettlementReplay(intent.key);
    }

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
        '❌ x402_pay failed after settlement. Do not resubmit — new x402 payments to this host ' +
        'and to this payee are locked until the payment is reconciled.\n\n';
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

// ─── x402_quote ────────────────────────────────────────────────────────────

export const X402QuoteSchema = z.object({
  url: noControlChars(z.string().url())
    .describe('URL to probe. No payment is ever signed by this tool.'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    .optional()
    .default('GET')
    .describe('HTTP method the paid request will use (default: GET)'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .default(15000)
    .describe('Request timeout in milliseconds (default: 15000)'),
});

export type X402QuoteInput = z.infer<typeof X402QuoteSchema>;

export const x402QuoteTool = {
  name: 'x402_quote',
  description:
    'Read the x402 payment terms an endpoint offers WITHOUT paying. Returns, for each offer on the ' +
    'configured network, the payee (pay_to), asset, network and amount, so a human or policy can ' +
    'approve them before calling x402_pay / x402_session_start with pay_to and max_payment_eth. ' +
    'The request is sent without a body; it never signs or transfers anything.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: { type: 'string', description: 'Absolute https URL to probe.' },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        description: 'HTTP method (default: GET)',
        default: 'GET',
      },
      timeout_ms: { type: 'number', description: 'Timeout in ms (default 15000)', default: 15000 },
    },
    required: ['url'],
  },
};

const MAX_QUOTED_OFFERS = 8;

export async function handleX402Quote(
  input: X402QuoteInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const config = getConfig();
    const transport = createSafeTransport();
    const response = await transport(input.url, {
      method: input.method ?? 'GET',
      headers: { Accept: 'application/json, text/plain, */*' },
      redirect: 'manual',
      signal: AbortSignal.timeout(input.timeout_ms ?? 15000),
    });
    const { text: responseText } = await readLimitedText(response, 64 * 1024);

    if (response.status !== 402) {
      return {
        content: [
          textContent(
            `ℹ️ **No x402 Payment Required**\n\n` +
              `  URL:    ${sanitizeUntrustedUrl(input.url)}\n` +
              `  Status: ${formatHttpStatus(response.status)}\n\n` +
              `The endpoint did not answer with HTTP 402, so there are no terms to approve.`
          ),
        ],
      };
    }

    const requirements =
      parsePaymentRequiredFromHeader(response.headers.get('payment-required')) ??
      parsePaymentRequiredFromHeader(response.headers.get('x-payment-required')) ??
      parsePaymentRequiredFromBody(responseText);
    const supported = new Set(supportedX402NetworksForChainId(config.chainId));
    const offers = (requirements?.accepts ?? [])
      .filter((offer) => typeof offer === 'object' && offer !== null)
      .map((offer) => offer as Record<string, unknown>)
      .filter(
        (offer) =>
          offer.scheme === 'exact' &&
          typeof offer.network === 'string' &&
          supported.has(offer.network)
      )
      .slice(0, MAX_QUOTED_OFFERS);

    // Only validated, typed values appear outside the untrusted fence.
    const trusted = offers.flatMap((offer) => {
      try {
        const payTo = assertPayableX402Recipient(offer.payTo as string | undefined);
        const amount = typeof offer.amount === 'string' && /^\d{1,78}$/.test(offer.amount)
          ? offer.amount
          : null;
        const asset =
          typeof offer.asset === 'string' && /^(0x[0-9a-fA-F]{40}|[A-Za-z0-9]{1,16})$/.test(offer.asset)
            ? offer.asset
            : null;
        if (!amount || !asset) return [];
        return [{ pay_to: payTo, asset, network: offer.network as string, amount_base_units: amount }];
      } catch {
        return [];
      }
    });

    let out = `🧾 **x402 Quote** (no payment made)\n\n`;
    out += `  URL:       ${sanitizeUntrustedUrl(input.url)}\n`;
    out += `  Supported: ${describeSupportedX402Networks(config.chainId)}\n\n`;
    if (trusted.length === 0) {
      out += `No payable offer on the configured network was found. x402_pay would fail closed.\n`;
    } else {
      out += `Payable offers (validated):\n`;
      out += JSON.stringify(trusted, null, 2) + '\n\n';
      out +=
        `To pay, call x402_pay with pay_to (and optionally asset/network) copied from the offer ` +
        `you approve, and max_payment_eth set to the most you accept in whole units of that asset.\n`;
    }
    out += `\n📄 **402 Response Body**\n`;
    out += formatUntrustedBody(responseText, 4000);
    return { content: [textContent(out)] };
  } catch (error: unknown) {
    return { content: [textContent(formatError(error, 'x402_quote'))], isError: true };
  }
}
