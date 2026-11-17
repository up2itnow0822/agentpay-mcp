/**
 * MCP SDK boundary (SO f9fa2539 S1). A request handler that throws or rejects
 * becomes a JSON-RPC error whose message the SDK copies verbatim, bypassing
 * toolText. Every handler in src/index.ts is wrapped here: throws become a
 * fenced, redacted tool error, and every text block of a normal result is
 * passed through the sink once more.
 */
import { formatError, sanitizeUntrustedInline } from './format.js'
import { safeErrorText, safeText, toolText } from './sink.js'

type ToolResult = {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>
  isError?: boolean
  structuredContent?: unknown
  [k: string]: unknown
}

const TOOL_ERROR_WITHHELD = '[tool error withheld: safe formatting failed]'
export const REQUEST_ERROR_WITHHELD = 'request error withheld'

function readOwnValue(obj: Record<string, unknown>, key: string): unknown {
  try {
    return obj[key]
  } catch {
    return '[withheld: property access failed]'
  }
}

/** Deterministic output key; disambiguate when safeText collides with a sibling. */
function redactedObjectKey(originalKey: string, used: Set<string>): string {
  const base = safeText(originalKey)
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

function redactDeep(value: unknown): unknown {
  if (typeof value === 'string') return safeText(value)
  if (Array.isArray(value)) return value.map(redactDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    const usedKeys = new Set<string>()
    const record = value as Record<string, unknown>
    for (const k of Object.keys(record)) {
      const outKey = redactedObjectKey(k, usedKeys)
      out[outKey] = redactDeep(readOwnValue(record, k))
    }
    return out
  }
  return value
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