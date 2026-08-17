/**
 * session.ts — x402 V2 session payment tools.
 *
 * Implements the x402 V2 "wallet-based access & reusable sessions" pattern:
 *   1. x402_session_start  — pay once, receive a signed session token
 *   2. x402_session_fetch  — make N calls within the session (no new payments)
 *   3. x402_session_status — inspect active sessions and TTL remaining
 *   4. x402_session_end    — explicitly close a session
 *
 * Non-custodial design:
 *   Agents sign session tokens locally with their private key.
 *   No third party holds or validates keys at any point.
 *   Session tokens are self-contained ECDSA-signed claims that any server
 *   implementing x402 V2 can independently verify.
 */

import { z } from 'zod';
import { createX402Client } from 'agentwallet-sdk';
import { getWallet, getConfig } from '../utils/client.js';
import {
  textContent,
  formatError,
  formatUntrustedBody,
  sanitizeUntrustedInline,
  sanitizeUntrustedUrl,
  describeFinalUrl,
  formatHttpStatus,
  noControlChars,
  chainName,
} from '../utils/format.js';
import { supportedX402NetworksForChainId } from '../utils/x402-networks.js';
import {
  assertPayableX402Recipient,
  assertParsableX402Amount,
  maxPaymentBaseUnits,
  resolveX402AssetDecimals,
} from '../utils/payment-cap.js';
import { enforceSpendPolicy } from './budget.js';
import {
  createSession,
  lookupSession,
  recordSessionCall,
  endSession,
  listActiveSessions,
  findSessionForUrl,
  isUrlCoveredBySession,
  buildSessionHeaders,
  decodeSessionToken,
  wasEndedLocally,
  tokenExpiryOf,
} from '../session/manager.js';

// ─── x402_session_start ────────────────────────────────────────────────────

export const X402SessionStartSchema = z.object({
  endpoint: noControlChars(z.string().url())
    .describe(
      'The base URL or endpoint to establish a session for. ' +
      'The agent pays once and the session covers all subsequent requests to this endpoint.'
    ),
  scope: z
    .enum(['prefix', 'exact'])
    .optional()
    .default('prefix')
    .describe(
      '"prefix" (default): session covers all paths under the endpoint URL. ' +
      '"exact": session only covers this exact URL.'
    ),
  ttl_seconds: z
    .number()
    .int()
    .min(60)
    .max(86400 * 30)
    .optional()
    .describe(
      'Session lifetime in seconds (default: SESSION_TTL_SECONDS env var or 3600 = 1 hour). ' +
      'Min: 60 seconds. Max: 30 days (explicit opt-in). ' +
      'Choose the shortest TTL that fits the task: session tokens are self-contained signed ' +
      'bearer credentials that CANNOT be revoked once issued — x402_session_end only clears ' +
      'local state, so a leaked token stays valid to the endpoint until this TTL elapses.'
    ),
  label: noControlChars(z.string().max(100))
    .optional()
    .describe('Optional human-readable label for this session (e.g. "Premium API session")'),
  max_payment_eth: z
    .string()
    .optional()
    .describe('Maximum ETH to pay for session establishment. Rejects if exceeded.'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    .optional()
    .default('GET')
    .describe('HTTP method for the initial payment request (default: GET)'),
  headers: z
    .record(z.string())
    .optional()
    .describe('Additional headers for the session-start request'),
  body: z
    .string()
    .optional()
    .describe('Request body for the initial session-start request (if POST/PUT/PATCH)'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .default(30000)
    .describe('Request timeout in milliseconds (default: 30000)'),
});

export type X402SessionStartInput = z.infer<typeof X402SessionStartSchema>;

export const x402SessionStartTool = {
  name: 'x402_session_start',
  description:
    'Use when a paid endpoint supports a reusable x402 session or entitlement. Makes one capped payment, stores a non-custodial signed session token, and returns a session_id for x402_session_fetch. ' +
    'Do not use for providers without session semantics, unknown networks, missing spend caps, or calls where the buyer cannot store and audit the returned mcp-session-id/session_id.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      endpoint: {
        type: 'string',
        description: 'Base URL to establish a paid session for. For Streamable HTTP MCP gateways, initialize before tools/list or tools/call.',
      },
      scope: {
        type: 'string',
        enum: ['prefix', 'exact'],
        description: '"prefix": covers all paths under this URL (default). "exact": single URL only.',
        default: 'prefix',
      },
      ttl_seconds: {
        type: 'number',
        description:
          'Session TTL in seconds (default: 3600 / 1 hour). Max: 30 days (explicit opt-in). ' +
          'Prefer the shortest TTL that fits the task: the signed session token cannot be ' +
          'revoked once issued (x402_session_end only clears local state), so a leaked token ' +
          'stays valid to the endpoint until this TTL elapses.',
      },
      label: {
        type: 'string',
        description: 'Optional label for this session (e.g., "Premium API session")',
      },
      max_payment_eth: {
        type: 'string',
        description: 'Maximum ETH-equivalent payment cap for opening the session. The call fails closed before signing if the required payment exceeds this cap.',
      },
      method: {
        type: 'string',
        enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        description: 'HTTP method for the initial request (default: GET)',
        default: 'GET',
      },
      headers: {
        type: 'object',
        additionalProperties: { type: 'string' },
        description: 'Additional request headers for the initial paid request. Do not put private keys here.',
      },
      body: {
        type: 'string',
        description: 'Request body for POST/PUT/PATCH session-start requests',
      },
      timeout_ms: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000)',
        default: 30000,
      },
    },
    required: ['endpoint'],
  },
};

