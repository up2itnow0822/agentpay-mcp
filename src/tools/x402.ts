/**
 * x402.ts — x402_pay tool.
 *
 * Fetches a URL, automatically handling 402 Payment Required responses
 * by paying with the Agent Wallet and retrying the request.
 *
 * v1.1.0: Auto-session detection. If an active x402 V2 session covers the
 * requested URL, session headers are injected and no new payment is made.
 * Pass skip_session_check=true to force a fresh payment regardless.
 */
import { z } from 'zod';
import { createX402Client } from 'agentwallet-sdk';
import { getWallet, getConfig } from '../utils/client.js';
import {
  textContent,
  formatError,
  formatUntrustedBody,
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
import { recordSessionCall } from '../session/manager.js';
import { enforceSpendPolicy } from './budget.js';

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
      'Skip auto-session detection and always make a fresh x402 payment. ' +
      'Default: false. When false, if an active session covers this URL, ' +
      'the session token is used instead of paying again (x402 V2 behaviour).'
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
        description: 'Skip local x402 session detection and force a fresh payment. Do not enable unless the buyer wants a new receipt instead of using an active session.',
        default: false,
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
        const mergedHeaders: Record<string, string> = {
          'Accept': 'application/json, text/plain, */*',
          ...sessionHeaders,
          ...(input.headers ?? {}),
        };

        if (input.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
          if (!mergedHeaders['Content-Type']) {
            mergedHeaders['Content-Type'] = 'application/json';
          }
        }

        const requestInit: RequestInit = {
          method,
          headers: mergedHeaders,
          ...(input.body ? { body: input.body } : {}),
          signal: AbortSignal.timeout(timeoutMs),
        };

        const response = await fetch(input.url, requestInit);

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

    if (input.max_payment_eth) {
      const cap = parseFloat(input.max_payment_eth);
      if (isNaN(cap) || cap <= 0) {
        throw new Error(`Invalid max_payment_eth: "${input.max_payment_eth}"`);
      }
    }

    // Track payment result
    let paymentMade = false;
    let paymentAmount = 0n;
    let paymentTxHash = '';
    let paymentRecipient = '';

    // Create x402 client with budget controls.
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

    // Build request options
    const method = input.method ?? 'GET';
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

    // Execute request with x402 handling
    const response = await x402Client.fetch(input.url, requestInit);
    const responseText = await response.text();

    if (response.status === 402 && !paymentMade) {
      return {
        content: [textContent(describeUnsupported402(input, response, responseText, config.chainId))],
        isError: true,
      };
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
      out += `  Recipient: ${paymentRecipient}\n`;
      out += `  TX Hash:   ${paymentTxHash}\n`;
      out += `\n💡 Tip: Use x402_session_start to pay once for a session and skip per-call payments.\n`;
    } else {
      out += `\n✅ No payment required\n`;
    }

    out += `\n📄 **Response Body**\n`;
    out += formatUntrustedBody(responseText, 8000);

    return { content: [textContent(out)] };
  } catch (error: unknown) {
    // Check for AbortError (timeout)
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        content: [textContent(`❌ x402_pay failed: Request timed out after ${input.timeout_ms ?? 30000}ms`)],
        isError: true,
      };
    }
    return {
      content: [textContent(formatError(error, 'x402_pay'))],
      isError: true,
    };
  }
}
