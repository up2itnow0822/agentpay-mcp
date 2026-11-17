/**
 * MCP SDK boundary (SO f9fa2539 S1). Tool results are text-only: strip
 * structuredContent / _meta / non-text blocks; redact each text through safeText.
 */
import { formatError, sanitizeUntrustedInline } from './format.js'
import { REDACTION_GUARD_ERROR_TEXT, TEXT_OUTPUT_MAX_BYTES } from './scrub-bounds.js'
import { logErr, redactionGuardToolText, safeErrorText, safeText, ScrubBudgetExceededError, toolText } from './sink.js'

export { REDACTION_GUARD_ERROR_TEXT, TEXT_OUTPUT_MAX_BYTES }

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

const TOOL_ERROR_WITHHELD = '[tool error withheld: safe formatting failed]'
export const REQUEST_ERROR_WITHHELD = 'request error withheld'

function withholdToolResult(reason: string): ToolResult {
  logErr(`[tool-guard:withhold:${reason}]`)
  return {
    content: [redactionGuardToolText()],
    isError: true,
  }
}

function assertJsonSerializable(value: unknown): void {
  JSON.stringify(value)
}

function readTextBlock(block: unknown): string {
  if (!block || typeof block !== 'object') throw new Error('invalid content block')
  const record = block as Record<string, unknown>
  if (record.type !== 'text') throw new Error('non-text block')
  const raw = record.text
  if (typeof raw === 'string') return raw
  if (raw && typeof raw === 'object' && typeof (raw as { toJSON?: () => unknown }).toJSON === 'function') {
    const materialized = (raw as { toJSON: () => unknown }).toJSON()
    if (typeof materialized === 'string') return materialized
    throw new Error('toJSON did not return string')
  }
  throw new Error('invalid text field')
}

export function redactToolResult(result: unknown): ToolResult {
  try {
    assertJsonSerializable(result)
  } catch {
    return withholdToolResult('cycle')
  }
  if (!result || typeof result !== 'object') return withholdToolResult('shape')
  const raw = result as Record<string, unknown>
  const contentIn = raw.content
  if (!Array.isArray(contentIn)) return withholdToolResult('content')

  const textBlocks: Array<{ type: 'text'; text: string }> = []
  for (const block of contentIn) {
    if (!block || typeof block !== 'object') return withholdToolResult('block')
    const record = block as Record<string, unknown>
    if (record.type !== 'text') continue
    let text: string
    try {
      text = readTextBlock(block)
    } catch {
      return withholdToolResult('text')
    }
    if (new TextEncoder().encode(text).length > TEXT_OUTPUT_MAX_BYTES) {
      return withholdToolResult('size-cap')
    }
    try {
      text = safeText(text)
    } catch (e) {
      if (e instanceof ScrubBudgetExceededError) return withholdToolResult('scrub-budget')
      return withholdToolResult('redact')
    }
    if (new TextEncoder().encode(text).length > TEXT_OUTPUT_MAX_BYTES) {
      return withholdToolResult('size-cap')
    }
    textBlocks.push(toolText(text))
  }

  const out: ToolResult = { content: textBlocks }
  if (raw.isError === true) out.isError = true
  return out
}

export async function guardToolCall(
  name: unknown,
  run: () => Promise<unknown> | unknown
): Promise<ToolResult> {
  try {
    return redactToolResult(await run())
  } catch (error: unknown) {
    try {
      const formatted = formatError(error, `Tool "${sanitizeUntrustedInline(String(name), 64)}"`)
      return {
        content: [toolText(formatted)],
        isError: true,
      }
    } catch (e) {
      if (e instanceof ScrubBudgetExceededError) return withholdToolResult('scrub-budget')
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