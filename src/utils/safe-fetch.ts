/**
 * safe-fetch.ts — the only way this server makes an outbound HTTP request on
 * behalf of an MCP caller.
 *
 * Every caller-selected destination (x402_pay, x402_quote, x402_session_start,
 * x402_session_fetch, the OTel kill callback) goes through a transport created
 * here. One transport instance enforces, for its whole lifetime:
 *
 *   1. Scheme: http(s) only, and https only unless the caller opts out
 *      (`requireHttps: false`) or private-network development mode is on.
 *   2. No userinfo (`user:pass@host`) and no unresolvable empty-label names.
 *   3. Destination: the host is resolved ONCE, and if any answer is private,
 *      loopback, link-local, multicast or otherwise non-global the host is
 *      refused. Private-name suffixes (.internal, .local, …) are refused
 *      before any lookup.
 *   4. Pinning: the socket connects to an address from that validated answer
 *      set via a custom `lookup`, so a second DNS answer can never redirect the
 *      connection (closes DNS rebinding between check and connect). TLS SNI
 *      and the Host header still use the URL hostname, so certificate
 *      validation is unchanged. The pin is kept for the transport's lifetime,
 *      so the x402 paid retry reaches the same address as the 402 probe.
 *   5. No automatic redirects: a 3xx is returned to the caller as-is (or
 *      throws for `redirect: 'error'`), so a validated URL cannot bounce the
 *      request into private space.
 *   6. Bounded bodies: a declared Content-Length above the cap is refused
 *      before reading, and the body stream errors as soon as the cap is
 *      exceeded, so no reader (ours or the SDK's 402 parser) can be made to
 *      buffer an unbounded response. Responses are requested uncompressed;
 *      a compressed response is decoded with the cap applied to the decoded
 *      bytes, so a decompression bomb hits the same ceiling.
 *
 * Operators can permit specific private hosts with
 * AGENTPAY_ALLOWED_PRIVATE_HOSTS (comma-separated), or turn on private-network
 * development mode with AGENTPAY_ALLOW_PRIVATE_NETWORK=1. Both are off by
 * default.
 */
import http from 'node:http'
import https from 'node:https'
import type { LookupFunction } from 'node:net'
import { Readable } from 'node:stream'
import zlib from 'node:zlib'
import {
  hasEmptyLabel,
  hostAllowlistFromEnv,
  isIpLiteral,
  isPrivateAddress,
  isPrivateHostName,
  normalizeHost,
  resolvePublicAddresses,
  UnsafeDestinationError,
  type HostResolver,
  type PinnedAddress,
} from './net-guard.js'

export { UnsafeDestinationError } from './net-guard.js'

/** Hard ceiling on any response body read through a safe transport. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024
/** Soft ceiling for bodies rendered into tool results (truncated, not an error). */
export const MAX_DISPLAY_BODY_BYTES = 1024 * 1024

export const ALLOW_PRIVATE_NETWORK_ENV = 'AGENTPAY_ALLOW_PRIVATE_NETWORK'
export const ALLOWED_PRIVATE_HOSTS_ENV = 'AGENTPAY_ALLOWED_PRIVATE_HOSTS'

export type OutboundFetch = (_url: string, _init?: RequestInit) => Promise<Response>

/** Performs the actual I/O against an already-validated, pinned address set. */
export type OutboundConnector = (
  _url: URL,
  _init: RequestInit,
  _pinned: PinnedAddress[],
  _limits: { maxResponseBytes: number }
) => Promise<Response>

export interface SafeTransportOptions {
  /** Permit private/loopback destinations (development only). */
  allowPrivateNetwork?: boolean
  /** Hosts whose private destination is explicitly permitted. */
  allowedPrivateHosts?: Set<string>
  /** Require https: (default true). */
  requireHttps?: boolean
  /** Hard body cap in bytes (default MAX_RESPONSE_BYTES). */
  maxResponseBytes?: number
  /** Override DNS (tests). */
  resolver?: HostResolver
  /** Override the I/O layer (tests). */
  connector?: OutboundConnector
}

