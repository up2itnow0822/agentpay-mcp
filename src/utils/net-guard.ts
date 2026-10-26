/**
 * net-guard.ts — shared outbound-destination classification.
 *
 * One implementation of "is this host/address safe for this server to
 * connect to on behalf of an untrusted MCP caller", used by every outbound
 * path: x402 paid fetches, session fetches, and the OTel kill callback.
 * Extracted from otel-budget.ts so the classifier cannot drift between
 * call sites.
 */

/** Name suffixes that only ever resolve inside a private network. */
export const PRIVATE_HOST_SUFFIXES = ['.internal', '.local', '.localhost', '.home.arpa']

/** Exact host names that are never a legitimate external webhook. */
export const PRIVATE_HOSTS = new Set(['localhost', 'metadata.google.internal'])


/**
 * Normalise a URL hostname for comparison: lower-cased, IPv6 brackets stripped,
 * and the FQDN root dot dropped ("localhost." is the same host as "localhost").
 *
 * Every trailing dot is dropped, not just one. The WHATWG parser preserves a
 * run of them verbatim ("metadata.google.internal.." stays two dots), so a
 * single-dot strip left "metadata.google.internal." — which matches neither the
 * exact-host set, nor the suffix list, nor an allowlist entry, and so sailed
 * through the whole name-based layer.
 */
export function normalizeHost(hostname: string): string {
  const host = hostname.toLowerCase()
  return host.startsWith('[') && host.endsWith(']')
    ? host.slice(1, -1)
    : host.replace(/\.+$/, '')
}

/**
 * True for a host name carrying an empty DNS label: a leading dot, or two or
 * more dots in a row anywhere (including the trailing run). The single trailing
 * root dot of an FQDN is not one, so "hooks.example.com." stays acceptable.
 *
 * Such a name is not resolvable, so refusing it costs nothing — and it has to be
 * refused *before* the operator allowlist is consulted, because normalizeHost
 * folds "orchestrator.svc.internal.." down onto the allowlisted
 * "orchestrator.svc.internal", which would otherwise hand a caller the
 * private-space waiver for a spelling the operator never wrote down.
 */
export function hasEmptyLabel(hostname: string): boolean {
  return /^\.|\.\./.test(hostname)
}


/** Parse a dotted-quad IPv4 literal into octets, or null if it is not one. */
export function parseIpv4(host: string): number[] | null {
  const parts = host.split('.')
  if (parts.length !== 4) return null
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN))
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) return null
  return octets
}

/**
 * True for IPv4 space that is not routable on the public internet: this-network,
 * loopback, RFC1918, link-local (which is where cloud instance-metadata lives),
 * CGNAT, multicast and reserved.
 *
 * The tail of the list is every remaining IANA special-purpose entry marked
 * "Globally Reachable: False" — IETF protocol assignments (192.0.0.0/24),
 * benchmarking (198.18.0.0/15) and the three documentation ranges
 * (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24). isPrivateIpv6 already
 * refused its documentation and benchmarking equivalents (2001:db8::/32,
 * 3fff::/20, 2001:2::/48), so leaving the IPv4 twins classified public was an
 * asymmetry, not a decision. None of them is routed, so a callback aimed at one
 * is either a misconfiguration or a probe; 198.18.0.0/15 in particular is
 * commonly bound on lab and appliance networks and reachable from the host.
 *
 * Not listed because an earlier rule already covers them: 240.0.0.0/4 (reserved)
 * and 255.255.255.255/32 (limited broadcast) both satisfy `a >= 224`. The
 * AS112 ranges (192.31.196.0/24, 192.175.48.0/24) and AMT (192.52.193.0/24) are
 * marked globally reachable by IANA and so stay accepted.
 */
export function isPrivateIpv4([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224 ||
    // IETF protocol assignments 192.0.0.0/24 and documentation 192.0.2.0/24.
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    // Benchmarking 198.18.0.0/15 and documentation 198.51.100.0/24.
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    // Documentation 203.0.113.0/24.
    (a === 203 && b === 0 && c === 113)
  )
}

/**
 * Expand an IPv6 literal into its eight 16-bit hextets, or null if it is not a
 * well-formed IPv6 address. Handles "::" compression and a trailing dotted-quad
 * (::ffff:127.0.0.1), because a textual prefix test cannot see through either.
 * The URL parser canonicalises the dotted-quad tail out of bracketed literals,
 * but a resolver answer is raw text and does carry that form, so both are
 * handled here.
 */
export function parseIpv6(host: string): number[] | null {
  if (host.includes('.')) {
    // Trailing dotted-quad form: rewrite the IPv4 tail as two hextets first.
    const lastColon = host.lastIndexOf(':')
    if (lastColon === -1) return null
    const v4 = parseIpv4(host.slice(lastColon + 1))
    if (v4 === null) return null
    const [a, b, c, d] = v4
    host = `${host.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`
  }

  const halves = host.split('::')
  if (halves.length > 2) return null
  const parseGroup = (group: string): number[] | null => {
    if (group === '') return []
    const parts = group.split(':')
    const out: number[] = []
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return null
      out.push(parseInt(part, 16))
    }
    return out
  }

  const head = parseGroup(halves[0])
  const tail = halves.length === 2 ? parseGroup(halves[1]) : []
  if (head === null || tail === null) return null

  if (halves.length === 1) return head.length === 8 ? head : null
  const gap = 8 - head.length - tail.length
  if (gap < 1) return null
  return [...head, ...Array<number>(gap).fill(0), ...tail]
}

