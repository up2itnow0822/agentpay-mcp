/**
 * MCP SDK boundary (SO f9fa2539 S1). A request handler that throws or rejects
 * becomes a JSON-RPC error whose message the SDK copies verbatim, bypassing
 * toolText. Every handler in src/index.ts is wrapped here: throws become a
 * fenced, redacted tool error, and every text block of a normal result is
 * passed through the sink once more.
 */
import { formatError, sanitizeUntrustedInline } from './format.js'
import { safeErrorText, safeText, toolText } from './sink.js'

type ToolResult = { content: Array<{ type: string; text?: string; [k: string]: unknown }>; isError?: boolean; [k: string]: unknown }

export function redactToolResult<T>(result: T): T {
  const r = result as unknown as ToolResult
  if (!r || !Array.isArray(r.content)) return result
  return {
    ...r,
    content: r.content.map((block) =>
      block && block.type === 'text' && typeof block.text === 'string' ? { ...block, text: safeText(block.text) } : block
    ),
  } as unknown as T
}

export async function guardToolCall<T>(name: unknown, run: () => Promise<T> | T): Promise<T | ToolResult> {
  try {
    return redactToolResult(await run())
  } catch (error: unknown) {
    return {
      content: [toolText(formatError(error, `Tool "${sanitizeUntrustedInline(String(name), 64)}"`))],
      isError: true,
    }
  }
}

/** For non-tool handlers (list): a throw must not carry raw text out either. */
export async function guardRequest<T>(run: () => Promise<T> | T): Promise<T> {
  try {
    return await run()
  } catch (error: unknown) {
    throw new Error(safeErrorText(error instanceof Error ? error.message : String(error)))
  }
}
