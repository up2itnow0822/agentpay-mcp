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
import { maskSensitiveTextFields } from './sink-sensitive-text.js'

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
  'set-cookie',
] as const
const HTTP_HEADER_NAME_ALT = HTTP_REDACT_HEADER_NAMES.join('|')
const HTTP_HEADER_COOKIE_ALT = 'cookie|set-cookie'
const HTTP_HEADER_NON_COOKIE_ALT = HTTP_REDACT_HEADER_NAMES.filter(
  (n) => n !== 'cookie' && n !== 'set-cookie'
).join('|')
const COOKIE_HEADER_LINE_RE = new RegExp(
  `\\b(${HTTP_HEADER_COOKIE_ALT})(\\s*[:=]\\s*)([^\\r\\n;]*)`,
  'gi'
)
const HEADER_RE = new RegExp(
  `\\b(${HTTP_HEADER_NON_COOKIE_ALT})(\\s*[:=]\\s*)(['"]?)([^\\r\\n;'"]*)\\3`,
  'gi'
)
const JSON_HEADER_RE = new RegExp(
  `"(${HTTP_HEADER_NAME_ALT})"\\s*:\\s*"([^"]*)"`,
  'gi'
)
const SINGLE_QUOTED_HEADER_RE = new RegExp(
  `'(${HTTP_HEADER_NON_COOKIE_ALT})'\\s*:\\s*'[^']*'`,
  'gi'
)
const SINGLE_QUOTED_COOKIE_HEADER_RE = new RegExp(
  `'(${HTTP_HEADER_COOKIE_ALT})'\\s*:\\s*[^\\r\\n;]*`,
  'gi'
)
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/g
/** R6: JWT-shaped tokens (three base64url segments; header segment starts with eyJ). */
const JWT_RE = /eyJ[A-Za-z0-9_-]*(?:\s*\.\s*)[A-Za-z0-9_-]+(?:\s*\.\s*)[A-Za-z0-9_-]+/g
// Any whitespace between words (incl. NBSP), so a mnemonic split across lines still matches.
const WORD_RUN_RE =
  /(?:\d+[.)]\s*)?[a-zA-Z]{3,8}(?:(?:[ \t\r\n\u00a0]+(?:\d+[.)]\s*)?)[a-zA-Z]{3,8}){11,23}\b/g

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
    // R6
    out = out.replace(
      COOKIE_HEADER_LINE_RE,
      (_m, name: string, sep: string) => `${name}${sep}[redacted]`
    )
    out = out.replace(HEADER_RE, (_m, name: string, sep: string, q: string) => `${name}${sep}${q}[redacted]${q}`)
    out = out.replace(JSON_HEADER_RE, (_m, name: string) => `"${name}":"[redacted]"`)
    out = out.replace(SINGLE_QUOTED_HEADER_RE, (_m, name: string) => `'${name}': '[redacted]'`)
    out = out.replace(SINGLE_QUOTED_COOKIE_HEADER_RE, (_m, name: string) => `'${name}': '[redacted]'`)
    out = out.replace(BEARER_RE, 'Bearer [redacted]')
    out = out.replace(JWT_RE, '[redacted-jwt]')
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
    return out
  } catch {
    return '[output withheld: redaction failed]'
  }
}
// END redact-core

/** The one function every output passes through. */
export function safeText(text: string): string {
  // B1 field mask runs first so header-like key=value lines keep stable keys before pattern redaction.
  return redactSecrets(maskSensitiveTextFields(text))
}

/**
 * For text that came from an Error (SDK, RPC or transport messages): also masks
 * every `URL:` field, whatever precedes it.
 */
export function safeErrorText(text: string): string {
  return redactSecrets(text, process.env, { errorContext: true })
}

/** MCP text content block; `textContent` in format.ts re-exports this. */
export function toolText(text: string): { type: 'text'; text: string } {
  return { type: 'text' as const, text: safeText(text) }
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
  process.stderr.write(safeErrorText(line) + '\n')
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
      process.stderr.write(safeErrorText(line) + '\n') // output-sink-allow: stdio console shim; same rules as logErr
      return
    }
    const redacted = safeText(line) + '\n'
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
