/**
 * session/manager.ts — x402 V2 session lifecycle management.
 *
 * This module implements the "wallet-based access & reusable sessions" concept
 * introduced in x402 V2. Agents pay once to establish a cryptographically
 * authenticated session, then make N subsequent calls without additional
 * on-chain transactions.
 *
 * Non-custodial design:
 *   - Session tokens are signed locally by the agent's private key
 *   - No third party holds or validates keys
 *   - Servers receive a self-contained signed token they can independently verify
 *   - The SessionManager has zero knowledge of private keys; it only receives
 *     a signMessage callback injected at creation time
 *
 * Token format:
 *   X-Session-Token: <base64url(JSON payload)>.<hex signature>
 *   Compatible with x402 V2 SIGN-IN-WITH-X (SIWx) header pattern
 *   Servers can ecrecover the wallet address without any external service
 */

import { randomUUID } from 'crypto';
import type {
  SessionRecord,
  SessionTokenPayload,
  CreateSessionOptions,
  SessionLookupResult,
} from './types.js';

// ─── Constants ─────────────────────────────────────────────────────────────

/** Default session TTL in seconds (1 hour) */
const DEFAULT_TTL_SECONDS = 3600;

/**
 * HTTP header name for session tokens.
 * x402 V2 uses modernised header names (no X- prefix per IETF conventions
 * for new standard headers). We use PAYMENT-SESSION for the session token
 * and retain X-Session-Token as an alias for broad compatibility.
 */
export const SESSION_TOKEN_HEADER = 'X-Session-Token';
export const SESSION_WALLET_HEADER = 'X-Session-Wallet';
export const PAYMENT_SESSION_HEADER = 'PAYMENT-SESSION';

// ─── Session store ─────────────────────────────────────────────────────────

/**
 * In-memory session store. Sessions survive within the MCP server process
 * lifetime (typically as long as the AI client has the server running).
 *
 * Key: sessionId (UUIDv4)
 * Value: SessionRecord
 */
const store = new Map<string, SessionRecord>();

// ─── Public API ────────────────────────────────────────────────────────────

/**
 * Create a new session after a successful x402 payment.
 *
 * Signs a canonical token payload with the agent's private key, creating
 * a self-verifiable session token that servers can use to grant access
 * without requiring a new on-chain payment.
 */
export async function createSession(opts: CreateSessionOptions): Promise<SessionRecord> {
  const sessionId = randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const ttl = opts.ttlSeconds ?? parseTtlFromEnv();
  const expiresAt = now + ttl;

  const payload: SessionTokenPayload = {
    version: 'clawpay/1.1',
    sessionId,
    walletAddress: opts.walletAddress,
    endpoint: opts.endpoint,
    scope: opts.scope ?? 'prefix',
    createdAt: now,
    expiresAt,
    paymentTxHash: opts.paymentTxHash,
    paymentAmount: opts.paymentAmount.toString(),
  };

  // Deterministic canonical JSON (keys sorted alphabetically)
  const canonicalPayload = canonicalise(payload as unknown as Record<string, unknown>);
  const payloadB64 = Buffer.from(canonicalPayload).toString('base64url');

  // Sign with agent's private key — non-custodial, local only
  const signature = await opts.signMessage(canonicalPayload);

  // Combined token: base64url(payload).hexSignature
  const sessionToken = `${payloadB64}.${signature}`;

  const record: SessionRecord = {
    sessionId,
    endpoint: opts.endpoint,
    scope: opts.scope ?? 'prefix',
    walletAddress: opts.walletAddress,
    createdAt: now,
    expiresAt,
    paymentTxHash: opts.paymentTxHash,
    paymentAmount: opts.paymentAmount.toString(),
    paymentToken: opts.paymentToken,
    paymentRecipient: opts.paymentRecipient,
    sessionToken,
    signature,
    label: opts.label,
    callCount: 0,
    lastUsedAt: now,
  };

  store.set(sessionId, record);
  pruneExpired();

  return record;
}