export async function handleX402SessionStart(
  input: X402SessionStartInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const config = getConfig();
    const timeoutMs = input.timeout_ms ?? 30000;

    if (input.max_payment_eth) {
      const cap = parseFloat(input.max_payment_eth);
      if (isNaN(cap) || cap <= 0) {
        throw new Error(`Invalid max_payment_eth: "${input.max_payment_eth}"`);
      }
    }

    // Track payment
    let paymentMade = false;
    let paymentAmount = 0n;
    let paymentTxHash = '';
    let paymentRecipient = '';
    let paymentToken = '0x0000000000000000000000000000000000000000';

    // x402 client to handle the one-time session payment.
    // Cap uses the selected asset's decimals (not ETH-wei).
    const x402Client = createX402Client(wallet, {
      autoPay: true,
      maxRetries: 1,
      supportedNetworks: supportedX402NetworksForChainId(config.chainId),
      onBeforePayment: async (req) => {
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
              `Session payment (${amount} base units) exceeds max_payment_eth cap ` +
              `(${maxRaw} base units for asset ${req.asset} = ${input.max_payment_eth}). ` +
              `Set a higher max_payment_eth to proceed.`
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
              `Session payment blocked by spend policy (${policyDecision.status}).`
          );
        }
        return true;
      },
      onPaymentComplete: (log) => {
        paymentMade = true;
        paymentAmount = log.amount;
        paymentTxHash = log.txHash;
        paymentRecipient = log.recipient;
        paymentToken = log.token ?? '0x0000000000000000000000000000000000000000';
      },
    });

    const method = input.method ?? 'GET';
    const reqHeaders: Record<string, string> = {
      'Accept': 'application/json, text/plain, */*',
      ...(input.headers ?? {}),
    };

    if (input.body && ['POST', 'PUT', 'PATCH'].includes(method)) {
      if (!reqHeaders['Content-Type']) {
        reqHeaders['Content-Type'] = 'application/json';
      }
    }

    const requestInit: RequestInit = {
      method,
      headers: reqHeaders,
      ...(input.body ? { body: input.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    };

    // Make the payment request
    const response = await x402Client.fetch(input.endpoint, requestInit);
    const responseText = await response.text();

    if (!paymentMade) {
      // Endpoint didn't require payment — still create a session if response was OK
      // This allows agents to pre-establish sessions for endpoints that may start
      // requiring payment, or to track usage even for free endpoints.
      return {
        content: [
          textContent(
            `ℹ️ **No Payment Required**\n\n` +
            `  Endpoint: ${sanitizeUntrustedUrl(input.endpoint)}\n` +
            describeFinalUrl(input.endpoint, response) +
            `  Status:   ${formatHttpStatus(response.status)}\n\n` +
            `No x402 payment was needed. The endpoint responded without requiring payment.\n` +
            `You do not need a session token — use x402_pay directly for free endpoints.\n\n` +
            `📄 **Response Body**\n` +
            formatUntrustedBody(responseText, 4000)
          ),
        ],
      };
    }

    // Create signed session record
    // The signMessage function uses viem's wallet client, signing locally with the agent's key
    const signMessage = async (message: string): Promise<string> => {
      // Access the walletClient from the wallet instance for local signing
      const wc = (wallet as unknown as { walletClient: { signMessage: (_args: { message: string }) => Promise<string> } }).walletClient;
      return wc.signMessage({ message });
    };

    const session = await createSession({
      endpoint: input.endpoint,
      scope: input.scope ?? 'prefix',
      ttlSeconds: input.ttl_seconds,
      label: input.label,
      paymentTxHash,
      paymentAmount,
      paymentToken,
      paymentRecipient,
      walletAddress: config.walletAddress,
      signMessage,
    });

    const ttlRemaining = session.expiresAt - Math.floor(Date.now() / 1000);
    const expiresAt = new Date(session.expiresAt * 1000).toISOString();

    let out = `🔐 **x402 Session Established**\n\n`;
    out += `  Session ID:    ${session.sessionId}\n`;
    out += `  Endpoint:      ${sanitizeUntrustedUrl(session.endpoint)}\n`;
    out += describeFinalUrl(input.endpoint, response);
    out += `  Scope:         ${session.scope}\n`;
    if (session.label) out += `  Label:         ${sanitizeUntrustedInline(session.label, 100)}\n`;
    out += `  Network:       ${chainName(config.chainId)}\n`;
    out += `  TTL:           ${Math.ceil(ttlRemaining / 60)}m (expires ${expiresAt})\n\n`;
    out += `💳 **Session Payment**\n`;
    out += `  Amount:    ${paymentAmount.toString()} (base units)\n`;
    // Both come from the SDK's payment log: `recipient` is the 402's own
    // `payTo`, i.e. remote text, and `txHash` is whatever the write returned.
    // They sit in the trusted narration region above the fence, so they are
    // flattened and capped like every other untrusted value echoed there.
    out += `  Recipient: ${sanitizeUntrustedInline(paymentRecipient, 64)}\n`;
    out += `  TX Hash:   ${sanitizeUntrustedInline(paymentTxHash, 80)}\n\n`;
    out += `✅ **Next Steps**\n`;
    out += `  Use \`x402_session_fetch\` with session_id="${session.sessionId}" for all subsequent\n`;
    out += `  requests to ${sanitizeUntrustedUrl(input.endpoint)} — no further payments will be made during this session.\n`;
    out += `  Check session status with \`x402_session_status\`.\n\n`;
    out += `📄 **Initial Response** (${response.status})\n`;
    out += formatUntrustedBody(responseText, 4000);

    return { content: [textContent(out)] };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        content: [textContent(`❌ x402_session_start failed: Request timed out after ${input.timeout_ms ?? 30000}ms`)],
        isError: true,
      };
    }
    return {
      content: [textContent(formatError(error, 'x402_session_start'))],
      isError: true,
    };
  }
}