/** True when a pair of hextets encodes an IPv4 address in private space. */
export function embeddedIpv4IsPrivate(hi: number, lo: number): boolean {
  return isPrivateIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff])
}

/**
 * True for IPv6 space that is not routable on the public internet, or that
 * tunnels an IPv4 target that is not: unspecified, loopback, unique-local
 * (fc00::/7), link-local (fe80::/10), deprecated site-local (fec0::/10),
 * multicast (ff00::/8), discard-only (100::/64), documentation (2001:db8::/32
 * and 3fff::/20), benchmarking (2001:2::/48), ORCHIDv2 (2001:20::/28), SRv6 SIDs
 * (5f00::/16), and every transition format that carries an IPv4 address inside
 * an IPv6 literal — IPv4-mapped (::ffff:0:0/96), IPv4-compatible (::a.b.c.d,
 * e.g. ::a9fe:a9fe for the metadata service), NAT64 (64:ff9b::/96), 6to4
 * (2002::/16) and Teredo (2001:0::/32). Each of the transition formats would
 * otherwise smuggle a private IPv4 destination past the IPv4 checks.
 *
 * The non-unicast and non-global ranges matter more here than they look: a
 * bracketed IPv6 literal gets no DNS backstop (resolvedHostIsPrivate returns
 * early for one, there being nothing to resolve), so for those hosts this
 * function is the only gate between an untrusted caller and the socket.
 * ff02::1 — all nodes on the local link — is the case that motivated the sweep.
 */
export function isPrivateIpv6(host: string): boolean {
  const h = parseIpv6(host)
  if (h === null) return true // Unparseable literal in brackets — refuse it.

  const zeroPrefix = (n: number): boolean => h.slice(0, n).every((x) => x === 0)

  // Unspecified (::) and loopback (::1). Deliberately redundant with the
  // IPv4-compatible rule below (:: is ::0.0.0.0 and ::1 is ::0.0.0.1, both of
  // which land in 0.0.0.0/8): the two most important addresses in this list
  // stay refused even if either rule is later narrowed.
  if (zeroPrefix(7) && (h[7] === 0 || h[7] === 1)) return true
  // Unique-local fc00::/7, link-local fe80::/10, deprecated site-local
  // fec0::/10 (RFC 3879 — deprecated, but still configured on older kit).
  if ((h[0] & 0xfe00) === 0xfc00) return true
  if ((h[0] & 0xffc0) === 0xfe80) return true
  if ((h[0] & 0xffc0) === 0xfec0) return true
  // Multicast ff00::/8. A webhook destination is unicast by definition, and the
  // link-local groups (ff02::1 all-nodes, ff02::2 all-routers) are reachable
  // from the host with no routing at all — the IPv6 twin of the IPv4 a >= 224
  // rule, which this function previously had no counterpart for.
  if ((h[0] & 0xff00) === 0xff00) return true
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d.
  if (zeroPrefix(5) && h[5] === 0xffff) return embeddedIpv4IsPrivate(h[6], h[7])
  if (zeroPrefix(6)) return embeddedIpv4IsPrivate(h[6], h[7])
  // NAT64 well-known prefix 64:ff9b::/96 and local-use 64:ff9b:1::/48.
  if (h[0] === 0x0064 && h[1] === 0xff9b) {
    return h[2] === 0x0001 || embeddedIpv4IsPrivate(h[6], h[7])
  }
  // 6to4 2002::/16 carries the IPv4 address in the next 32 bits.
  if (h[0] === 0x2002) return embeddedIpv4IsPrivate(h[1], h[2])
  // Teredo 2001:0::/32 carries the (bit-inverted) client IPv4 in the last 32.
  if (h[0] === 0x2001 && h[1] === 0x0000) {
    return embeddedIpv4IsPrivate(~h[6] & 0xffff, ~h[7] & 0xffff)
  }
  // Discard-only prefix 100::/64 (RFC 6666).
  if (h[0] === 0x0100 && h[1] === 0 && h[2] === 0 && h[3] === 0) return true
  // Benchmarking 2001:2::/48 (RFC 5180) and ORCHIDv2 2001:20::/28 (RFC 7343).
  // Both sit inside the IETF protocol-assignment block; neither is globally
  // reachable, and neither is caught by the Teredo rule above (h[1] !== 0).
  if (h[0] === 0x2001 && h[1] === 0x0002 && h[2] === 0x0000) return true
  if (h[0] === 0x2001 && (h[1] & 0xfff0) === 0x0020) return true
  // Documentation 2001:db8::/32 (RFC 3849) and 3fff::/20 (RFC 9637). Never
  // routed, so a callback aimed at one is either a mistake or a probe.
  if (h[0] === 0x2001 && h[1] === 0x0db8) return true
  if (h[0] === 0x3fff && (h[1] & 0xf000) === 0x0000) return true
  // SRv6 SIDs 5f00::/16 (RFC 9602) — segment identifiers, not destinations.
  if (h[0] === 0x5f00) return true
  return false
}