/**
 * Look up a session by ID.
 * Returns the record and whether it has expired.
 */
export function lookupSession(sessionId: string): SessionLookupResult {
  const session = store.get(sessionId);
  if (!session) return { found: false };

  const now = Math.floor(Date.now() / 1000);
  const expired = now >= session.expiresAt;

  return { found: true, session, expired };
}

/**
 * Record a call made within a session.
 * Updates callCount and lastUsedAt in-place.
 */
export function recordSessionCall(sessionId: string): void {
  const session = store.get(sessionId);
  if (!session) return;

  // Mutate callCount and lastUsedAt (the only mutable fields)
  const mutable = session as { callCount: number; lastUsedAt: number };
  mutable.callCount += 1;
  mutable.lastUsedAt = Math.floor(Date.now() / 1000);
}

/**
 * Explicitly end a session (mark as expired by setting expiresAt to past).
 * Returns true if the session was found and ended.
 */
export function endSession(sessionId: string): boolean {
  const session = store.get(sessionId);
  if (!session) return false;

  // Force-expire it
  const mutable = session as { expiresAt: number };
  mutable.expiresAt = 0;
  return true;
}

/**
 * List all active (non-expired) sessions.
 */
export function listActiveSessions(): SessionRecord[] {
  pruneExpired();
  const now = Math.floor(Date.now() / 1000);
  return Array.from(store.values()).filter((s) => s.expiresAt > now);
}

/**
 * List all sessions (including expired).
 */
export function listAllSessions(): SessionRecord[] {
  return Array.from(store.values());
}

/**
 * Find the best matching active session for a given URL.
 * Prefers exact-scope matches over prefix-scope.
 * Used to auto-attach a session to x402_pay when available.
 */
export function findSessionForUrl(url: string): SessionRecord | undefined {
  const now = Math.floor(Date.now() / 1000);

  // Collect all valid sessions
  const active = Array.from(store.values()).filter((s) => s.expiresAt > now);

  // Try exact match first
  const exact = active.find((s) => s.scope === 'exact' && s.endpoint === url);
  if (exact) return exact;

  // Try prefix match
  const prefix = active.find((s) => s.scope === 'prefix' && isUrlCoveredBySession(url, s));
  if (prefix) return prefix;

  return undefined;
}

/**
 * Check if a URL is covered by a session's endpoint + scope.
 *
 * Prefix sessions cover the endpoint path itself, query strings on that path,
 * and descendants below that path. They do not cover raw string lookalikes such
 * as /v10 for /v1, or host/path prefixes on a different origin. Trailing
 * slashes are normalised, so a session for /v1/ behaves identically to one
 * for /v1 (and a request to /v1/ matches an endpoint of /v1).
 *
 * Query parameters on the session endpoint are treated as REQUIRED
 * parameters: the requested URL must carry every endpoint parameter with an
 * equal value. Parameter order never matters (comparison goes through
 * URLSearchParams, with duplicate keys compared as value multisets), and
 * extra request parameters are allowed. The requirement applies to the
 * endpoint path itself and to sub-paths alike — e.g. /v1/users?version=2 is
 * covered by a session for /v1?version=2, but /v1/users without it is not.
 * That last case fails CLOSED deliberately: dropping a required parameter
 * changes what the server serves, so requiring it everywhere is the safe
 * reading.
 */
export function isUrlCoveredBySession(
  url: string,
  session: { endpoint: string; scope: 'prefix' | 'exact' }
): boolean {
  try {
    const requested = new URL(url);
    const endpoint = new URL(session.endpoint);

    if (session.scope === 'exact') {
      return requested.href === endpoint.href;
    }

    if (requested.origin !== endpoint.origin) {
      return false;
    }

    if (!containsRequiredSearchParams(requested.searchParams, endpoint.searchParams)) {
      return false;
    }

    const endpointPath = normalisePathname(endpoint.pathname);
    const requestedPath = normalisePathname(requested.pathname);

    if (requestedPath === endpointPath) return true;

    const boundaryPrefix = endpointPath === '/' ? '/' : `${endpointPath}/`;
    return requestedPath.startsWith(boundaryPrefix);
  } catch {
    return false;
  }
}