// ─── x402_session_fetch ────────────────────────────────────────────────────

export const X402SessionFetchSchema = z.object({
  session_id: z
    .string()
    .uuid()
    .describe('Session ID returned by x402_session_start.'),
  url: noControlChars(z.string().url())
    .describe('URL to fetch within the session. Must be covered by the session endpoint/scope.'),
  method: z
    .enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE'])
    .optional()
    .default('GET')
    .describe('HTTP method (default: GET)'),
  headers: z
    .record(z.string())
    .optional()
    .describe('Additional HTTP headers (session token is injected automatically)'),
  body: z
    .string()
    .optional()
    .describe('Request body for POST/PUT/PATCH requests'),
  timeout_ms: z
    .number()
    .int()
    .min(1000)
    .max(60000)
    .optional()
    .default(30000)
    .describe('Request timeout in milliseconds (default: 30000)'),
});

export type X402SessionFetchInput = z.infer<typeof X402SessionFetchSchema>;

export const x402SessionFetchTool = {
  name: 'x402_session_fetch',
  description:
    'Use after x402_session_start returns a valid session_id. Injects the stored session token and makes a covered request without a new payment. ' +
    'Do not use before initialize/session creation, as a payment bypass, after expiry, or for URLs outside the session scope.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID returned by x402_session_start. Required so AgentPay can attach the correct session token.',
      },
      url: {
        type: 'string',
        description: 'Absolute URL to fetch. Must be covered by the session scope or the call fails closed.',
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
        description: 'Additional request headers. The session token is injected automatically; do not supply private keys.',
      },
      body: {
        type: 'string',
        description: 'Request body for POST/PUT/PATCH covered by this paid session.',
      },
      timeout_ms: {
        type: 'number',
        description: 'Request timeout in milliseconds (default: 30000). The call returns an error instead of retrying payment on timeout.',
        default: 30000,
      },
    },
    required: ['session_id', 'url'],
  },
};

