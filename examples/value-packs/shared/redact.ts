/**
 * shared/redact.ts — the examples' copy of agentpay-mcp's redacting sink
 * (src/utils/sink.ts, pay-2b round 3). Every line an example prints goes
 * through exampleLog / exampleError / exampleWrite, which redact configured
 * secrets, RPC URLs with keys, bearer tokens, payment headers, private keys
 * and mnemonics first. The region between the BEGIN/END markers is byte-for-
 * byte identical to the server's; a test fails if they drift.
 *
 * Self-contained on purpose (no viem import) so any example can use it: the
 * BIP-39 wordlist is not loaded, so mnemonics are matched by shape (exactly
 * 12 or 24 lowercase words) instead.
 */
import { format } from 'node:util';

function bip39Words(): Set<string> | null {
  return null;
}

// BEGIN redact-core (vendored verbatim into examples/value-packs/shared/redact.ts;
// tests/output-sink.test.ts fails if the copies drift)
type Env = Record<string, string | undefined>

const SECRET_ENV_NAME = /(KEY|TOKEN|SECRET|PASSWORD|AUTH)$/i
const ALWAYS_SECRET_ENV = ['RPC_URL', 'AGENT_PRIVATE_KEY']
const MIN_SECRET_LEN = 8
const SECRET_QUERY_PARAM = /^(key|apikey|api_key|api-key|token|access_token|auth|secret|password|signature|sig)$/i

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** R1: every configured secret value, verbatim (with and without 0x, any hex case). */
function secretValues(env: Env): string[] {
  const values = new Set<string>()
  for (const [name, raw] of Object.entries(env)) {
    if (!raw || (!ALWAYS_SECRET_ENV.includes(name) && !SECRET_ENV_NAME.test(name))) continue
    const v = raw.trim()
    if (v.length < MIN_SECRET_LEN) continue
    values.add(v)
    if (/^0x[0-9a-fA-F]+$/.test(v)) values.add(v.slice(2))
  }
  // Longest first so a value that contains another is removed whole.
  return [...values].sort((a, b) => b.length - a.length)
}

/**
 * R3/S3: reduce a credential-bearing URL to scheme://host:port. Userinfo is
 * never kept; path and query are masked. URLs without credentials pass through.
 */
function redactUrl(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const hasUserinfo = parsed.username !== '' || parsed.password !== '' || /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(url)
  // An API-key-shaped path segment (Alchemy, Infura, QuickNode): 20+ token
  // characters mixing letters and digits. Ordinary slugs (`paid-during-outage`)
  // carry no digits and pass through.
  const longSegment = parsed.pathname
    .split('/')
    .some((seg) => /^[A-Za-z0-9_-]{20,}$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg))
  const secretQuery = [...parsed.searchParams.keys()].some((k) => SECRET_QUERY_PARAM.test(k))
  if (!hasUserinfo && !longSegment && !secretQuery) return url
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${parsed.protocol}//${parsed.hostname}${port}/[redacted]`
}

const URL_RE = /\b(?:https?|wss?):\/\/[^\s"'<>`)\]]+/gi
// Hex-bounded, not \b-bounded: ANSI codes (`\x1b[0m`) end in a word char.
const HEX64_RE = /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g
const HASH_LABEL = /(tx|hash|transaction|block)/i
const HEADER_RE = /\b(authorization|proxy-authorization|x-payment-response|x-payment|cookie|set-cookie)(\s*[:=]\s*)("?)[^\r\n"]+\3/gi
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
const WORD_RUN_RE = /\b[a-z]{3,8}(?: [a-z]{3,8}){11,23}\b/g

/** R5: a run of 12–24 BIP-39 words (12/15/18/21/24) is masked. */
function redactMnemonics(text: string): string {
  return text.replace(WORD_RUN_RE, (run) => {
    const words = run.split(' ')
    const BIP39 = bip39Words()
    // Without the wordlist, fall back to the shape alone: exactly 12 or 24 words.
    if (!BIP39) return words.length === 12 || words.length === 24 ? '[redacted-mnemonic]' : run
    // Find any window of 12+ consecutive wordlist words.
    let streak = 0
    for (const w of words) {
      streak = BIP39.has(w) ? streak + 1 : 0
      if (streak >= 12) return '[redacted-mnemonic]'
    }
    return run
  })
}

/**
 * Strip secrets from text before it is shown to anyone. Rules, in order:
 *  R1 configured secret env values verbatim (RPC_URL, AGENT_PRIVATE_KEY, and
 *     any *KEY/*TOKEN/*SECRET/*PASSWORD/*AUTH), before any exemption (S2)
 *  R2 viem's `URL: <endpoint>` field
 *  R3 credential-bearing URLs reduced to scheme://host:port (S3)
 *  R4 bare 32-byte hex unless labelled as a tx/block hash
 *  R5 BIP-39 mnemonics
 *  R6 Authorization / X-PAYMENT / cookie headers and bearer tokens
 *  R7 idempotent, total (never throws), linear-time patterns
 * Public addresses, tx hashes and the deployment identity are not secrets.
 */
export function redactSecrets(
  text: string,
  env: Env = process.env,
  opts: { errorContext?: boolean } = {}
): string {
  try {
    let out = String(text)
    // R1 (S2: unconditional, before the R4 tx-hash exemption)
    for (const v of secretValues(env)) {
      out = out.replace(new RegExp(escapeRegExp(v), 'gi'), '[redacted]')
    }
    // R2: viem's transport errors print `URL: <endpoint>` right after
    // "... request failed." or right before "Request body:".
    out = out.replace(/(request failed\.?[ \t]*(?:\r?\n[ \t]*)+)URL:[ \t]*(?!\[redacted\])\S+/gi, '$1URL: [redacted]')
    out = out.replace(/\bURL:[ \t]*(?!\[redacted\])\S+(?=[ \t]*\r?\n[ \t]*Request body:)/g, 'URL: [redacted]')
    // In error text (SDK/RPC/transport messages) every `URL:` field is masked.
    if (opts.errorContext) out = out.replace(/\bURL:[ \t]*(?!\[redacted\])\S+/g, 'URL: [redacted]')
    // R3
    out = out.replace(URL_RE, (u) => redactUrl(u))
    // R6
    out = out.replace(HEADER_RE, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    out = out.replace(BEARER_RE, 'Bearer [redacted]')
    // R4
    out = out.replace(HEX64_RE, (match, _p, offset: number, whole: string) => {
      const before = whole.slice(Math.max(0, offset - 16), offset)
      return HASH_LABEL.test(before) ? match : '[redacted-hex64]'
    })
    // R5
    out = redactMnemonics(out)
    return out
  } catch {
    return '[output withheld: redaction failed]'
  }
}
// END redact-core

export function exampleSafeText(text: string): string {
  return redactSecrets(text);
}

/** console.log replacement: redacted, newline-terminated, to stdout. */
export function exampleLog(...args: unknown[]): void {
  process.stdout.write(exampleSafeText(format(...args)) + '\n');
}

/** console.error replacement: redacted, newline-terminated, to stderr. */
export function exampleError(...args: unknown[]): void {
  process.stderr.write(exampleSafeText(format(...args)) + '\n');
}

/** Raw (no newline) redacted stdout write, for spinners. */
export function exampleWrite(text: string): void {
  process.stdout.write(exampleSafeText(text));
}
