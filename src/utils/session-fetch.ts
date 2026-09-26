/**
 * session-fetch.ts — fetch that attaches x402 session credentials safely.
 *
 * Two invariants for every request that carries a paid session token:
 *
 *   1. Session headers always win. Caller-supplied X-Session-Token /
 *      PAYMENT-SESSION / X-Session-Wallet (any casing) cannot replace the
 *      stored credential. On the x402_pay session-reuse path that overwrite
 *      used to produce a 402 and a second on-chain payment.
 *
 *   2. Redirects are not followed automatically. Node/undici `fetch` defaults
 *      to `redirect: 'follow'` and only strips `Authorization` on a
 *      cross-origin hop — custom entitlement headers are forwarded. Same-origin
 *      hops are followed only when the next URL is still inside the paid
 *      session scope. A different origin, or a same-origin path the payment
 *      does not cover (`/v10` when the session is `/v1`), is refused so the
 *      bearer token never leaves the resource that was paid for.
 */

import {
  isUrlCoveredBySession,
  PAYMENT_SESSION_HEADER,
  SESSION_TOKEN_HEADER,
  SESSION_WALLET_HEADER,
} from '../session/manager.js';

/** Paid session boundary used to decide whether a redirect may carry the token. */
export type SessionCredentialScope = {
  endpoint: string;
  scope: 'prefix' | 'exact';
};

/** Header names that must never be caller-overridable or cross-origin forwarded. */
export const SESSION_CREDENTIAL_HEADERS = [
  SESSION_TOKEN_HEADER,
  SESSION_WALLET_HEADER,
  PAYMENT_SESSION_HEADER,
] as const;

const MAX_SAME_ORIGIN_REDIRECTS = 5;

export class CrossOriginSessionRedirectError extends Error {
  constructor(
    readonly fromOrigin: string,
    readonly toOrigin: string
  ) {
    super(
      `Refusing to follow a cross-origin redirect from ${fromOrigin} to ${toOrigin} ` +
        'while session credentials are attached. Following it would forward the ' +
        'paid session token to a host that was not covered by the session.'
    );
    this.name = 'CrossOriginSessionRedirectError';
  }
}

export class SessionScopeRedirectError extends Error {
  constructor(
    readonly fromUrl: string,
    readonly toUrl: string
  ) {
    super(
      `Refusing to follow a redirect from ${fromUrl} to ${toUrl} ` +
        'because the target is outside the paid session scope. ' +
        'Following it would send the session token to a path the payment does not cover.'
    );
    this.name = 'SessionScopeRedirectError';
  }
}

export class MalformedRedirectLocationError extends Error {
  constructor(
    readonly fromUrl: string,
    readonly location: string
  ) {
    super(
      `Refusing to treat a malformed redirect Location as a successful session response ` +
        `(from ${fromUrl}, Location=${JSON.stringify(location)}). ` +
        'The previous automatic fetch path rejected invalid redirects; returning the raw ' +
        '3xx would make callers record an apparent Session Used.'
    );
    this.name = 'MalformedRedirectLocationError';
  }
}

export function isSessionCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SESSION_CREDENTIAL_HEADERS.some((header) => header.toLowerCase() === lower);
}

/**
 * Convert a Fetch headers init into a plain record so we can strip and
 * re-apply credential headers by name.
 */
function headerValueToString(value: string | readonly string[] | undefined): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  return value.join(', ');
}

export function headersToRecord(headers: RequestInit['headers']): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    const out: Record<string, string> = {};
    for (const [key, value] of headers) {
      out[key] = headerValueToString(value);
    }
    return out;
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = headerValueToString(value);
  }
  return out;
}

/**
 * Merge caller headers with session entitlement headers.
 *
 * Caller keys that collide with a session credential (any casing) are dropped
 * so a Fetch `Headers` object cannot send both the attacker value and the
 * real token, and so a later spread cannot replace the paid credential.
 */
export function mergeSessionHeaders(
  callerHeaders: Record<string, string> | undefined,
  sessionHeaders: Record<string, string>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [key, value] of Object.entries(callerHeaders ?? {})) {
    if (!isSessionCredentialHeader(key)) {
      merged[key] = value;
    }
  }
  return { ...merged, ...sessionHeaders };
}


/** Best-effort cancel of an unread/streaming body so undici frees the socket. */
async function cancelResponseBody(response: Response): Promise<void> {
  try {
    if (response.body && typeof response.body.cancel === 'function') {
      await response.body.cancel();
      return;
    }
  } catch {
    // ignore cancel races
  }
  try {
    await response.arrayBuffer();
  } catch {
    // ignore already-consumed / aborted bodies
  }
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch `url` with session credentials attached.
 *
 * Session headers are applied last. Redirects are resolved only while the
 * next hop stays on the same origin and inside `session`. A cross-origin
 * Location, or a same-origin Location outside the paid scope, is an error
 * and is not fetched.
 */
export async function fetchWithSessionCredentials(
  url: string,
  init: RequestInit,
  sessionHeaders: Record<string, string>,
  session: SessionCredentialScope
): Promise<Response> {
  const headers = mergeSessionHeaders(headersToRecord(init.headers), sessionHeaders);
  let currentUrl = url;
  let currentInit: RequestInit = { ...init, headers, redirect: 'manual' };

  for (let hop = 0; hop <= MAX_SAME_ORIGIN_REDIRECTS; hop++) {
    const response = await fetch(currentUrl, currentInit);

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get('location');
    if (!location) {
      // No Location to follow; hand the raw 3xx back (same as fetch).
      return response;
    }

    let next: URL;
    let current: URL;
    try {
      next = new URL(location, currentUrl);
      current = new URL(currentUrl);
    } catch {
      // Cancel the unread redirect body before throwing so undici does not
      // retain the socket until GC (Codex P2 on #50).
      await cancelResponseBody(response);
      throw new MalformedRedirectLocationError(currentUrl, location);
    }

    if (next.origin !== current.origin) {
      await cancelResponseBody(response);
      throw new CrossOriginSessionRedirectError(current.origin, next.origin);
    }

    // Origin equality is not the paid boundary: a prefix session for /v1 must
    // not attach the bearer token to /v10, or to any other uncovered path, on
    // the same host.
    if (!isUrlCoveredBySession(next.href, session)) {
      await cancelResponseBody(response);
      throw new SessionScopeRedirectError(current.href, next.href);
    }

    // Spec-aligned method rewrite: only POST+301/302 (and any-method 303)
    // switch to GET without a body. PUT/PATCH/DELETE on 301/302 must keep
    // method and body (Codex P2 on #50).
    const method = (currentInit.method ?? 'GET').toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      const { body: _droppedBody, ...withoutBody } = currentInit;
      currentInit = { ...withoutBody, method: 'GET' };
    }

    // Drop the intermediate body before the next hop so connections are released.
    await cancelResponseBody(response);
    currentUrl = next.href;
  }

  throw new Error(
    `Too many same-origin redirects while attaching session credentials (max ${MAX_SAME_ORIGIN_REDIRECTS}).`
  );
}