export async function handleX402SessionFetch(
  input: X402SessionFetchInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const timeoutMs = input.timeout_ms ?? 30000;

    // Look up session
    const lookup = lookupSession(input.session_id);

    if (!lookup.found) {
      return {
        content: [
          textContent(
            `❌ Session not found: "${sanitizeUntrustedInline(input.session_id, 100)}"\n\n` +
            `Create a new session with x402_session_start first.`
          ),
        ],
        isError: true,
      };
    }

    if (lookup.expired) {
      // An ended session carries a 0 expiresAt sentinel; report the expiry
      // baked into the issued token instead of claiming it lapsed in 1970.
      const endedLocally = wasEndedLocally(lookup.session);
      const tokenExpiresAt = new Date(tokenExpiryOf(lookup.session) * 1000).toISOString();
      return {
        content: [
          textContent(
            `⏰ **Session Expired**\n\n` +
            `  Session ID: ${sanitizeUntrustedInline(input.session_id, 100)}\n` +
            `  Endpoint:   ${sanitizeUntrustedUrl(lookup.session.endpoint)}\n` +
            (endedLocally
              ? `  Ended:      locally via x402_session_end\n` +
                `  Expires:    ${tokenExpiresAt} (issued token expiry)\n\n`
              : `  Expired at: ${tokenExpiresAt}\n\n`) +
            `Call x402_session_start to establish a new session for this endpoint.`
          ),
        ],
        isError: true,
      };
    }

    const { session } = lookup;

    // Validate URL is covered by the session scope
    const urlCovered = isUrlCoveredBySession(input.url, session);
    if (!urlCovered) {
      return {
        content: [
          textContent(
            `❌ URL not covered by this session.\n\n` +
            `  Session endpoint: ${sanitizeUntrustedUrl(session.endpoint)}\n` +
            `  Session scope:    ${session.scope}\n` +
            `  Requested URL:    ${sanitizeUntrustedUrl(input.url)}\n\n` +
            `This URL is outside the session's ${session.scope === 'exact' ? 'exact match' : 'prefix match'} scope.\n` +
            `Create a new session for this URL with x402_session_start, or use x402_pay for a one-time request.`
          ),
        ],
        isError: true,
      };
    }

    // Build request headers — inject session token automatically
    const sessionHeaders = buildSessionHeaders(session);
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

    // Make request — plain fetch, NO x402 payment client
    // The session token headers tell the server to bypass the payment flow
    const response = await fetch(input.url, requestInit);
    const responseText = await response.text();

    // Record the call in the session
    recordSessionCall(input.session_id);

    // Handle edge case: server still returned 402 (session not recognised)
    if (response.status === 402) {
      return {
        content: [
          textContent(
            `⚠️ **Server returned 402 — Session Not Recognised**\n\n` +
            `  URL:        ${sanitizeUntrustedUrl(input.url)}\n` +
            describeFinalUrl(input.url, response) +
            `  Session ID: ${sanitizeUntrustedInline(input.session_id, 100)}\n\n` +
            `The server returned HTTP 402 despite session headers being sent.\n` +
            `This means the server does not support x402 V2 session tokens yet,\n` +
            `or the session has been invalidated server-side.\n\n` +
            `Options:\n` +
            `  • Use x402_pay for a one-time payment to this URL\n` +
            `  • Contact the API provider about x402 V2 session support\n\n` +
            `📄 **Response Body**\n` +
            formatUntrustedBody(responseText, 2000)
          ),
        ],
        isError: true,
      };
    }

    const ttlRemaining = session.expiresAt - Math.floor(Date.now() / 1000);
    const callNumber = session.callCount; // after recordSessionCall incremented it

    let out = `⚡ **x402 Session Fetch** (call #${callNumber})\n\n`;
    out += `  Session ID:  ${session.sessionId}\n`;
    if (session.label) out += `  Label:       ${sanitizeUntrustedInline(session.label, 100)}\n`;
    out += `  URL:         ${sanitizeUntrustedUrl(input.url)}\n`;
    out += describeFinalUrl(input.url, response);
    out += `  Method:      ${method}\n`;
    out += `  Status:      ${formatHttpStatus(response.status)}\n`;
    out += `  Session TTL: ${Math.ceil(ttlRemaining / 60)}m remaining\n`;
    out += `  💰 No payment — session token used\n\n`;
    out += `📄 **Response Body**\n`;
    out += formatUntrustedBody(responseText, 8000);

    return { content: [textContent(out)] };
  } catch (error: unknown) {
    if (error instanceof Error && error.name === 'AbortError') {
      return {
        content: [textContent(`❌ x402_session_fetch failed: Request timed out after ${input.timeout_ms ?? 30000}ms`)],
        isError: true,
      };
    }
    return {
      content: [textContent(formatError(error, 'x402_session_fetch'))],
      isError: true,
    };
  }
}