/**
 * Build the HTTP headers to include in a session-authenticated request.
 * These headers are inspired by x402 V2's SIGN-IN-WITH-X (SIWx) pattern
 * and the PAYMENT-SESSION header spec.
 */
export function buildSessionHeaders(session: SessionRecord): Record<string, string> {
  return {
    [SESSION_TOKEN_HEADER]: session.sessionToken,
    [SESSION_WALLET_HEADER]: session.walletAddress,
    [PAYMENT_SESSION_HEADER]: session.sessionId,
  };
}

/**
 * Decode a session token string into its payload and signature.
 * Useful for display / debugging purposes.
 */
export function decodeSessionToken(token: string): {
  payload: SessionTokenPayload;
  signature: string;
} | null {
  const dotIdx = token.lastIndexOf('.');
  if (dotIdx === -1) return null;

  const payloadB64 = token.slice(0, dotIdx);
  const signature = token.slice(dotIdx + 1);

  try {
    const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf-8');
    const payload = JSON.parse(payloadJson) as SessionTokenPayload;
    return { payload, signature };
  } catch {
    return null;
  }
}

/**
 * Get total sessions count (active + expired).
 */
export function getStoreSize(): number {
  return store.size;
}

/**
 * Clear all sessions — for testing only.
 */
export function _clearAllSessions(): void {
  store.clear();
}

// ─── Internal helpers ──────────────────────────────────────────────────────

/**
 * Produce a deterministic canonical JSON representation.
 * Keys are sorted alphabetically to ensure signing is reproducible.
 */
function canonicalise(obj: Record<string, unknown>): string {
  const sorted = Object.keys(obj)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = obj[key];
      return acc;
    }, {});
  return JSON.stringify(sorted);
}

/**
 * Strip trailing slashes from a pathname so /v1/ and /v1 compare equal.
 * The root path is preserved as '/'.
 */
function normalisePathname(pathname: string): string {
  let normalised = pathname || '/';
  while (normalised.length > 1 && normalised.endsWith('/')) {
    normalised = normalised.slice(0, -1);
  }
  return normalised;
}

/**
 * Check that every required (key, value) pair is present in the requested
 * search params. Order-insensitive; duplicate keys are compared as value
 * multisets (each required value must appear at least as many times in the
 * request); extra request parameters are allowed.
 */
function containsRequiredSearchParams(
  requested: URLSearchParams,
  required: URLSearchParams
): boolean {
  for (const key of new Set(required.keys())) {
    const requiredValues = required.getAll(key);
    const requestedValues = requested.getAll(key);
    for (const value of new Set(requiredValues)) {
      const requiredCount = requiredValues.filter((v) => v === value).length;
      const requestedCount = requestedValues.filter((v) => v === value).length;
      if (requestedCount < requiredCount) return false;
    }
  }
  return true;
}

/**
 * Remove expired sessions from the store.
 * Called automatically on create and list operations.
 */
function pruneExpired(): void {
  const now = Math.floor(Date.now() / 1000);
  for (const [id, session] of store.entries()) {
    if (session.expiresAt <= now) {
      store.delete(id);
    }
  }
}

/**
 * Parse session TTL from environment variable.
 */
function parseTtlFromEnv(): number {
  const raw = process.env['SESSION_TTL_SECONDS'];
  if (!raw) return DEFAULT_TTL_SECONDS;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed <= 0) return DEFAULT_TTL_SECONDS;
  // Cap at 30 days
  return Math.min(parsed, 86400 * 30);
}
