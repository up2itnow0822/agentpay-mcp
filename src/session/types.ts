/**
 * session/types.ts — Type definitions for x402 V2 session management.
 *
 * x402 V2 introduced the concept of "wallet-based access & reusable sessions":
 * agents pay once to establish a session, then skip on-chain payment on every
 * subsequent call within that session. This module defines the data structures
 * that AgentPay MCP uses to implement this pattern non-custodially.
 *
 * Reference: https://www.x402.org/writing/x402-v2-launch
 *   "V2 protocol now includes the logic to support wallet-controlled sessions,
 *    allowing clients to skip the full payment flow for repeated access if the
 *    resource was previously purchased."
 */

// ─── Session record (stored in-process) ──────────────────────────────────

export interface SessionRecord {
  /** Unique session identifier (UUIDv4) */
  readonly sessionId: string;

  /**
   * Base URL this session covers.
   * All requests to URLs matching this prefix (or exact URL) are included.
   */
  readonly endpoint: string;

  /**
   * Scope of the session:
   *  - "prefix": covers all paths under the endpoint (e.g., all of api.example.com/v1/*)
   *  - "exact":  covers only the single URL that was paid for
   */
  readonly scope: 'prefix' | 'exact';

  /** Wallet address that owns this session (from AGENT_WALLET_ADDRESS) */
  readonly walletAddress: string;

  /** Unix timestamp (seconds) when the session was created */
  readonly createdAt: number;

  /** Unix timestamp (seconds) when the session expires */
  readonly expiresAt: number;

  /**
   * Expiry (Unix seconds) baked into the ISSUED token, preserved when the
   * session is ended locally. endSession() forces `expiresAt` to 0 so the
   * record can never be used again, which would otherwise destroy the only
   * local record of when the bearer token actually stops being valid at the
   * remote endpoint (it cannot be revoked, so that moment is unchanged by
   * ending the session). Display code must report THIS value, not the
   * force-expired `expiresAt`. Undefined for sessions never ended.
   */
  readonly tokenExpiresAt?: number;

  /** On-chain transaction hash of the initial session payment */
  readonly paymentTxHash: string;

  /** Amount paid (in base units / wei) as a string-encoded bigint */
  readonly paymentAmount: string;

  /** Token address that was paid (zero address = native ETH) */
  readonly paymentToken: string;

  /** Recipient address of the initial payment */
  readonly paymentRecipient: string;

  /**
   * Cryptographic session token.
   * Base64url-encoded JSON payload signed by the agent's private key using
   * secp256k1 ECDSA (viem signMessage). Presented to servers as the
   * X-Session-Token header — compatible with x402 V2's SIGN-IN-WITH-X pattern.
   */
  readonly sessionToken: string;

  /**
   * ECDSA signature over the token payload.
   * Servers can verify ownership of walletAddress without any custody.
   */
  readonly signature: string;

  /**
   * Human-readable label for this session (optional, set by caller).
   */
  readonly label?: string;

  /** Number of requests made within this session */
  callCount: number;

  /** Last request timestamp (Unix seconds) */
  lastUsedAt: number;
}

// ─── Token payload (what gets signed) ────────────────────────────────────

/**
 * Canonical payload signed by the agent wallet.
 * This is serialised to a deterministic JSON string before signing.
 * Servers that implement x402 V2 session verification can reconstruct this
 * and call `ecrecover` / viem's `verifyMessage` to confirm wallet identity.
 */
export interface SessionTokenPayload {
  /** Protocol version marker */
  version: 'clawpay/1.1';

  sessionId: string;
  walletAddress: string;
  endpoint: string;
  scope: 'prefix' | 'exact';
  createdAt: number;
  expiresAt: number;
  paymentTxHash: string;
  paymentAmount: string;
}

// ─── Session creation input ───────────────────────────────────────────────

export interface CreateSessionOptions {
  endpoint: string;
  scope?: 'prefix' | 'exact';
  ttlSeconds?: number;
  label?: string;
  paymentTxHash: string;
  paymentAmount: bigint;
  paymentToken: string;
  paymentRecipient: string;
  walletAddress: string;
  /** viem signMessage function — must match walletAddress */
  signMessage: (_message: string) => Promise<string>;
}

// ─── Session lookup result ────────────────────────────────────────────────

export type SessionLookupResult =
  | { found: true; session: SessionRecord; expired: false }
  | { found: true; session: SessionRecord; expired: true }
  | { found: false };

// ─── Session-aware fetch options ──────────────────────────────────────────

export interface SessionFetchOptions {
  sessionId: string;
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  body?: string;
  timeoutMs?: number;
}