/** Response body exceeded the transport cap. */
export class ResponseTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`Response body exceeded the ${limit}-byte limit and was discarded.`)
    this.name = 'ResponseTooLargeError'
  }
}

// ─── Test seams ────────────────────────────────────────────────────────────

let testResolver: HostResolver | undefined
let testConnector: OutboundConnector | undefined

/**
 * Replace DNS and/or the I/O layer for every transport created afterwards.
 * Validation (scheme, userinfo, private names, private answers, pinning
 * bookkeeping) still runs; only the network edges are substituted.
 */
export function _setSafeTransportTestOverrides(overrides: {
  resolver?: HostResolver
  connector?: OutboundConnector
}): void {
  testResolver = overrides.resolver
  testConnector = overrides.connector
}

/** The connector a transport would use by default (honours test overrides). */
export function activeConnector(): OutboundConnector {
  return testConnector ?? nodeHttpConnector
}

export function _clearSafeTransportTestOverrides(): void {
  testResolver = undefined
  testConnector = undefined
}

function envFlag(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes'
}

// ─── Destination validation ────────────────────────────────────────────────

/**
 * Synchronous URL checks that need no DNS: scheme, userinfo, empty labels,
 * and private-only names. Returns the parsed URL.
 */
export function assertSafeUrl(
  raw: string,
  options: Pick<SafeTransportOptions, 'requireHttps' | 'allowPrivateNetwork' | 'allowedPrivateHosts'> = {}
): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new UnsafeDestinationError('not an absolute URL')
  }
  const allowPrivate = options.allowPrivateNetwork ?? envFlag(ALLOW_PRIVATE_NETWORK_ENV)
  const requireHttps = (options.requireHttps ?? true) && !allowPrivate
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new UnsafeDestinationError(`scheme "${url.protocol}" is not allowed`)
  }
  if (requireHttps && url.protocol !== 'https:') {
    throw new UnsafeDestinationError('https is required for this request')
  }
  if (url.username !== '' || url.password !== '') {
    throw new UnsafeDestinationError('URLs must not embed credentials (user:pass@host)')
  }
  const bracketed = url.hostname.startsWith('[')
  if (!bracketed && hasEmptyLabel(url.hostname)) {
    throw new UnsafeDestinationError(`host "${url.hostname}" is not externally routable`)
  }
  const host = normalizeHost(url.hostname)
  const allowlisted = (options.allowedPrivateHosts ?? hostAllowlistFromEnv(ALLOWED_PRIVATE_HOSTS_ENV)).has(host)
  if (!allowPrivate && !allowlisted && isPrivateHostName(host)) {
    throw new UnsafeDestinationError(`host "${host}" is a private network name`)
  }
  // Literal addresses need no DNS: refuse private ones synchronously so a
  // caller learns before any client, reservation, or session work starts.
  if (!allowPrivate && !allowlisted && isIpLiteral(host) && isPrivateAddress(host)) {
    throw new UnsafeDestinationError(`"${host}" is a private, loopback or link-local address`)
  }
  return url
}

// ─── Transport ─────────────────────────────────────────────────────────────

/**
 * Create a transport. Use one transport per logical tool call so the DNS pin
 * covers the probe, the paid retry, and any same-origin redirect hops.
 */