// ─── x402_session_status ──────────────────────────────────────────────────

export const X402SessionStatusSchema = z.object({
  session_id: noControlChars(z.string().max(200))
    .optional()
    .describe(
      'Specific session ID to inspect. ' +
      'Omit to list all active sessions.'
    ),
});

export type X402SessionStatusInput = z.infer<typeof X402SessionStatusSchema>;

export const x402SessionStatusTool = {
  name: 'x402_session_status',
  description:
    'Check the status of x402 V2 payment sessions. ' +
    'Without arguments, lists all active sessions with TTL remaining. ' +
    'With a session_id, shows full details for that session including ' +
    'call count, payment info, and the signed session token.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Specific session ID to inspect. Omit to list all active sessions.',
      },
    },
    required: [],
  },
};

export async function handleX402SessionStatus(
  input: X402SessionStatusInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const now = Math.floor(Date.now() / 1000);

    if (input.session_id) {
      // Detailed view for a specific session
      const lookup = lookupSession(input.session_id);

      if (!lookup.found) {
        return {
          content: [
            textContent(
              `❌ Session not found: "${sanitizeUntrustedInline(input.session_id, 100)}"\n\n` +
              `Use x402_session_status (no arguments) to list active sessions.`
            ),
          ],
          isError: true,
        };
      }

      const { session, expired } = lookup;
      const ttlRemaining = Math.max(0, session.expiresAt - now);
      const decoded = decodeSessionToken(session.sessionToken);
      // Ending a session force-expires the local record but cannot move the
      // expiry baked into the issued token — report that one.
      const endedLocally = wasEndedLocally(session);
      const tokenExpiry = tokenExpiryOf(session);
      const tokenStillValid = tokenExpiry > now;

      let out = endedLocally
        ? `🛑 **Session Ended (locally)**\n\n`
        : expired
          ? `⏰ **Session Expired**\n\n`
          : `🔐 **Session Details**\n\n`;

      out += `  Session ID:    ${session.sessionId}\n`;
      if (session.label) out += `  Label:         ${sanitizeUntrustedInline(session.label, 100)}\n`;
      out += `  Status:        ${endedLocally ? '🛑 Ended locally' : expired ? '❌ Expired' : '✅ Active'}\n`;
      out += `  Endpoint:      ${sanitizeUntrustedUrl(session.endpoint)}\n`;
      out += `  Scope:         ${session.scope}\n`;
      out += `  Wallet:        ${session.walletAddress}\n\n`;

      out += `⏱️  **Timing**\n`;
      out += `  Created:       ${new Date(session.createdAt * 1000).toISOString()}\n`;
      out += `  Expires:       ${new Date(tokenExpiry * 1000).toISOString()}` +
        `${endedLocally ? ' (token expiry — unchanged by ending the session)' : ''}\n`;
      if (!expired) out += `  TTL Remaining: ${formatTtl(ttlRemaining)}\n`;
      out += `  Last Used:     ${session.lastUsedAt > 0 ? new Date(session.lastUsedAt * 1000).toISOString() : 'Never'}\n`;
      out += `  Call Count:    ${session.callCount}\n\n`;

      out += `💳 **Session Payment**\n`;
      out += `  TX Hash:       ${session.paymentTxHash}\n`;
      out += `  Amount:        ${session.paymentAmount} (base units)\n`;
      out += `  Recipient:     ${session.paymentRecipient}\n`;
      out += `  Token:         ${session.paymentToken === '0x0000000000000000000000000000000000000000' ? 'ETH (native)' : session.paymentToken}\n\n`;

      if (decoded) {
        out += `🔏 **Token Info**\n`;
        out += `  Protocol:      ${decoded.payload.version}\n`;
        out += `  Signature:     ${decoded.signature.slice(0, 20)}...${decoded.signature.slice(-8)}\n`;
      } else if (endedLocally) {
        out += `🔏 **Token**\n`;
        out += `  Discarded — this session was ended and the stored token material\n`;
        out += `  was scrubbed from this process.\n`;
        out += tokenStillValid
          ? `  ⚠️ Not revoked: the issued token cannot be revoked, so any copy that\n` +
            `     already left this process stays technically valid to the endpoint\n` +
            `     until ${new Date(tokenExpiry * 1000).toISOString()}.\n`
          : `  Its own expiry has since passed, so a conforming endpoint rejects it.\n`;
      }

      return { content: [textContent(out)] };
    }

    // List all active sessions
    const active = listActiveSessions();

    if (active.length === 0) {
      return {
        content: [
          textContent(
            `📋 **Active Sessions**\n\n` +
            `No active sessions. Use x402_session_start to establish a session.\n\n` +
            `ℹ️  Sessions are stored in-process and survive for their configured TTL.\n` +
            `   Default TTL: 3600 seconds (1 hour). Set SESSION_TTL_SECONDS to override.`
          ),
        ],
      };
    }

    let out = `📋 **Active x402 Sessions** (${active.length})\n\n`;

    for (const session of active) {
      const ttlRemaining = Math.max(0, session.expiresAt - now);
      const ttlBar = ttlProgressBar(ttlRemaining, session.expiresAt - session.createdAt);

      out += `─────────────────────────────────────\n`;
      out += `  ID:       ${session.sessionId}\n`;
      if (session.label) out += `  Label:    ${sanitizeUntrustedInline(session.label, 100)}\n`;
      out += `  Endpoint: ${sanitizeUntrustedUrl(session.endpoint)}\n`;
      out += `  Scope:    ${session.scope}\n`;
      out += `  TTL:      ${formatTtl(ttlRemaining)} ${ttlBar}\n`;
      out += `  Calls:    ${session.callCount}\n`;
      out += `  Payment:  ${session.paymentAmount} base units → TX ${session.paymentTxHash.slice(0, 18)}...\n`;
      out += '\n';
    }

    out += `\nUse x402_session_fetch with a session_id to make free calls within a session.\n`;
    out += `Use x402_session_status with session_id="..." for full session details.`;

    return { content: [textContent(out)] };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'x402_session_status'))],
      isError: true,
    };
  }
}

