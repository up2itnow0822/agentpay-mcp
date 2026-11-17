/**
 * Examples share the server's {@link safeText} implementation (no vendored copy).
 */
import { format } from 'node:util'
import { safeText } from '../../../src/utils/sink.js'

export { safeText }

export function exampleSafeText(text: string): string {
  return safeText(text)
}

/** console.log replacement: redacted, newline-terminated, to stdout. */
export function exampleLog(...args: unknown[]): void {
  process.stdout.write(exampleSafeText(format(...args)) + '\n')
}

/** console.error replacement: redacted, newline-terminated, to stderr. */
export function exampleError(...args: unknown[]): void {
  process.stderr.write(exampleSafeText(format(...args)) + '\n')
}

/** Raw (no newline) redacted stdout write, for spinners. */
export function exampleWrite(text: string): void {
  process.stdout.write(exampleSafeText(text))
}