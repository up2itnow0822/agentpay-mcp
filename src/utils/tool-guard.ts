/**
 * MCP SDK boundary (SO f9fa2539 S1). A request handler that throws or rejects
 * becomes a JSON-RPC error whose message the SDK copies verbatim, bypassing
 * toolText. Every handler in src/index.ts is wrapped here: throws become a
 * fenced, redacted tool error, and every text block of a normal result is
 * passed through the sink once more.
 */
import { formatError, sanitizeUntrustedInline } from './format.js'
import { logErr, safeErrorText, safeText, toolText } from './sink.js'

type ToolResult = {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
  isError?: boolean
  structuredContent?: unknown
  [k: string]: unknown
}

const TOOL_ERROR_WITHHELD = '[tool error withheld: safe formatting failed]'
export const REQUEST_ERROR_WITHHELD = 'request error withheld'
export const STRUCTURED_RESULT_WITHHELD = 'structured result withheld'

/** Redacted JSON text passed to JSON.parse; never parse truncated input. */
const STRUCTURED_JSON_MAX_BYTES = 4 * 1024 * 1024

/** Ops JSON sensitive names + HTTP header names (case-insensitive), aligned with sink HTTP list. */
export const SENSITIVE_JSON_FIELD_NAMES = [
  'api_key',
  'client_secret',
  'password',
  'token',
  'authorization',
  'cookie',
  'private_key',
  'mnemonic',
  'seed',
  'proxy-authorization',
  'x-auth-token',
  'x-api-key',
  'api-key',
  'x-payment',
  'x-payment-response',
  'set-cookie',
] as const

const SENSITIVE_JSON_KEY_LOWER = new Set(SENSITIVE_JSON_FIELD_NAMES.map((n) => n.toLowerCase()))

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const SENSITIVE_JSON_KEY_ALT = SENSITIVE_JSON_FIELD_NAMES.map(escapeRegExp).join('|')

function isSensitiveJsonKey(name: string): boolean {
  return SENSITIVE_JSON_KEY_LOWER.has(name.toLowerCase())
}

const JSON_SENSITIVE_STRING_FIELD = new RegExp(
  `"(${SENSITIVE_JSON_KEY_ALT})"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`,
  'gi'
)

function withhold(reason: string): typeof STRUCTURED_RESULT_WITHHELD {
  logErr(`[tool-guard:withhold:${reason}]`)
  return STRUCTURED_RESULT_WITHHELD
}

function redactedExportKey(originalKey: string, used: Set<string>): string {
  const base = isSensitiveJsonKey(originalKey) ? '[redacted]' : safeText(originalKey)
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base} #${n}`)) n += 1
  const disambiguated = `${base} #${n}`
  used.add(disambiguated)
  return disambiguated
}

function materializeJsonValue(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const withJson = value as { toJSON?: () => unknown }
  if (typeof withJson.toJSON === 'function') {
    return withJson.toJSON()
  }
  return value
}

function prepareKeysForStringify(value: unknown, stack: WeakSet<object>): unknown {
  if (value === null || typeof value === 'function' || typeof value === 'symbol') return value
  if (typeof value === 'bigint') return value
  if (typeof value !== 'object') return value
  if (stack.has(value)) return value
  value = materializeJsonValue(value)
  if (value === null || typeof value !== 'object') return value
  if (stack.has(value)) return value
  stack.add(value)
  if (Array.isArray(value)) {
    const out: unknown[] = []
    for (let i = 0; i < value.length; i++) {
      out.push(prepareKeysForStringify(value[i], stack))
    }
    return out
  }
  const used = new Set<string>()
  const out: Record<string, unknown> = Object.create(null)
  const record = value as Record<string, unknown>
  for (const k of Object.keys(record)) {
    const exportKey = redactedExportKey(k, used)
    let fieldValue: unknown
    try {
      fieldValue = record[k]
    } catch {
      throw new Error('property access failed')
    }
    if (isSensitiveJsonKey(k)) {
      out[exportKey] = '[redacted]'
      continue
    }
    out[exportKey] = prepareKeysForStringify(fieldValue, stack)
  }
  return out
}

