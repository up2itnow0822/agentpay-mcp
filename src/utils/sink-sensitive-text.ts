/**
 * B1 sensitive field masking for tool text (outside vendored redact-core).
 * Normalizes key names and masks string values in JSON-shaped and key=value text.
 */
export function normalizeSensitiveKeyName(name: string): string {
  return name.toLowerCase().replace(/[-_.\s]/g, '')
}

const SENSITIVE_KEY_EXACT = new Set([
  'apikey',
  'xapikey',
  'accesstoken',
  'refreshtoken',
  'authtoken',
  'sessiontoken',
  'bearertoken',
  'idtoken',
  'clientsecret',
  'secret',
  'secretkey',
  'privatekey',
  'password',
  'passphrase',
  'mnemonic',
  'seed',
  'seedphrase',
  'cookie',
  'cookie2',
  'setcookie',
  'authorization',
  'proxyauthorization',
  'xauthtoken',
  'xpayment',
  'credentials',
  'credential',
  'bearer',
  'dbpassword',
])

const SENSITIVE_KEY_SUFFIXES = ['password', 'passphrase', 'secret', 'privatekey', 'apikey'] as const

const SENSITIVE_KV_TO_EOL = new Set(['seed', 'mnemonic'])

const KEY_FIRST = /[A-Za-z]/
const KEY_REST = /[A-Za-z0-9_.\-%]/

/** Only the HTTP header wire form is masked by redactSecrets Set-Cookie rules. */
function isR6SetCookieHeaderKey(name: string): boolean {
  return name.trim().toLowerCase() === 'set-cookie'
}

export function isSensitiveTextKeyName(name: string): boolean {
  const normalized = normalizeSensitiveKeyName(decodeWireKeyName(name))
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
}

function decodeWireKeyName(name: string): string {
  if (!name.includes('%')) return name
  try {
    return decodeURIComponent(name.replace(/\+/g, ' '))
  } catch {
    return name
  }
}

/** Representative wire forms for tests (one per logical sensitive name). */
export const SENSITIVE_TEXT_KEY_WIRE_FORMS = [
  'api_key',
  'apiKey',
  'x-api-key',
  'client_secret',
  'clientSecret',
  'access_token',
  'refresh_token',
  'auth_token',
  'session_token',
  'bearer_token',
  'id_token',
  'secret',
  'secret_key',
  'private_key',
  'privateKey',
  'password',
  'passphrase',
  'mnemonic',
  'seed',
  'seed_phrase',
  'cookie',
  'set-cookie',
  'authorization',
  'proxy-authorization',
  'x-auth-token',
  'x-payment',
  'credentials',
  'credential',
  'bearer',
  'db_password',
] as const

/** Suffix-rule wire forms exercised only in guard e2e tests. */
export const B1_GUARD_E2E_SUFFIX_WIRE_FORMS = ['SMTP_PASSWORD', 'webhookSecret'] as const

/** Full B1 guardToolCall matrix: exact set wire forms plus suffix examples. */
export const B1_GUARD_E2E_WIRE_FORMS = [
  ...SENSITIVE_TEXT_KEY_WIRE_FORMS,
  ...B1_GUARD_E2E_SUFFIX_WIRE_FORMS,
] as const

export const B1_TOKEN_FIELD_SURVIVORS = ['tokenAddress', 'tokenId', 'tokenAmount', 'tokenSymbol'] as const

const JSON_STRING_FIELD_RE = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g

const KV_EOL_FIELD_RE =
  /\b([A-Za-z][A-Za-z0-9_.\-%]*)\s*[:=]\s*([^\r\n]+)/g

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function readKeyAt(text: string, start: number): { key: string; end: number } | null {
  if (!KEY_FIRST.test(text[start] ?? '')) return null
  let i = start + 1
  while (i < text.length && KEY_REST.test(text[i]!)) i++
  if (i > start + 1 || KEY_FIRST.test(text[start]!)) {
    return { key: text.slice(start, i), end: i }
  }
  return null
}

function skipWs(text: string, i: number): number {
  while (i < text.length && /[ \t]/.test(text[i]!)) i++
  return i
}

