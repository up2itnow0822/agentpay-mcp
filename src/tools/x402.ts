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
import { textContent, formatError, chainName } from '../utils/format.js';
import {
  describeSupportedX402Networks,
  isTvmOrTonNetwork,
  supportedX402NetworksForChainId,
} from '../utils/x402-networks.js';
import { findSessionForUrl, buildSessionHeaders } from './session.js';
import { recordSessionCall } from '../session/manager.js';

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

  const supportedNetworks = describeSupportedX402Networks(chainId);
  const offeredNetworks = Array.from(
    new Set((requirements?.accepts ?? []).map((req) => req.network).filter((network): network is string => Boolean(network)))
  );
  const offeredSchemes = Array.from(
    new Set((requirements?.accepts ?? []).map((req) => req.scheme).filter((scheme): scheme is string => Boolean(scheme)))
  );
  const tvmDetected = offeredNetworks.some(isTvmOrTonNetwork);

  let out = `❌ **Unsupported x402 Payment Requirement - Failed Closed**\n\n`;
  out += `  URL:       ${input.url}\n`;
  out += `  Method:    ${input.method ?? 'GET'}\n`;
  out += `  Status:    ${response.status} ${response.statusText}\n`;
  out += `  Supported: ${supportedNetworks}\n`;
  out += `  Offered:   ${offeredNetworks.length > 0 ? offeredNetworks.join(', ') : 'not parseable'}\n`;
  if (offeredSchemes.length > 0) out += `  Schemes:   ${offeredSchemes.join(', ')}\n`;
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
  out += '```\n' + responseText.slice(0, 4000) + (responseText.length > 4000 ? '\n... [truncated]' : '') + '\n```';

  return out;
}

// ─── Schema ────────────────────────────────────────────────────────────────

export const X402PaySchema = z.object({
  url: z
    .string()
    .url()
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
    'Fetch a URL and automatically handle HTTP 402 Payment Required responses. ' +
    'If an active x402 V2 session covers this URL, the session token is used instead ' +
    'of making a new payment (no on-chain cost). ' +
    'If no session exists, the Agent Wallet pays the required amount and retries. ' +
    'Payment is rejected if it exceeds your wallet\'s spend limits or the max_payment_eth cap. ' +
    'Powered by the x402 protocol on Base network. ' +
    'Tip: Use x402_session_start to pay once for a session and save on repeated calls.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      url: {
        type: 'string',
        description: 'URL to fetch (HTTP 402 responses are handled automatically)',
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
        description: 'Additional request headers',
      },
      body: {
        type: 'string',
        description: 'Request body string (for POST/PUT/PATCH)',
      },
      max_payment_eth: {
        type: 'string',
        description: 'Maximum payment cap in ETH (e.g. "0.001")',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
        default: 30000,
      },
      skip_session_check: {
        type: 'boolean',
        description: 'Skip session auto-detection and force a fresh x402 payment',
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

          const MAX_LEN = 8000;
          const truncated = responseText.length > MAX_LEN;
          const displayText = truncated
            ? responseText.slice(0, MAX_LEN) + '\n\n... [response truncated]'
            : responseText;

          const ttlRemaining = activeSession.expiresAt - Math.floor(Date.now() / 1000);

          let out = `🌐 **x402 Fetch Result** (session)\n\n`;
          out += `  URL:        ${input.url}\n`;
          out += `  Method:     ${method}\n`;
          out += `  Status:     ${response.status} ${response.statusText}\n`;
          out += `  Network:    ${chainName(config.chainId)}\n`;
          out += `\n🔐 **Session Used** (no payment)\n`;
          out += `  Session ID: ${activeSession.sessionId}\n`;
          if (activeSession.label) out += `  Label:      ${activeSession.label}\n`;
          out += `  TTL:        ${Math.ceil(ttlRemaining / 60)}m remaining\n`;
          out += `  Calls:      ${activeSession.callCount}\n`;
          out += `\n📄 **Response Body**\n`;
          out += '```\n' + displayText + '\n```';

          return { content: [textContent(out)] };
        }

        // Server returned 402 despite session headers — fall through to payment
        // (session may be invalid on the server side)
      }
    }

    // ── Standard x402 payment flow ────────────────────────────────────────

    // Parse optional max payment cap
    let maxPaymentWei: bigint | undefined;
    if (input.max_payment_eth) {
      const cap = parseFloat(input.max_payment_eth);
      if (isNaN(cap) || cap <= 0) {
        throw new Error(`Invalid max_payment_eth: "${input.max_payment_eth}"`);
      }
      maxPaymentWei = BigInt(Math.round(cap * 1e18));
    }

    // Track payment result
    let paymentMade = false;
    let paymentAmount = 0n;
    let paymentTxHash = '';
    let paymentRecipient = '';

    // Create x402 client with budget controls
    const x402Client = createX402Client(wallet, {
      autoPay: true,
      maxRetries: 1,
      supportedNetworks: supportedX402NetworksForChainId(config.chainId),
      // If cap is set, use it as globalPerRequestMax
      globalPerRequestMax: maxPaymentWei,
      onBeforePayment: (req, _url) => {
        const amount = BigInt(req.amount);
        if (maxPaymentWei && amount > maxPaymentWei) {
          throw new Error(
            `Payment required (${amount} wei) exceeds max_payment_eth cap ` +
            `(${maxPaymentWei} wei = ${input.max_payment_eth} ETH). ` +
            `Increase max_payment_eth or the payment will not proceed.`
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

    // Truncate very large responses for readability
    const MAX_RESPONSE_LEN = 8000;
    const truncated = responseText.length > MAX_RESPONSE_LEN;
    const displayText = truncated
      ? responseText.slice(0, MAX_RESPONSE_LEN) + '\n\n... [response truncated]'
      : responseText;

    if (response.status === 402 && !paymentMade) {
      return {
        content: [textContent(describeUnsupported402(input, response, responseText, config.chainId))],
        isError: true,
      };
    }

    let out = `🌐 **x402 Fetch Result**\n\n`;
    out += `  URL:     ${input.url}\n`;
    out += `  Method:  ${method}\n`;
    out += `  Status:  ${response.status} ${response.statusText}\n`;
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
    out += '```\n' + displayText + '\n```';

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
