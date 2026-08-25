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
 *      hops are followed manually so a 302 to another path on the paid host
 *      still works; a different origin is refused so the bearer token never
 *      leaves the host that was paid for.
 */

import {
  PAYMENT_SESSION_HEADER,
  SESSION_TOKEN_HEADER,
  SESSION_WALLET_HEADER,
} from '../session/manager.js';

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

export function isSessionCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return SESSION_CREDENTIAL_HEADERS.some((header) => header.toLowerCase() === lower);
}

/**
 * Convert a Fetch `HeadersInit` into a plain record so we can strip and
 * re-apply credential headers by name.
 */
export function headersToRecord(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...headers };
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

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Fetch `url` with session credentials attached.
 *
 * Session headers are applied last. Redirects are resolved only while the
 * next hop stays on the same origin; a cross-origin Location is an error
 * (and is not fetched).
 */
export async function fetchWithSessionCredentials(
  url: string,
  init: RequestInit,
  sessionHeaders: Record<string, string>
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
      return response;
    }

    let next: URL;
    let current: URL;
    try {
      next = new URL(location, currentUrl);
      current = new URL(currentUrl);
    } catch {
      return response;
    }

    if (next.origin !== current.origin) {
      throw new CrossOriginSessionRedirectError(current.origin, next.origin);
    }

    // 303 (and historical 301/302 on non-GET) switch to GET without a body.
    const method = (currentInit.method ?? 'GET').toUpperCase();
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method !== 'GET' && method !== 'HEAD')
    ) {
      const { body: _droppedBody, ...withoutBody } = currentInit;
      currentInit = { ...withoutBody, method: 'GET' };
    }

    currentUrl = next.href;
  }

  throw new Error(
    `Too many same-origin redirects while attaching session credentials (max ${MAX_SAME_ORIGIN_REDIRECTS}).`
  );
}
