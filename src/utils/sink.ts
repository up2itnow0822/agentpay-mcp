/**
 * The single redacting output sink (pay-2b round 3, SO f9fa2539).
 *
 * Every user-visible string — MCP tool results, stderr logs, CLI output —
 * passes through {@link safeText}, which applies {@link redactSecrets}.
 * tests/output-sink.test.ts fails the build if any file in src/ or examples/
 * writes output without going through this module.
 */
import { format } from 'node:util'
import * as viemAccounts from 'viem/accounts'
import { runWithScrubBudget, ScrubBudgetExceededError, truncateForPreScrub } from './scrub-pipeline.js'
import { maskSensitiveTextFields } from './sink-sensitive-text.js'
import {
  REDACTION_GUARD_ERROR_TEXT,
  PRE_SCRUB_CAP_BYTES,
  PRE_SCRUB_CUT_MARKER,
  PRE_SCRUB_TAIL_DROP_BYTES,
  TEXT_OUTPUT_MAX_BYTES,
  testScrubBudgetMs,
} from './scrub-bounds.js'

export { ScrubBudgetExceededError } from './scrub-pipeline.js'
export { PRE_SCRUB_CAP_BYTES, PRE_SCRUB_CUT_MARKER, PRE_SCRUB_TAIL_DROP_BYTES, testScrubBudgetMs } from './scrub-bounds.js'
export { REDACTION_GUARD_ERROR_TEXT, TEXT_OUTPUT_MAX_BYTES } from './scrub-bounds.js'

let bip39: Set<string> | null | undefined
/** The BIP-39 English wordlist viem ships; null if unavailable (e.g. a test mock). */
function bip39Words(): Set<string> | null {
  if (bip39 !== undefined) return bip39
  try {
    const list = (viemAccounts as { english?: readonly string[] }).english
    bip39 = Array.isArray(list) && list.length === 2048 ? new Set(list) : null
  } catch {
    bip39 = null
  }
  return bip39
}

// BEGIN redact-core (vendored verbatim into examples/value-packs/shared/redact.ts;
// tests/output-sink.test.ts fails if the copies drift)
type Env = Record<string, string | undefined>

const SECRET_ENV_NAME =
  /(KEY|TOKEN|SECRET|PASSWORD|AUTH|PAT|PASSPHRASE|MNEMONIC|SEED|SEED_PHRASE|CREDENTIALS)$/i
const ALWAYS_SECRET_ENV = ['RPC_URL', 'AGENT_PRIVATE_KEY']
const MIN_SECRET_LEN = 8
const SECRET_QUERY_PARAM =
  /^(key|apikey|api_key|api-key|x-api-key|api_key|token|access[-_]?token|client[-_]?secret|auth|secret|password|signature|sig|credentials)$/i
const HASH_LABEL_LOOKBACK = 40

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
    if (raw !== v && raw.length >= MIN_SECRET_LEN) values.add(raw)
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
  // characters mixing letters and digits, or any 32+ token-character run
  // (digit-only or letter-only keys). Ordinary slugs (`paid-during-outage`)
  // are shorter or contain no digits, and pass through.
  const pathSegs = parsed.pathname.split('/').filter(Boolean)
  const longSegment = pathSegs.some(
    (seg, i) =>
      /^[A-Za-z0-9_-]{32,}$/.test(seg) ||
      (/^[A-Za-z0-9_-]{20,}$/.test(seg) && /[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) ||
      (['v2', 'v3', 'ws'].includes(pathSegs[i - 1]?.toLowerCase() ?? '') &&
        /^[A-Za-z0-9_-]{8,}$/.test(seg) &&
        ((/[0-9]/.test(seg) && /[A-Za-z]/.test(seg)) || seg.length >= 16))
  )
  const secretQuery = [...parsed.searchParams.keys()].some((k) => SECRET_QUERY_PARAM.test(k))
  if (!hasUserinfo && !longSegment && !secretQuery) return url
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${parsed.protocol}//${parsed.hostname}${port}/[redacted]`
}