/**
 * Await a promise under an abort signal, rejecting as soon as the signal fires
 * rather than waiting for the promise to settle.
 *
 * The underlying promise is still awaited internally, so its eventual
 * settlement — including a rejection that arrives after the deadline — stays
 * handled and cannot surface as an unhandled rejection.
 */
export function withDeadline<T>(promise: Promise<T>, deadline?: AbortSignal): Promise<T> {
  if (!deadline) return promise
  if (deadline.aborted) return Promise.reject(deadline.reason)
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(deadline.reason)
    deadline.addEventListener('abort', onAbort, { once: true })
    promise.then(resolve, reject).finally(() => {
      deadline.removeEventListener('abort', onAbort)
    })
  })
}

// ─── Address and host classification ───────────────────────────────────────

/** A resolved, validated address that a connection may be pinned to. */
export interface PinnedAddress {
  address: string
  family: 4 | 6
}

/**
 * True when a resolver answer (or literal) is not a public unicast address.
 * Unparseable text is treated as private: anything we cannot classify is
 * refused rather than connected to.
 */
export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase()
  const v4 = parseIpv4(lower)
  if (v4 !== null) return isPrivateIpv4(v4)
  return isPrivateIpv6(lower)
}

/** True when `host` (already normalised) is an IPv4 or IPv6 literal. */
export function isIpLiteral(host: string): boolean {
  return parseIpv4(host) !== null || (host.includes(':') && parseIpv6(host) !== null)
}

/** True for names that only ever resolve inside a private network. */
export function isPrivateHostName(host: string): boolean {
  return PRIVATE_HOSTS.has(host) || PRIVATE_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))
}

/** Parse a comma-separated host allowlist from an environment variable. */
export function hostAllowlistFromEnv(envName: string): Set<string> {
  const raw = process.env[envName]
  if (!raw) return new Set()
  return new Set(
    raw
      .split(',')
      .map((entry) => normalizeHost(entry.trim()))
      .filter((entry) => entry !== '')
  )
}

export type HostResolver = (
  _hostname: string
) => Promise<Array<{ address: string; family: number }>>

/** Default resolver: every A/AAAA answer, verbatim order. */
export const systemResolver: HostResolver = async (hostname) => {
  const { lookup } = await import('node:dns/promises')
  return lookup(hostname, { all: true, verbatim: true })
}

/** Destination refused before any connection was attempted. */
export class UnsafeDestinationError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`Refused outbound request: ${reason}`)
    this.name = 'UnsafeDestinationError'
    this.reason = reason
  }
}

/**
 * Resolve `hostname` once and return the full validated answer set.
 *
 * Fails closed: an unresolvable name, an empty answer, or ANY answer in
 * private space rejects the whole host (a mixed public/private answer is the
 * classic rebinding set-up). The returned addresses are what the connection
 * must be pinned to — callers must never re-resolve the name.
 */
export async function resolvePublicAddresses(
  hostname: string,
  options: {
    allowPrivate?: boolean
    resolver?: HostResolver
    deadline?: AbortSignal
  } = {}
): Promise<PinnedAddress[]> {
  const host = normalizeHost(hostname)
  if (isIpLiteral(host)) {
    const family: 4 | 6 = parseIpv4(host) !== null ? 4 : 6
    if (!options.allowPrivate && isPrivateAddress(host)) {
      throw new UnsafeDestinationError(`"${host}" is a private, loopback or link-local address`)
    }
    return [{ address: host, family }]
  }

  let answers: Array<{ address: string; family: number }>
  try {
    answers = await withDeadline((options.resolver ?? systemResolver)(host), options.deadline)
  } catch (error: unknown) {
    if (options.deadline?.aborted) throw error
    throw new UnsafeDestinationError(`host "${host}" could not be resolved`)
  }
  if (!Array.isArray(answers) || answers.length === 0) {
    throw new UnsafeDestinationError(`host "${host}" resolved to no addresses`)
  }
  const pinned: PinnedAddress[] = []
  for (const answer of answers) {
    const address = String(answer.address).toLowerCase()
    const family: 4 | 6 = parseIpv4(address) !== null ? 4 : 6
    if (family === 6 && parseIpv6(address) === null) {
      throw new UnsafeDestinationError(`host "${host}" resolved to an unparseable address`)
    }
    if (!options.allowPrivate && isPrivateAddress(address)) {
      throw new UnsafeDestinationError(
        `host "${host}" resolves to a private, loopback or link-local address`
      )
    }
    pinned.push({ address, family })
  }
  return pinned
}
