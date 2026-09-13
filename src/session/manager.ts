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

  // Mutate callCount and lastUsedAt in place on the stored record.
  // (endSession also mutates expiresAt, tokenExpiresAt, sessionToken and
  // signature when a session is closed.)
  const mutable = session as { callCount: number; lastUsedAt: number };
  mutable.callCount += 1;
  mutable.lastUsedAt = Math.floor(Date.now() / 1000);
}

/**
 * Explicitly end a session LOCALLY: force-expire the record and discard the
 * stored token material (sessionToken + signature are overwritten) so the
 * credential can no longer be read back out of this process.
 *
 * IMPORTANT — this is not revocation. The session token is a self-contained
 * bearer credential signed at creation with its expiresAt baked into the
 * signed payload; remote servers verify it offline (ecrecover) with no
 * revocation registry to consult. Any copy of the token that already left
 * this process (it is transmitted on every session fetch) remains
 * technically valid to the remote endpoint until that baked-in expiry.
 * Callers reporting on this operation must not claim otherwise — and the
 * baked-in expiry is preserved in `tokenExpiresAt` precisely so they can
 * report it truthfully after `expiresAt` has been forced to 0.
 *
 * Returns true if the session was found and ended.
 */
export function endSession(sessionId: string): boolean {
  const session = store.get(sessionId);
  if (!session) return false;

  // Force-expire it and scrub the local copy of the bearer credential.
  const mutable = session as {
    expiresAt: number;
    tokenExpiresAt?: number;
    sessionToken: string;
    signature: string;
  };
  // Preserve when the issued token really lapses BEFORE zeroing expiresAt:
  // ending the session does not move that moment, and it is the only local
  // record of it. Written once, so ending an already-ended session cannot
  // overwrite the truth with the 0 sentinel.
  if (mutable.tokenExpiresAt === undefined) {
    mutable.tokenExpiresAt = mutable.expiresAt;
  }
  mutable.expiresAt = 0;
  mutable.sessionToken = '';
  mutable.signature = '';
  return true;
}

/**
 * True if this session was explicitly ended locally (endSession) rather than
 * simply reaching its natural expiry.
 */
export function wasEndedLocally(session: SessionRecord): boolean {
  return session.tokenExpiresAt !== undefined;
}

/**
 * When the ISSUED token stops being valid at the remote endpoint.
 *
 * For a live or naturally expired session this is just `expiresAt`. For an
 * ended session `expiresAt` is the 0 sentinel that makes the record unusable,
 * so the real expiry comes from `tokenExpiresAt`. Always use this for display:
 * reporting the sentinel would claim the token lapsed in 1970.
 */
export function tokenExpiryOf(session: SessionRecord): number {
  return session.tokenExpiresAt ?? session.expiresAt;
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
 * Prefers exact-scope matches over prefix-scope. Among overlapping
 * prefix sessions, prefers the longest (most specific) endpoint path.
 * Used to auto-attach a session to x402_pay when available.
 */
export function findSessionForUrl(url: string): SessionRecord | undefined {
  const now = Math.floor(Date.now() / 1000);

  // Collect all valid sessions
  const active = Array.from(store.values()).filter((s) => s.expiresAt > now);

  // Try exact match first
  const exact = active.find((s) => s.scope === 'exact' && s.endpoint === url);
  if (exact) return exact;

  const prefixMatches = active.filter(
    (s) => s.scope === 'prefix' && isUrlCoveredBySession(url, s)
  );
  if (prefixMatches.length === 0) return undefined;

  return prefixMatches.reduce((best, current) => {
    const bestPathLen = endpointPathLength(best.endpoint);
    const currentPathLen = endpointPathLength(current.endpoint);
    if (currentPathLen !== bestPathLen) {
      return currentPathLen > bestPathLen ? current : best;
    }
    // Same path length: prefer the more recently created session so a
    // newly paid, equally-specific session is not shadowed by an older one.
    return current.createdAt >= best.createdAt ? current : best;
  });
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
 * URLSearchParams, with duplicate keys compared as value multisets). For a
 * key the endpoint pins, the request's values for that key must equal the
 * endpoint's exactly — a contradictory duplicate such as ?user=alice&user=bob
 * against a pin of user=alice is rejected (HTTP parameter pollution).
 * Extra request parameters under OTHER keys are allowed. The requirement
 * applies to the
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

    // No path normalization: servers may distinguish /v1 from /v1/, and a
    // payment-scoped session must never cover a route it was not created
    // for. Coverage is exactly: the endpoint path itself, or a descendant
    // under an explicit '/' boundary. An endpoint of /v1 covers /v1, /v1/
    // and /v1/users (boundary '/v1/'); an endpoint of /v1/ covers /v1/ and
    // /v1/users but NOT the parent /v1.
    const endpointPath = endpoint.pathname;
    const requestedPath = requested.pathname;

    if (requestedPath === endpointPath) return true;

    const boundaryPrefix = endpointPath.endsWith('/') ? endpointPath : `${endpointPath}/`;
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
 * Pathname length used to rank overlapping prefix sessions.
 * Longer paths are more specific (`/v1/premium` beats `/v1`).
 */
function endpointPathLength(endpoint: string): number {
  try {
    return new URL(endpoint).pathname.length;
  } catch {
    return 0;
  }
}

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
 * Check that every required (key, value) pair is present in the requested
 * search params. Order-insensitive. For each key the endpoint pins, the
 * requested values must EQUAL the required values as a multiset — extra or
 * duplicate values under a pinned key are rejected, which blocks HTTP
 * parameter pollution (?user=alice&user=bob smuggling past a pin of
 * user=alice). Request parameters under keys the endpoint does not pin are
 * allowed.
 */
function containsRequiredSearchParams(
  requested: URLSearchParams,
  required: URLSearchParams
): boolean {
  for (const key of new Set(required.keys())) {
    const requiredValues = [...required.getAll(key)].sort();
    const requestedValues = [...requested.getAll(key)].sort();
    if (requestedValues.length !== requiredValues.length) return false;
    for (let i = 0; i < requiredValues.length; i++) {
      if (requestedValues[i] !== requiredValues[i]) return false;
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