function maskJsonStringFields(text: string): string {
  if (!text.includes('"') || !text.includes('":')) return text
  // Hostile escaped-quote runs (corpus timing): no JSON keys, skip regex pass.
  if (text.length > 100_000 && !/"[A-Za-z]/.test(text)) return text
  return text.replace(JSON_STRING_FIELD_RE, (match, rawKey: string, rawVal: string) => {
    const key = rawKey.replace(/\\"/g, '"').replace(/\\\\/g, '\\').replace(/\\u([0-9a-fA-F]{4})/g, (_, h) =>
      String.fromCharCode(parseInt(h, 16))
    )
    if (rawVal === '[redacted]' || rawVal.startsWith('[redacted-')) return match
    if (isR6SetCookieHeaderKey(key)) return match
    if (!isSensitiveTextKeyName(key)) return match
    const escapedKey = JSON.stringify(key).slice(1, -1)
    return `"${escapedKey}":"[redacted]"`
  })
}

function redactSetCookieValueInline(raw: string): string {
  const parts = raw.split(';')
  if (parts.length === 0) return '[redacted]'
  const out: string[] = []
  const first = parts[0]!.trim()
  const firstEq = first.indexOf('=')
  if (firstEq >= 0) out.push(`${first.slice(0, firstEq).trim()}=[redacted]`)
  else out.push('[redacted]')
  const SET_COOKIE_ATTR = /^(?:Path|Domain|Expires|Max-Age|SameSite)$/i
  const SET_COOKIE_FLAG = /^(?:HttpOnly|Secure)$/i
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

function maskSetCookieKeyedValue(rawKey: string, rawVal: string, sepThrough: string): string {
  if (normalizeSensitiveKeyName(rawKey) === 'setcookie') {
    return `${rawKey}${sepThrough}${redactSetCookieValueInline(rawVal)}`
  }
  return `${rawKey}${sepThrough}[redacted]`
}

function maskTrailingChainedTokens(line: string): string {
  return line
    .replace(/(password\s*:\s*\[redacted\])\s+([A-Za-z0-9._-]+)/gi, '$1 [redacted]')
    .replace(/(password\s*=\s*\[redacted\])([;,])([A-Za-z0-9._-]+)/gi, '$1$2[redacted]')
}

function takeUnquotedValue(text: string, start: number): { value: string; end: number } {
  let i = start
  while (i < text.length) {
    const ch = text[i]!
    if (ch === ';' || ch === ',' || ch === ' ' || ch === '\t' || ch === '\r' || ch === '\n') break
    i++
  }
  return { value: text.slice(start, i), end: i }
}

function takeQuotedValue(text: string, start: number, quote: '"' | "'"): { value: string; end: number } {
  let i = start + 1
  while (i < text.length) {
    const ch = text[i]!
    if (ch === '\\' && i + 1 < text.length) {
      i += 2
      continue
    }
    if (ch === quote) return { value: text.slice(start, i + 1), end: i + 1 }
    i++
  }
  return { value: text.slice(start), end: text.length }
}

function maskKvFieldsLinear(text: string): string {
  const needKv = text.includes(':') || text.includes('=')
  if (!needKv) return text
  let out = ''
  let i = 0
  const len = text.length
  while (i < len) {
    const boundary = i === 0 || !isWordChar(text[i - 1]!)
    if (!boundary) {
      out += text[i]
      i++
      continue
    }
    const keyInfo = readKeyAt(text, i)
    if (!keyInfo) {
      out += text[i]
      i++
      continue
    }
    let j = skipWs(text, keyInfo.end)
    if (j >= len || (text[j] !== ':' && text[j] !== '=')) {
      out += text[i]
      i++
      continue
    }
    j++
    j = skipWs(text, j)
    if (j >= len) {
      out += text.slice(i)
      break
    }
    const rawKey = keyInfo.key
    const sepThrough = text.slice(keyInfo.end, j)
    const norm = normalizeSensitiveKeyName(decodeWireKeyName(rawKey))
    let valEnd = j
    let masked = false
    if (text[j] === '"' || text[j] === "'") {
      const quoted = takeQuotedValue(text, j, text[j] as '"' | "'")
      valEnd = quoted.end
      if (!isR6SetCookieHeaderKey(rawKey) && isSensitiveTextKeyName(rawKey)) {
        out += `${rawKey}${sepThrough}[redacted]`
        masked = true
      }
    } else if (SENSITIVE_KV_TO_EOL.has(norm)) {
      const beforeKey = text.slice(Math.max(0, i - 8), i)
      if (norm === 'seed' && /random\s$/i.test(beforeKey)) {
        out += text[i]
        i++
        continue
      }
      const lineEnd = text.indexOf('\n', j)
      valEnd = lineEnd < 0 ? len : lineEnd
      if (!isR6SetCookieHeaderKey(rawKey)) {
        out += `${rawKey}${sepThrough}[redacted]`
        masked = true
      }
    } else if (normalizeSensitiveKeyName(rawKey) === 'setcookie') {
      const lineEnd = text.indexOf('\n', j)
      valEnd = lineEnd < 0 ? len : lineEnd
      out += maskSetCookieKeyedValue(rawKey, text.slice(j, valEnd).trimEnd(), sepThrough)
      masked = true
    } else if (!isR6SetCookieHeaderKey(rawKey) && isSensitiveTextKeyName(rawKey)) {
      const unquoted = takeUnquotedValue(text, j)
      valEnd = unquoted.end
      out += `${rawKey}${sepThrough}[redacted]`
      masked = true
    }
    if (masked) {
      i = valEnd
      continue
    }
    out += text.slice(i, valEnd)
    i = valEnd
  }
  return out
}

function maskSensitiveLines(text: string): string {
  if (!text.includes('\n')) return maskTrailingChainedTokens(text)
  return text
    .split('\n')
    .map((line) => maskTrailingChainedTokens(line))
    .join('\n')
}

export function maskSensitiveTextFields(text: string): string {
  if (!text) return text
  let out = maskJsonStringFields(text)
  out = out.replace(KV_EOL_FIELD_RE, (match, rawKey: string) => {
    if (isR6SetCookieHeaderKey(rawKey)) return match
    const norm = normalizeSensitiveKeyName(decodeWireKeyName(rawKey))
    if (norm === 'seed' && /random\s$/i.test(match.slice(0, match.indexOf(rawKey)))) return match
    if (!SENSITIVE_KV_TO_EOL.has(norm)) return match
    const sepEnd = match.search(/[:=]\s*/)
    if (sepEnd < 0) return match
    const sepThrough = match.slice(sepEnd).match(/^[:=]\s*/)?.[0]?.length ?? 1
    return `${rawKey}${match.slice(rawKey.length, sepEnd + sepThrough)}[redacted]`
  })
  out = maskKvFieldsLinear(out)
  out = maskSensitiveLines(out)
  return out
}