// ─── x402_session_end ─────────────────────────────────────────────────────

export const X402SessionEndSchema = z.object({
  session_id: z
    .string()
    .uuid()
    .describe('Session ID to close.'),
});

export type X402SessionEndInput = z.infer<typeof X402SessionEndSchema>;

export const x402SessionEndTool = {
  name: 'x402_session_end',
  description:
    'Close an x402 V2 session locally before it expires naturally: this server discards its stored copy of the session token and x402_session_fetch will return an error for the closed session. ' +
    'This is NOT server-side revocation — the signed bearer token cannot be revoked once issued, and any copy already sent to (or intercepted en route to) the remote endpoint remains technically valid there until the expiry baked into the token. ' +
    'If you suspect the token leaked, treat it as live until that expiry and notify the endpoint operator. ' +
    'Still useful hygiene: it stops further use from this process and scrubs the stored token material.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID to close (from x402_session_start)',
      },
    },
    required: ['session_id'],
  },
};

export async function handleX402SessionEnd(
  input: X402SessionEndInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const lookup = lookupSession(input.session_id);

    if (!lookup.found) {
      return {
        content: [
          textContent(
            `❌ Session not found: "${sanitizeUntrustedInline(input.session_id, 100)}"`
          ),
        ],
        isError: true,
      };
    }

    if (lookup.expired) {
      const now = Math.floor(Date.now() / 1000);
      const expiredSession = lookup.session;
      const alreadyEnded = wasEndedLocally(expiredSession);
      const tokenExpiry = tokenExpiryOf(expiredSession);
      const tokenExpiresAtIso = new Date(tokenExpiry * 1000).toISOString();
      // Sanitize once, at capture: the endpoint is echoed both directly and
      // through tokenStillValidNote, and it is remote-influenced.
      const expiredEndpoint = sanitizeUntrustedUrl(expiredSession.endpoint);
      const expiredSessionId = sanitizeUntrustedInline(input.session_id, 100);

      // Scrub here too. An expired record lingers in the store until the next
      // pruneExpired(), and until then the token material is still readable
      // (e.g. x402_session_status token info), so ending must always clear it.
      endSession(input.session_id);

      let out = alreadyEnded
        ? `ℹ️ Session "${expiredSessionId}" was already ended locally.\n\n`
        : `ℹ️ Session "${expiredSessionId}" was already expired.\n\n`;
      out += `  Endpoint:   ${expiredEndpoint}\n`;
      out += `  Expires:    ${tokenExpiresAtIso} (issued token expiry)\n\n`;
      out += `Local state cleared: this server holds no copy of the session token.\n\n`;
      out += tokenStillValidNote(tokenExpiry > now, expiredEndpoint, tokenExpiresAtIso);

      return { content: [textContent(out)] };
    }

    const { session } = lookup;
    // Capture display fields BEFORE endSession: it force-expires the record
    // and scrubs the stored token material in place (the expiry survives on
    // the record as tokenExpiresAt so status can still report it).
    const tokenExpiry = session.expiresAt;
    const tokenExpiresAt = new Date(tokenExpiry * 1000).toISOString();
    // Sanitized at capture: the endpoint is remote-influenced and is echoed
    // both directly and inside tokenStillValidNote.
    const endpoint = sanitizeUntrustedUrl(session.endpoint);
    const callCount = session.callCount;
    const tokenStillValid = tokenExpiry > Math.floor(Date.now() / 1000);
    endSession(input.session_id);

    return {
      content: [
        textContent(
          `✅ **Session Closed (locally)**\n\n` +
          `  Session ID: ${session.sessionId}\n` +
          `  Endpoint:   ${endpoint}\n` +
          `  Calls made: ${callCount}\n\n` +
          `Local state cleared: this server discarded its stored copy of the session\n` +
          `token, and x402_session_fetch will refuse this session from now on.\n\n` +
          tokenStillValidNote(tokenStillValid, endpoint, tokenExpiresAt) +
          `\nUse x402_session_start to establish a new session when needed.`
        ),
      ],
    };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'x402_session_end'))],
      isError: true,
    };
  }
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * The honest closing note for an x402_session_end report.
 *
 * Ending a session is local-only: the issued token is a self-contained signed
 * bearer credential with its expiry baked into the signed payload, and there
 * is no revocation exchange, so a copy that already left this process stays
 * valid to the endpoint until that expiry. Once the expiry has passed, say so
 * instead of raising an alarm that no longer applies.
 */
