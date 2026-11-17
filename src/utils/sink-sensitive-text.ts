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

const SENSITIVE_KEY_SUFFIXES = ['password', 'passphrase', 'secret', 'privatekey'] as const

export function isSensitiveTextKeyName(name: string): boolean {
  const normalized = normalizeSensitiveKeyName(name)
  if (SENSITIVE_KEY_EXACT.has(normalized)) return true
  return SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
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

const JSON_STRING_FIELD_RE = /"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"/g

const KV_FIELD_RE = /\b([A-Za-z][A-Za-z0-9_.\-]*)\s*[:=]\s*("(?:\\.|[^"\\])*"|[^\s,;&\]}]+)/g

export function maskSensitiveTextFields(text: string): string {
  let out = text.replace(JSON_STRING_FIELD_RE, (match, rawKey: string, _rawVal: string) => {
    const key = rawKey.replace(/\\"/g, '"').replace(/\\\\/g, '\\')
    if (!isSensitiveTextKeyName(key)) return match
    const escapedKey = JSON.stringify(key).slice(1, -1)
    return `"${escapedKey}":"[redacted]"`
  })
  out = out.replace(KV_FIELD_RE, (match, rawKey: string, rawVal: string) => {
    if (!isSensitiveTextKeyName(rawKey)) return match
    const middle = match.slice(rawKey.length, match.length - rawVal.length)
    return `${rawKey}${middle}[redacted]`
  })
  return out
}