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
import { textContent, formatError, chainName } from '../utils/format.js';
import { supportedX402NetworksForChainId } from '../utils/x402-networks.js';
import {
  createSession,
  lookupSession,
  recordSessionCall,
  endSession,
  listActiveSessions,
  findSessionForUrl,
  buildSessionHeaders,
  decodeSessionToken,
} from '../session/manager.js';

// ─── x402_session_start ────────────────────────────────────────────────────

export const X402SessionStartSchema = z.object({
  endpoint: z
    .string()
    .url()
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
      'Session lifetime in seconds (default: SESSION_TTL_SECONDS env var or 3600). ' +
      'Min: 60 seconds. Max: 30 days.'
    ),
  label: z
    .string()
    .max(100)
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
    'Establish an x402 V2 payment session: make a SINGLE on-chain payment and receive ' +
    'a cryptographically signed session token. All subsequent calls to the same endpoint ' +
    'within the session lifetime use x402_session_fetch — no additional payments required. ' +
    'Agents pay once per session rather than once per API call. ' +
    'Session tokens are signed locally by your wallet key (non-custodial). ' +
    'Returns a session_id you pass to x402_session_fetch for all future calls.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      endpoint: {
        type: 'string',
        description: 'Base URL to establish a session for (e.g., "https://api.example.com/v1")',
      },
      scope: {
        type: 'string',
        enum: ['prefix', 'exact'],
        description: '"prefix": covers all paths under this URL (default). "exact": single URL only.',
        default: 'prefix',
      },
      ttl_seconds: {
        type: 'number',
        description: 'Session TTL in seconds (default: 3600 / 1 hour). Max: 30 days.',
      },
      label: {
        type: 'string',
        description: 'Optional label for this session (e.g., "Premium API session")',
      },
      max_payment_eth: {
        type: 'string',
        description: 'Maximum ETH to pay for this session. Rejects if price exceeds this.',
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
        description: 'Additional request headers',
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

    // Parse optional payment cap
    let maxPaymentWei: bigint | undefined;
    if (input.max_payment_eth) {
      const cap = parseFloat(input.max_payment_eth);
      if (isNaN(cap) || cap <= 0) {
        throw new Error(`Invalid max_payment_eth: "${input.max_payment_eth}"`);
      }
      maxPaymentWei = BigInt(Math.round(cap * 1e18));
    }

    // Track payment
    let paymentMade = false;
    let paymentAmount = 0n;
    let paymentTxHash = '';
    let paymentRecipient = '';
    let paymentToken = '0x0000000000000000000000000000000000000000';

    // x402 client to handle the one-time session payment
    const x402Client = createX402Client(wallet, {
      autoPay: true,
      maxRetries: 1,
      supportedNetworks: supportedX402NetworksForChainId(config.chainId),
      globalPerRequestMax: maxPaymentWei,
      onBeforePayment: (req) => {
        const amount = BigInt(req.amount);
        if (maxPaymentWei && amount > maxPaymentWei) {
          throw new Error(
            `Session payment (${amount} wei) exceeds max_payment_eth cap ` +
            `(${maxPaymentWei} wei = ${input.max_payment_eth} ETH). ` +
            `Set a higher max_payment_eth to proceed.`
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
            `  Endpoint: ${input.endpoint}\n` +
            `  Status:   ${response.status} ${response.statusText}\n\n` +
            `No x402 payment was needed. The endpoint responded without requiring payment.\n` +
            `You do not need a session token — use x402_pay directly for free endpoints.\n\n` +
            `📄 **Response Body**\n` +
            '```\n' + responseText.slice(0, 4000) + (responseText.length > 4000 ? '\n... [truncated]' : '') + '\n```'
          ),
        ],
      };
    }

    // Create signed session record
    // The signMessage function uses viem's wallet client, signing locally with the agent's key
    const signMessage = async (message: string): Promise<string> => {
      // Access the walletClient from the wallet instance for local signing
      const wc = (wallet as unknown as { walletClient: { signMessage: (args: { message: string }) => Promise<string> } }).walletClient;
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
    out += `  Endpoint:      ${session.endpoint}\n`;
    out += `  Scope:         ${session.scope}\n`;
    if (session.label) out += `  Label:         ${session.label}\n`;
    out += `  Network:       ${chainName(config.chainId)}\n`;
    out += `  TTL:           ${Math.ceil(ttlRemaining / 60)}m (expires ${expiresAt})\n\n`;
    out += `💳 **Session Payment**\n`;
    out += `  Amount:    ${paymentAmount.toString()} (base units)\n`;
    out += `  Recipient: ${paymentRecipient}\n`;
    out += `  TX Hash:   ${paymentTxHash}\n\n`;
    out += `✅ **Next Steps**\n`;
    out += `  Use \`x402_session_fetch\` with session_id="${session.sessionId}" for all subsequent\n`;
    out += `  requests to ${input.endpoint} — no further payments will be made during this session.\n`;
    out += `  Check session status with \`x402_session_status\`.\n\n`;
    out += `📄 **Initial Response** (${response.status})\n`;
    const truncated = responseText.length > 4000;
    out += '```\n' + responseText.slice(0, 4000) + (truncated ? '\n... [truncated]' : '') + '\n```';

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
  url: z
    .string()
    .url()
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
    'Make an HTTP request within an established x402 V2 session — NO payment required. ' +
    'The session token (signed by your wallet) is automatically attached to the request. ' +
    'The server recognises your session and grants access without a new on-chain payment. ' +
    'Requires a session_id from x402_session_start. ' +
    'Returns an error if the session has expired (call x402_session_start again to renew).',
  inputSchema: {
    type: 'object' as const,
    properties: {
      session_id: {
        type: 'string',
        description: 'Session ID from x402_session_start',
      },
      url: {
        type: 'string',
        description: 'URL to fetch (must be covered by the session)',
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
        description: 'Additional headers (session token is injected automatically)',
      },
      body: {
        type: 'string',
        description: 'Request body for POST/PUT/PATCH',
      },
      timeout_ms: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 30000)',
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
            `❌ Session not found: "${input.session_id}"\n\n` +
            `Create a new session with x402_session_start first.`
          ),
        ],
        isError: true,
      };
    }

    if (lookup.expired) {
      const expiredAt = new Date(lookup.session.expiresAt * 1000).toISOString();
      return {
        content: [
          textContent(
            `⏰ **Session Expired**\n\n` +
            `  Session ID: ${input.session_id}\n` +
            `  Endpoint:   ${lookup.session.endpoint}\n` +
            `  Expired at: ${expiredAt}\n\n` +
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
            `  Session endpoint: ${session.endpoint}\n` +
            `  Session scope:    ${session.scope}\n` +
            `  Requested URL:    ${input.url}\n\n` +
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
            `  URL:        ${input.url}\n` +
            `  Session ID: ${input.session_id}\n\n` +
            `The server returned HTTP 402 despite session headers being sent.\n` +
            `This means the server does not support x402 V2 session tokens yet,\n` +
            `or the session has been invalidated server-side.\n\n` +
            `Options:\n` +
            `  • Use x402_pay for a one-time payment to this URL\n` +
            `  • Contact the API provider about x402 V2 session support\n\n` +
            `📄 **Response Body**\n` +
            '```\n' + responseText.slice(0, 2000) + '\n```'
          ),
        ],
        isError: true,
      };
    }

    // Truncate very large responses
    const MAX_LEN = 8000;
    const truncated = responseText.length > MAX_LEN;
    const displayText = truncated
      ? responseText.slice(0, MAX_LEN) + '\n\n... [response truncated]'
      : responseText;

    const ttlRemaining = session.expiresAt - Math.floor(Date.now() / 1000);
    const callNumber = session.callCount; // after recordSessionCall incremented it

    let out = `⚡ **x402 Session Fetch** (call #${callNumber})\n\n`;
    out += `  Session ID:  ${session.sessionId}\n`;
    if (session.label) out += `  Label:       ${session.label}\n`;
    out += `  URL:         ${input.url}\n`;
    out += `  Method:      ${method}\n`;
    out += `  Status:      ${response.status} ${response.statusText}\n`;
    out += `  Session TTL: ${Math.ceil(ttlRemaining / 60)}m remaining\n`;
    out += `  💰 No payment — session token used\n\n`;
    out += `📄 **Response Body**\n`;
    out += '```\n' + displayText + '\n```';

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
  session_id: z
    .string()
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
              `❌ Session not found: "${input.session_id}"\n\n` +
              `Use x402_session_status (no arguments) to list active sessions.`
            ),
          ],
          isError: true,
        };
      }

      const { session, expired } = lookup;
      const ttlRemaining = Math.max(0, session.expiresAt - now);
      const decoded = decodeSessionToken(session.sessionToken);

      let out = expired
        ? `⏰ **Session Expired**\n\n`
        : `🔐 **Session Details**\n\n`;

      out += `  Session ID:    ${session.sessionId}\n`;
      if (session.label) out += `  Label:         ${session.label}\n`;
      out += `  Status:        ${expired ? '❌ Expired' : '✅ Active'}\n`;
      out += `  Endpoint:      ${session.endpoint}\n`;
      out += `  Scope:         ${session.scope}\n`;
      out += `  Wallet:        ${session.walletAddress}\n\n`;

      out += `⏱️  **Timing**\n`;
      out += `  Created:       ${new Date(session.createdAt * 1000).toISOString()}\n`;
      out += `  Expires:       ${new Date(session.expiresAt * 1000).toISOString()}\n`;
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
      if (session.label) out += `  Label:    ${session.label}\n`;
      out += `  Endpoint: ${session.endpoint}\n`;
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
    'Explicitly close an x402 V2 session before it expires naturally. ' +
    'After calling this, x402_session_fetch will return an error for the closed session. ' +
    'Useful for security hygiene or when you know a session is no longer needed.',
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
          textContent(`❌ Session not found: "${input.session_id}"`),
        ],
        isError: true,
      };
    }

    if (lookup.expired) {
      return {
        content: [
          textContent(
            `ℹ️ Session "${input.session_id}" was already expired.\n` +
            `Endpoint: ${lookup.session.endpoint}`
          ),
        ],
      };
    }

    const { session } = lookup;
    endSession(input.session_id);

    return {
      content: [
        textContent(
          `✅ **Session Closed**\n\n` +
          `  Session ID: ${session.sessionId}\n` +
          `  Endpoint:   ${session.endpoint}\n` +
          `  Calls made: ${session.callCount}\n\n` +
          `The session has been closed and can no longer be used.\n` +
          `Use x402_session_start to establish a new session when needed.`
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
 * Check if a URL is covered by a session's endpoint + scope.
 */
function isUrlCoveredBySession(
  url: string,
  session: { endpoint: string; scope: 'prefix' | 'exact' }
): boolean {
  if (session.scope === 'exact') {
    return url === session.endpoint;
  }
  // Prefix: URL must start with endpoint
  // Normalise: ensure endpoint doesn't end in slash for prefix matching
  const base = session.endpoint.endsWith('/') ? session.endpoint : session.endpoint + '/';
  return url === session.endpoint || url.startsWith(base) || url.startsWith(session.endpoint + '?');
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