// `[` ends a URL too, so an earlier `[redacted]` never hides a key path from R3.
// No leading \b: `abhttps://…` must match in the first pass too (R7 idempotence).
const URL_RE = /(?:https?|wss?):\/\/[^\s"'<>`)\[\]]+/gi
// Hex-bounded, not \b-bounded: ANSI codes (`\x1b[0m`) end in a word char.
const HEX64_RE = /(?<![0-9a-fA-F])(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/g
const SPLIT_HEX64_RE =
  /(?:^|(?<=[\s(,]))(?:0x)?(?:[0-9a-fA-F]{2}(?:[ \t\u00a0]+)){31}[0-9a-fA-F]{2}(?![0-9a-fA-F])/gi
const SPLIT_HEX32_PAIR_RE =
  /(?:^|(?<=[\s(,=]))(?:0x)?[0-9a-fA-F]{32}(?:[ \t\u00a0]+)[0-9a-fA-F]{32}(?![0-9a-fA-F])/gi
const TX_HASH_LABEL =
  /\b(?:txHash|tx_hash|transactionHash|blockHash|block|hash|tx)\s*:\s*$/i
const JSON_TX_HASH_VALUE =
  /"(?:[A-Za-z0-9_]*(?:txHash|tx_hash|transactionHash|blockHash)|hash|tx|block)"\s*:\s*"(?:0x)?$/i
const HTTP_REDACT_HEADER_NAMES = [
  'authorization',
  'proxy-authorization',
  'x-auth-token',
  'x-api-key',
  'api-key',
  'x-payment',
  'x-payment-response',
  'cookie',
  'cookie2',
  'set-cookie',
] as const
const HTTP_HEADER_NAME_ALT = HTTP_REDACT_HEADER_NAMES.join('|')
const HTTP_HEADER_COOKIE_ONLY = 'cookie'
const HTTP_HEADER_SET_COOKIE = 'set-cookie'
const HTTP_HEADER_COOKIE_PAIR_ALT = `${HTTP_HEADER_COOKIE_ONLY}|${HTTP_HEADER_SET_COOKIE}`
const HTTP_HEADER_NON_COOKIE_ALT = HTTP_REDACT_HEADER_NAMES.filter(
  (n) => n !== 'cookie' && n !== 'set-cookie'
).join('|')
const COOKIE_HEADER_LINE_RE = new RegExp(
  `(?<!set-)(?<![a-zA-Z0-9])(${HTTP_HEADER_COOKIE_ONLY})(\\s*[:=]\\s*)([^\\r\\n]*)`,
  'gi'
)
const JSON_EMBEDDED_COOKIE_LINE_RE = new RegExp(
  `(?:\\\\r\\\\n|\\\\n)\\s*(${HTTP_HEADER_COOKIE_ONLY})(\\s*[:=]\\s*)((?:[^"\\\\]|\\\\.)*)`,
  'gi'
)
const SET_COOKIE_HEADER_LINE_RE = new RegExp(
  `\\b(${HTTP_HEADER_SET_COOKIE})(\\s*[:=]\\s*)([^\\r\\n]*)`,
  'gi'
)
const HEADER_RE = new RegExp(
  `\\b(${HTTP_HEADER_NON_COOKIE_ALT})(\\s*[:=]\\s*)([^\\r\\n]*)`,
  'gi'
)
const JSON_COOKIE_HEADER_ARRAY_RE = new RegExp(
  `"(${HTTP_HEADER_COOKIE_PAIR_ALT})"\\s*:\\s*(\\[[\\s\\S]*?\\])`,
  'gi'
)
const SINGLE_QUOTED_COOKIE_HEADER_ARRAY_RE = new RegExp(
  `'(${HTTP_HEADER_COOKIE_PAIR_ALT})'\\s*:\\s*(\\[[\\s\\S]*?\\])`,
  'gi'
)
const CLI_SENSITIVE_FLAG_RE =
  /\B--(?:access[-_]?token|api[-_]?key|client[-_]?secret|password|secret|x[-_]?api[-_]?key)(?:=|\s+)([^\s"'`,]+)/gi
const JSON_HEADER_RE = new RegExp(
  `"(${HTTP_HEADER_NAME_ALT})"\\s*:\\s*"([^"]*)"`,
  'gi'
)
const SINGLE_QUOTED_HEADER_RE = new RegExp(
  `'(${HTTP_HEADER_NON_COOKIE_ALT})'\\s*:\\s*'[^']*'`,
  'gi'
)
const SINGLE_QUOTED_COOKIE_HEADER_RE = new RegExp(
  `'(${HTTP_HEADER_COOKIE_ONLY})'\\s*:\\s*[^\\r\\n]*`,
  'gi'
)
const SINGLE_QUOTED_SET_COOKIE_HEADER_RE = new RegExp(
  `'(${HTTP_HEADER_SET_COOKIE})'\\s*:\\s*([^\\r\\n]*)`,
  'gi'
)
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi
const USERINFO_AT_RE =
  /(?:^|(?<=[\s(,;"'`]))([a-zA-Z0-9._-]{1,64}):([^@\s'"`,;]+)@([a-zA-Z0-9][a-zA-Z0-9.-]*)/g
/** R6: JWT-shaped tokens (three base64url segments; header segment starts with eyJ). */
const JWT_RE = /eyJ[A-Za-z0-9_-]*(?:\s*\.\s*)[A-Za-z0-9_-]+(?:\s*\.\s*)[A-Za-z0-9_-]+/g
// Any whitespace between words (incl. NBSP), so a mnemonic split across lines still matches.
const WORD_RUN_RE =
  /(?:\d+[.)]\s*)?[a-zA-Z]{3,8}(?:(?:[ \t\r\n\u00a0]+(?:\d+[.)]\s*)?)[a-zA-Z]{3,8}){11,23}\b/g
const COMMA_MNEMONIC_RE =
  /\b(?:[a-zA-Z]{3,8}\s*,\s*){11,}[a-zA-Z]{3,8}\b/g
const JSON_ARRAY_MNEMONIC_RE =
  /\[("(?:\\.|[^"\\])*"(?:\s*,\s*"(?:\\.|[^"\\])*"){11,})\]/g

function mnemonicWords(run: string): string[] {
  return run
    .split(/[ \t\r\n\u00a0]+/)
    .filter((w) => w.length > 0 && !/^\d+[.)]?$/.test(w))
    .map((w) => w.toLowerCase())
}

function hexHashExempt(offset: number, whole: string): boolean {
  const before = whole.slice(Math.max(0, offset - HASH_LABEL_LOOKBACK), offset)
  if (TX_HASH_LABEL.test(before)) return true
  const jsonBefore = whole.slice(Math.max(0, offset - 64), offset)
  return JSON_TX_HASH_VALUE.test(jsonBefore)
}

const SET_COOKIE_ATTR = /^(?:Path|Domain|Expires|Max-Age|SameSite)$/i
const SET_COOKIE_FLAG = /^(?:HttpOnly|Secure)$/i

function splitFoldedSetCookieHeaderValue(raw: string): string[] {
  const chunks: string[] = []
  let start = 0
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== ',') continue
    const tail = raw.slice(i + 1).trimStart()
    if (/^[A-Za-z0-9_-]+\s*=/.test(tail)) {
      chunks.push(raw.slice(start, i).trim())
      start = i + 1
    }
  }
  chunks.push(raw.slice(start).trim())
  return chunks
}

/** Mask the first cookie-pair on Set-Cookie; keep declared attributes; mask later name=value pairs. */
function redactSetCookieHeaderValue(raw: string): string {
  if (raw.includes(',') && /=/.test(raw)) {
    return splitFoldedSetCookieHeaderValue(raw).map((c) => redactOneSetCookieChunk(c)).join(', ')
  }
  return redactOneSetCookieChunk(raw)
}

function redactOneSetCookieChunk(raw: string): string {
  const parts = raw.split(';')
  if (parts.length === 0) return '[redacted]'
  const out: string[] = []
  const first = parts[0]!.trim()
  const firstEq = first.indexOf('=')
  if (firstEq >= 0) {
    out.push(`${first.slice(0, firstEq).trim()}=[redacted]`)
  } else {
    out.push('[redacted]')
  }
  for (let i = 1; i < parts.length; i++) {
    const seg = parts[i]!.trim()
    if (!seg) continue
    const eq = seg.indexOf('=')
    if (eq < 0) {
      out.push(SET_COOKIE_FLAG.test(seg) ? seg : '[redacted]')
      continue
    }
    const name = seg.slice(0, eq).trim()
    const val = seg.slice(eq + 1)
    if (SET_COOKIE_ATTR.test(name)) out.push(`${name}=${val}`)
    else out.push(`${name}=[redacted]`)
  }
  return out.join('; ')
}

function redactCliSensitiveFlagsLinear(text: string): string {
  const flags = [
    '--access-token',
    '--access_token',
    '--api-key',
    '--api_key',
    '--client-secret',
    '--client_secret',
    '--password',
    '--secret',
    '--x-api-key',
    '--x_api_key',
  ] as const
  let out = text
  for (const flag of flags) {
    let i = 0
    while (i < out.length) {
      const at = out.indexOf(flag, i)
      if (at < 0) break
      const before = at === 0 ? '' : out[at - 1]!
      if (at > 0 && (/[A-Za-z0-9_-]/.test(before) || before === '-')) {
        i = at + flag.length
        continue
      }
      let valStart = at + flag.length
      if (out[valStart] === '=') {
        valStart++
      } else if (out[valStart] === ' ' || out[valStart] === '\t') {
        valStart = valStart + 1
        while (valStart < out.length && (out[valStart] === ' ' || out[valStart] === '\t')) valStart++
      } else {
        i = at + flag.length
        continue
      }
      let valEnd = valStart
      while (valEnd < out.length && !/[\s"'`,]/.test(out[valEnd]!)) valEnd++
      if (valEnd > valStart) {
        out = out.slice(0, valStart) + '[redacted]' + out.slice(valEnd)
        i = valStart + '[redacted]'.length
      } else {
        i = at + flag.length
      }
    }
  }
  return out
}

function redactJwtLinear(text: string): string {
  if (!text.includes('eyJ') && !text.toLowerCase().includes('eyj')) return text
  let out = ''
  let i = 0
  const len = text.length
  const isSeg = (ch: string) => /[A-Za-z0-9_-]/.test(ch)
  while (i < len) {
    if (text.slice(i, i + 3).toLowerCase() !== 'eyj') {
      out += text[i]
      i++
      continue
    }
    let j = i + 3
    while (j < len && isSeg(text[j]!)) j++
    while (j < len && text[j] === ' ') j++
    if (j >= len || text[j] !== '.') {
      out += text[i]
      i++
      continue
    }
    j++
    while (j < len && text[j] === ' ') j++
    let j2 = j
    while (j2 < len && isSeg(text[j2]!)) j2++
    while (j2 < len && text[j2] === ' ') j2++
    if (j2 >= len || text[j2] !== '.') {
      out += text[i]
      i++
      continue
    }
    j2++
    while (j2 < len && text[j2] === ' ') j2++
    let j3 = j2
    while (j3 < len && isSeg(text[j3]!)) j3++
    if (j3 > i + 10) {
      out += '[redacted-jwt]'
      i = j3
    } else {
      out += text[i]
      i++
    }
  }
  return out
}

function redactHeaderArrayBracketBody(body: string, headerName: string): string {
  const setCookie = headerName.toLowerCase() === 'set-cookie'
  return body.replace(/'((?:\\.|[^'\\])*)'|"((?:\\.|[^"\\])*)"/g, (match, sq: string, dq: string) => {
    const raw =
      sq !== undefined
        ? sq.replace(/\\'/g, "'").replace(/\\\\/g, '\\')
        : dq.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    const redacted = setCookie ? redactSetCookieHeaderValue(raw) : '[redacted]'
    if (sq !== undefined) return `'${redacted}'`
    return `"${redacted}"`
  })
}

/** R5: a run of 12–24 BIP-39 words (12/15/18/21/24) is masked. */
function redactMnemonics(text: string): string {
  return text.replace(WORD_RUN_RE, (run) => {
    const words = mnemonicWords(run)
    const BIP39 = bip39Words()
    // Without the wordlist, fall back to the shape alone: a valid BIP-39 length.
    if (!BIP39) return [12, 15, 18, 21, 24].includes(words.length) ? '[redacted-mnemonic]' : run
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
 *  R6 Authorization / X-PAYMENT / cookie headers, bearer tokens, and JWTs
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
      let encoded = encodeURIComponent(v)
      if (encoded !== v) {
        out = out.replace(new RegExp(escapeRegExp(encoded), 'gi'), '[redacted]')
        const double = encodeURIComponent(encoded)
        if (double !== encoded) {
          out = out.replace(new RegExp(escapeRegExp(double), 'gi'), '[redacted]')
        }
      }
    }
    // R2: viem's transport errors print `URL: <endpoint>` right after
    // "... request failed." or right before "Request body:".
    out = out.replace(/(request failed\.?[ \t]*(?:\r?\n[ \t]*)+)URL:[ \t]*(?!\[redacted\])\S+/gi, '$1URL: [redacted]')
    out = out.replace(/\bURL:[ \t]*(?!\[redacted\])\S+(?=[ \t]*\r?\n[ \t]*Request body:)/g, 'URL: [redacted]')
    // In error text (SDK/RPC/transport messages) every `URL:` field is masked.
    if (opts.errorContext) out = out.replace(/\bURL:[ \t]*(?!\[redacted\])\S+/g, 'URL: [redacted]')
    // R3
    out = out.replace(URL_RE, (u) => redactUrl(u))
    // R6 (set-cookie before cookie so Set-Cookie is not treated as a cookie suffix)
    out = out.replace(
      SET_COOKIE_HEADER_LINE_RE,
      (_m, name: string, sep: string, val: string) => `${name}${sep}${redactSetCookieHeaderValue(val)}`
    )
    out = out.replace(
      JSON_EMBEDDED_COOKIE_LINE_RE,
      (_m, name: string, sep: string) => `${name}${sep}[redacted]`
    )
    out = out.replace(
      /(?:\r\n|\n|\r)\s*(cookie)\s*:\s*[^\r\n]*/gi,
      (m) => m.replace(/(cookie\s*:\s*)[^\r\n]*/i, '$1[redacted]')
    )
    out = out.replace(
      COOKIE_HEADER_LINE_RE,
      (_m, name: string, sep: string) => `${name}${sep}[redacted]`
    )
    out = out.replace(
      JSON_COOKIE_HEADER_ARRAY_RE,
      (match, name: string, body: string) =>
        body.includes('[redacted]') ? match : `"${name}":${redactHeaderArrayBracketBody(body, name)}`
    )
    out = out.replace(
      SINGLE_QUOTED_COOKIE_HEADER_ARRAY_RE,
      (match, name: string, body: string) =>
        body.includes('[redacted]') ? match : `'${name}': ${redactHeaderArrayBracketBody(body, name)}`
    )
    out = out.replace(HEADER_RE, (_m, name: string, sep: string) => `${name}${sep}[redacted]`)
    out = out.replace(USERINFO_AT_RE, (_m, user: string, _pass: string, host: string) => `${user}:[redacted]@${host}`)
    out = out.replace(CLI_SENSITIVE_FLAG_RE, (m, val: string) => m.replace(val, '[redacted]'))
    out = redactCliSensitiveFlagsLinear(out)
    out = out.replace(JSON_HEADER_RE, (_m, name: string, val: string) => {
      if (name.toLowerCase() === 'set-cookie') {
        return `"${name}":"${redactSetCookieHeaderValue(val)}"`
      }
      return `"${name}":"[redacted]"`
    })
    out = out.replace(SINGLE_QUOTED_HEADER_RE, (_m, name: string) => `'${name}': '[redacted]'`)
    out = out.replace(SINGLE_QUOTED_COOKIE_HEADER_RE, (_m, name: string) => `'${name}': '[redacted]'`)
    out = out.replace(
      SINGLE_QUOTED_SET_COOKIE_HEADER_RE,
      (match, name: string, val: string) =>
        val.includes('[redacted]') ? match : `'${name}': '${redactSetCookieHeaderValue(val)}'`
    )
    out = out.replace(BEARER_RE, 'Bearer [redacted]')
    out = redactJwtLinear(out)
    // R4 (whitespace-split 32-byte hex and contiguous hex64)
    out = out.replace(SPLIT_HEX32_PAIR_RE, (match, offset: number, whole: string) =>
      hexHashExempt(offset, whole) ? match : '[redacted-hex64]'
    )
    out = out.replace(SPLIT_HEX64_RE, (match, offset: number, whole: string) =>
      hexHashExempt(offset, whole) ? match : '[redacted-hex64]'
    )
    out = out.replace(HEX64_RE, (match, _p, offset: number, whole: string) =>
      hexHashExempt(offset, whole) ? match : '[redacted-hex64]'
    )
    // R5
    out = redactMnemonics(out)
    out = out.replace(COMMA_MNEMONIC_RE, (run) => {
      const words = run.split(/\s*,\s*/).filter(Boolean).map((w) => w.toLowerCase())
      const BIP39 = bip39Words()
      const okLen = [12, 15, 18, 21, 24].includes(words.length)
      if (!BIP39) return okLen ? '[redacted-mnemonic]' : run
      let streak = 0
      for (const w of words) {
        streak = BIP39.has(w) ? streak + 1 : 0
        if (streak >= 12) return '[redacted-mnemonic]'
      }
      return run
    })
    out = out.replace(JSON_ARRAY_MNEMONIC_RE, (match, inner: string) => {
      const words = [...inner.matchAll(/"((?:\\.|[^"\\])*)"/g)].map((m) =>
        m[1]!.replace(/\\"/g, '"').replace(/\\\\/g, '\\').toLowerCase()
      )
      const BIP39 = bip39Words()
      const okLen = [12, 15, 18, 21, 24].includes(words.length)
      if (!BIP39) return okLen ? '[redacted-mnemonic]' : match
      let streak = 0
      for (const w of words) {
        streak = BIP39.has(w) ? streak + 1 : 0
        if (streak >= 12) return '[redacted-mnemonic]'
      }
      return match
    })
    return out
  } catch {
    return '[output withheld: redaction failed]'
  }
}
// END redact-core

export const LOG_REDACTION_WITHHELD = '[log withheld by redaction guard]'

let logRedactDepth = 0

export type SafeTextOptions = { errorContext?: boolean }

function scrubCore(text: string, opts: SafeTextOptions): string {
  const masked = maskSensitiveTextFields(text)
  return redactSecrets(masked, process.env, opts)
}

/** The one function every user-visible string passes through (B1 + redactSecrets). */
export function safeText(text: string, opts: SafeTextOptions = {}): string {
  const capped = truncateForPreScrub(String(text))
  return runWithScrubBudget(() => scrubCore(capped, opts))
}

function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/** stderr / console shim: fail-closed, non-reentrant, per-block size cap (same as tool guard). */
function safeTextForLogImpl(text: string): string {
  logRedactDepth++
  try {
    if (logRedactDepth > 1) return LOG_REDACTION_WITHHELD
    if (utf8ByteLength(text) > TEXT_OUTPUT_MAX_BYTES) return LOG_REDACTION_WITHHELD
    let out: string
    try {
      out = safeText(text, { errorContext: true })
    } catch (e) {
      if (e instanceof ScrubBudgetExceededError) return LOG_REDACTION_WITHHELD
      return LOG_REDACTION_WITHHELD
    }
    if (utf8ByteLength(out) > TEXT_OUTPUT_MAX_BYTES) return LOG_REDACTION_WITHHELD
    return out
  } catch {
    return LOG_REDACTION_WITHHELD
  } finally {
    logRedactDepth--
  }
}

export function safeTextForLog(text: string): string {
  return REDACTION_LOG_ENTRY.redact(text)
}

/** Shared log-path redaction entry (stderr + console shim); tests spy this for F13. */
export const REDACTION_LOG_ENTRY = {
  redact: (text: string): string => safeTextForLogImpl(text),
}

/**
 * For text that came from an Error (SDK, RPC or transport messages): also masks
 * every `URL:` field, whatever precedes it.
 */
export function safeErrorText(text: string): string {
  return safeText(text, { errorContext: true })
}

/** MCP text content block; `textContent` in format.ts re-exports this. */
export function toolText(text: string): { type: 'text'; text: string } {
  return { type: 'text' as const, text: safeText(text) }
}

/** Trusted operator tool block (no scrub); used when scrub budget is already exceeded. */
export function redactionGuardToolText(): { type: 'text'; text: string } {
  return { type: 'text' as const, text: REDACTION_GUARD_ERROR_TEXT }
}

let stdioProtocolMode = false

/**
 * Called by the MCP server before it connects the stdio transport. From then
 * on stdout carries only protocol frames, so {@link logOut} diverts to stderr
 * (S6).
 */
export function enterStdioProtocolMode(): void {
  stdioProtocolMode = true
}

/** Test hook. */
export function _resetStdioProtocolModeForTests(): void {
  stdioProtocolMode = false
}

export function isStdioProtocolMode(): boolean {
  return stdioProtocolMode
}

/** Redacted line to stderr. */
export function logErr(line: string): void {
  process.stderr.write(REDACTION_LOG_ENTRY.redact(line) + '\n')
}

type ConsoleLevel = 'log' | 'info' | 'debug' | 'warn' | 'error'

const nativeConsole: Record<ConsoleLevel, (...args: unknown[]) => void> = {
  log: console.log.bind(console),
  info: console.info.bind(console),
  debug: console.debug.bind(console),
  warn: console.warn.bind(console),
  error: console.error.bind(console),
}

let stdioConsoleSinkInstalled = false

/**
 * Route SDK / dependency `console.*` through the redacting sink. In MCP stdio
 * protocol mode every level goes to stderr via {@link safeErrorText}; otherwise
 * warn/error stay on stderr and log/info/debug on stdout (still redacted).
 */
export function installStdioConsoleSink(): void {
  if (stdioConsoleSinkInstalled) return
  stdioConsoleSinkInstalled = true
  const forward = (level: ConsoleLevel, args: unknown[]): void => {
    const line = format(...args)
    if (stdioProtocolMode) {
      process.stderr.write(REDACTION_LOG_ENTRY.redact(line) + '\n') // output-sink-allow: stdio console shim; same rules as logErr
      return
    }
    const redacted = safeText(line, { errorContext: level === 'error' || level === 'warn' }) + '\n'
    if (level === 'error' || level === 'warn') {
      process.stderr.write(redacted)
    } else {
      process.stdout.write(redacted)
    }
  }
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => forward(level, args)
  }
}

/** Test hook: restore Node's console and allow reinstall. */
export function _resetStdioConsoleSinkForTests(): void {
  if (!stdioConsoleSinkInstalled) return
  for (const level of ['log', 'info', 'debug', 'warn', 'error'] as const) {
    console[level] = nativeConsole[level]
  }
  stdioConsoleSinkInstalled = false
}

/**
 * Redacted line to stdout, for the CLI and --help/--version only. Never
 * reaches stdout in MCP stdio mode (S6).
 */
export function logOut(line: string): void {
  if (stdioProtocolMode) {
    process.stderr.write(safeText(line) + '\n')
    return
  }
  process.stdout.write(safeText(line) + '\n')
}