function tokenStillValidNote(
  stillValid: boolean,
  endpoint: string,
  expiresAtIso: string
): string {
  if (!stillValid) {
    return (
      `The token's own expiry has already passed, so a conforming endpoint\n` +
      `rejects it from now on.\n`
    );
  }
  return (
    `⚠️ **Not revoked server-side.** The session token is a self-contained signed\n` +
    `bearer credential and cannot be revoked once issued. Any copy that already\n` +
    `left this process remains technically valid to ${endpoint}\n` +
    `until it expires at ${expiresAtIso}.\n` +
    `If you suspect the token leaked, treat it as live until then and notify the\n` +
    `endpoint operator so they can block it server-side.\n`
  );
}

/**
 * Format TTL seconds as a human-readable string.
 */
function formatTtl(seconds: number): string {
  if (seconds <= 0) return 'Expired';
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

/**
 * Generate a simple ASCII progress bar for TTL remaining.
 */
function ttlProgressBar(remaining: number, total: number): string {
  if (total <= 0) return '';
  const pct = Math.max(0, Math.min(1, remaining / total));
  const filled = Math.round(pct * 10);
  const empty = 10 - filled;
  const bar = '█'.repeat(filled) + '░'.repeat(empty);
  const emoji = pct > 0.5 ? '🟢' : pct > 0.2 ? '🟡' : '🔴';
  return `${emoji} [${bar}]`;
}

// Re-export session manager utilities for use by x402_pay auto-session feature
export { findSessionForUrl, buildSessionHeaders };