export function createSafeTransport(options: SafeTransportOptions = {}): OutboundFetch {
  const allowPrivate = options.allowPrivateNetwork ?? envFlag(ALLOW_PRIVATE_NETWORK_ENV)
  const allowlist = options.allowedPrivateHosts ?? hostAllowlistFromEnv(ALLOWED_PRIVATE_HOSTS_ENV)
  const maxResponseBytes = options.maxResponseBytes ?? MAX_RESPONSE_BYTES
  const resolver = options.resolver ?? testResolver
  const connector = options.connector ?? testConnector ?? nodeHttpConnector
  const pins = new Map<string, Promise<PinnedAddress[]>>()

  return async (raw: string, init: RequestInit = {}): Promise<Response> => {
    const url = assertSafeUrl(raw, {
      requireHttps: options.requireHttps,
      allowPrivateNetwork: allowPrivate,
      allowedPrivateHosts: allowlist,
    })
    const host = normalizeHost(url.hostname)
    let pinned = pins.get(host)
    if (!pinned) {
      pinned = resolvePublicAddresses(host, {
        allowPrivate: allowPrivate || allowlist.has(host),
        resolver,
        deadline: init.signal ?? undefined,
      })
      pins.set(host, pinned)
      // A failed resolution must not poison later calls on this transport
      // into a permanent rejection with a stale reason; it is re-tried (and
      // re-validated) next time.
      pinned.catch(() => pins.delete(host))
    }
    const addresses = await pinned
    return connector(url, init, addresses, { maxResponseBytes })
  }
}

// ─── Node http(s) connector (production) ───────────────────────────────────

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304])

function headersToNode(headers: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {}
  new Headers(headers).forEach((value, key) => {
    out[key] = value
  })
  return out
}

function bodyToBuffer(body: RequestInit['body']): Buffer | undefined {
  if (body === undefined || body === null) return undefined
  if (typeof body === 'string') return Buffer.from(body, 'utf8')
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8')
  if (body instanceof ArrayBuffer) return Buffer.from(body)
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength)
  throw new TypeError('safe-fetch only sends string, URLSearchParams, or byte bodies')
}

function pinnedLookup(pinned: PinnedAddress[]): LookupFunction {
  return ((_hostname: string, options: unknown, callback: unknown) => {
    const cb = (typeof options === 'function' ? options : callback) as (
      _err: NodeJS.ErrnoException | null,
      _address: string | Array<{ address: string; family: number }>,
      _family?: number
    ) => void
    const opts = (typeof options === 'object' && options !== null ? options : {}) as {
      all?: boolean
      family?: number
    }
    const candidates =
      opts.family === 4 || opts.family === 6
        ? pinned.filter((entry) => entry.family === opts.family)
        : pinned
    if (candidates.length === 0) {
      const error = new Error('no pinned address for the requested family') as NodeJS.ErrnoException
      error.code = 'ENOTFOUND'
      cb(error, '', 0)
      return
    }
    if (opts.all) {
      cb(null, candidates.map((entry) => ({ address: entry.address, family: entry.family })))
      return
    }
    cb(null, candidates[0]!.address, candidates[0]!.family)
  }) as LookupFunction
}

/** Count bytes through a stream and fail once the cap is exceeded. */
function capStream(source: NodeJS.ReadableStream, limit: number): Readable {
  let seen = 0
  const capped = new Readable({ read() {} })
  source.on('data', (chunk: Buffer) => {
    seen += chunk.length
    if (seen > limit) {
      capped.destroy(new ResponseTooLargeError(limit))
      ;(source as Readable).destroy?.()
      return
    }
    capped.push(chunk)
  })
  source.on('end', () => capped.push(null))
  source.on('error', (error: Error) => capped.destroy(error))
  capped.on('close', () => (source as Readable).destroy?.())
  return capped
}