function jsonReplacer(_key: string, val: unknown): unknown {
  if (typeof val === 'bigint') return val.toString()
  return val
}

function maskSensitiveJsonStringFields(json: string): string {
  return json.replace(JSON_SENSITIVE_STRING_FIELD, () => '"[redacted]":"[redacted]"')
}

function readJsonStringLiteral(json: string, start: number): { end: number; decoded: string } | null {
  if (json[start] !== '"') return null
  let i = start + 1
  let decoded = ''
  while (i < json.length) {
    const c = json[i]
    if (c === '\\') {
      const next = json[i + 1]
      if (next === undefined) return null
      if (next === 'n') decoded += '\n'
      else if (next === 'r') decoded += '\r'
      else if (next === 't') decoded += '\t'
      else if (next === 'b') decoded += '\b'
      else if (next === 'f') decoded += '\f'
      else if (next === '"') decoded += '"'
      else if (next === '\\') decoded += '\\'
      else if (next === 'u') {
        const hex = json.slice(i + 2, i + 6)
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) return null
        decoded += String.fromCharCode(Number.parseInt(hex, 16))
        i += 6
        continue
      } else decoded += next
      i += 2
      continue
    }
    if (c === '"') return { end: i + 1, decoded }
    decoded += c
    i++
  }
  return null
}

/** Run the text sink on JSON string values only, preserving structural punctuation. */
function safeTextJsonStringValues(json: string): string {
  let out = ''
  let pos = 0
  while (pos < json.length) {
    if (json[pos] !== '"') {
      out += json[pos]
      pos++
      continue
    }
    const read = readJsonStringLiteral(json, pos)
    if (!read) throw new SyntaxError('invalid JSON string')
    out += JSON.stringify(safeText(read.decoded))
    pos = read.end
  }
  return out
}

function reassertOwnProtoKeys(value: unknown): void {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    for (const item of value) reassertOwnProtoKeys(item)
    return
  }
  const record = value as Record<string, unknown>
  if (Object.prototype.hasOwnProperty.call(record, '__proto__')) {
    const protoVal = record.__proto__
    delete record.__proto__
    Object.defineProperty(record, '__proto__', {
      value: protoVal,
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  for (const k of Object.keys(record)) {
    if (k === '__proto__') continue
    reassertOwnProtoKeys(record[k])
  }
}

function encodeUtf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

function redactDeep(value: unknown): unknown {
  try {
    const prepared = prepareKeysForStringify(value, new WeakSet())
    let json: string
    try {
      json = JSON.stringify(prepared, jsonReplacer)
    } catch {
      return withhold('stringify')
    }
    json = maskSensitiveJsonStringFields(json)
    try {
      json = safeTextJsonStringValues(json)
    } catch {
      return withhold('redact-json')
    }
    if (encodeUtf8ByteLength(json) > STRUCTURED_JSON_MAX_BYTES) {
      return withhold('size-cap')
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(json)
      reassertOwnProtoKeys(parsed)
    } catch {
      return withhold('parse')
    }
    return parsed
  } catch {
    return withhold('stringify')
  }
}

export function redactToolResult<T>(result: T): T {
  return redactDeep(result) as T
}

export async function guardToolCall<T>(name: unknown, run: () => Promise<T> | T): Promise<T | ToolResult> {
  try {
    return redactToolResult(await run())
  } catch (error: unknown) {
    try {
      return {
        content: [toolText(formatError(error, `Tool "${sanitizeUntrustedInline(String(name), 64)}"`))],
        isError: true,
      }
    } catch {
      return {
        content: [toolText(TOOL_ERROR_WITHHELD)],
        isError: true,
      }
    }
  }
}

/** For non-tool handlers (list): a throw must not carry raw text out either. */
export async function guardRequest<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    let rawMessage: string
    try {
      rawMessage = error instanceof Error ? error.message : String(error)
    } catch {
      throw new Error(REQUEST_ERROR_WITHHELD)
    }
    throw new Error(safeErrorText(rawMessage))
  }
}