function decoderFor(encoding: string | undefined): NodeJS.ReadWriteStream | null {
  switch ((encoding ?? '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return null
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip()
    case 'deflate':
      return zlib.createInflate()
    case 'br':
      return zlib.createBrotliDecompress()
    default:
      throw new TypeError(`unsupported content-encoding "${encoding}"`)
  }
}

export const nodeHttpConnector: OutboundConnector = (url, init, pinned, limits) =>
  new Promise<Response>((resolve, reject) => {
    const isHttps = url.protocol === 'https:'
    const headers = headersToNode(init.headers)
    // Never let a caller header switch on compression we would then have to
    // buffer; decoded bytes are capped either way.
    headers['accept-encoding'] = 'identity'
    let body: Buffer | undefined
    try {
      body = bodyToBuffer(init.body)
    } catch (error) {
      reject(error)
      return
    }
    if (body !== undefined) headers['content-length'] = String(body.length)

    const requestOptions: https.RequestOptions = {
      protocol: url.protocol,
      hostname: url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: `${url.pathname}${url.search}`,
      method: (init.method ?? 'GET').toUpperCase(),
      headers,
      agent: false,
      lookup: pinnedLookup(pinned),
      signal: init.signal ?? undefined,
    }
    const request = (isHttps ? https : http).request(requestOptions, (res) => {
      const status = res.statusCode ?? 0
      if (status >= 300 && status < 400 && init.redirect === 'error') {
        res.destroy()
        reject(new TypeError('fetch failed: redirect mode is set to "error"'))
        return
      }
      const declared = Number(res.headers['content-length'])
      if (Number.isFinite(declared) && declared > limits.maxResponseBytes) {
        res.destroy()
        reject(new ResponseTooLargeError(limits.maxResponseBytes))
        return
      }
      const responseHeaders = new Headers()
      for (let i = 0; i + 1 < res.rawHeaders.length; i += 2) {
        try {
          responseHeaders.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!)
        } catch {
          // Drop a header value Headers refuses rather than failing the call.
        }
      }
      let stream: NodeJS.ReadableStream = res
      let decoder: NodeJS.ReadWriteStream | null
      try {
        decoder = decoderFor(res.headers['content-encoding'] as string | undefined)
      } catch (error) {
        res.destroy()
        reject(error)
        return
      }
      if (decoder) {
        // The cap counts decoded bytes, so a decompression bomb is bounded.
        res.on('error', (error) => (decoder as unknown as Readable).destroy(error))
        stream = res.pipe(decoder)
        responseHeaders.delete('content-encoding')
        responseHeaders.delete('content-length')
      }
      const capped = capStream(stream, limits.maxResponseBytes)
      const nullBody = NULL_BODY_STATUSES.has(status) || init.method?.toUpperCase() === 'HEAD'
      if (nullBody) capped.destroy()
      let response: Response
      try {
        response = new Response(
          nullBody ? null : (Readable.toWeb(capped) as unknown as ReadableStream<Uint8Array>),
          {
            status: status >= 200 && status <= 599 ? status : 502,
            statusText: res.statusMessage ?? '',
            headers: responseHeaders,
          }
        )
      } catch (error) {
        capped.destroy()
        reject(error)
        return
      }
      Object.defineProperty(response, 'url', { value: url.href })
      resolve(response)
    })
    request.on('error', reject)
    if (body !== undefined) request.write(body)
    request.end()
  })

// ─── Bounded body reader ───────────────────────────────────────────────────

export interface LimitedText {
  text: string
  truncated: boolean
  bytes: number
}

/**
 * Read at most `maxBytes` of a response body as UTF-8 and cancel the rest.
 *
 * Used for every body rendered into a tool result, so display size never
 * depends on what the remote chose to send. A stream error (including the
 * transport's hard cap) propagates to the caller, which classifies it as a
 * pre- or post-settlement failure exactly as before.
 */
export async function readLimitedText(
  response: Response,
  maxBytes: number = MAX_DISPLAY_BODY_BYTES
): Promise<LimitedText> {
  if (!response.body) return { text: '', truncated: false, bytes: 0 }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8')
  let text = ''
  let bytes = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - bytes
      if (value.byteLength > remaining) {
        if (remaining > 0) text += decoder.decode(value.subarray(0, remaining), { stream: true })
        bytes += Math.max(remaining, 0)
        truncated = true
        break
      }
      bytes += value.byteLength
      text += decoder.decode(value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  return { text, truncated, bytes }
}
