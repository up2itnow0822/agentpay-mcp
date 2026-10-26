/**
 * `agentpay-mcp spend-intents list | resolve <id> settled|unsettled` —
 * operator reconciliation of locked (ambiguous) spend intents.
 *
 * Uses the journal named by AGENTPAY_STATE_DIR. Only one process may own a
 * state directory at a time, so `resolve` refuses to run while the server
 * (or another command) holds it: stop the server first. `list` falls back to
 * a read-only snapshot when another process owns the directory.
 *
 * Before resolving, check on-chain whether the locked intent moved value:
 * - `settled`: it did. The lock is cleared, and a keyed intent's
 *   idempotencyKey is retired for good: a retry with it is refused instead
 *   of paying again. A keyless intent has no key to retire.
 * - `unsettled`: it did not. The lock is cleared and a retry may pay.
 *
 * Intent keys are caller-influenced. `list` prints each intent's shell-safe
 * `id:` handle and an escaped, informational rendering of its key; `resolve`
 * takes the handle (or a key made only of shell-inert characters).
 */
import {
  displaySpendIntentKey,
  ensureJournalLoaded,
  listUnresolvedSpendIntents,
  resolveSpendIntent,
  snapshotUnresolvedSpendIntents,
  spendIntentKeyFromSelector,
  SpendStateDirBusyError,
  spendJournalPath,
  STATE_DIR_ENV,
  type SpendIntentOutcome,
  type UnresolvedSpendIntentEntry,
} from '../utils/spend-intent.js'

const USAGE =
  'Usage: agentpay-mcp spend-intents list\n' +
  '       agentpay-mcp spend-intents resolve <id> settled     (value moved: clear the lock; a keyed intent\'s idempotencyKey is retired for good)\n' +
  '       agentpay-mcp spend-intents resolve <id> unsettled   (nothing moved: clear the lock; a retry may pay)\n' +
  '<id> is the id: handle that `list` prints. Stop the server before resolving.'

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function runSpendIntentsCli(
  args: string[],
  out: (_line: string) => void = (line) => process.stdout.write(line + '\n'),
  err: (_line: string) => void = (line) => process.stderr.write(line + '\n')
): number {
  const path = spendJournalPath()
  if (!path) {
    err(`${STATE_DIR_ENV} is not set; there is no spend-intent journal to reconcile.`)
    return 2
  }
  const [command, selector, outcome, ...extra] = args

  if (command === 'list' && selector === undefined) {
    let locked: UnresolvedSpendIntentEntry[]
    try {
      ensureJournalLoaded()
      locked = listUnresolvedSpendIntents()
    } catch (error: unknown) {
      if (!(error instanceof SpendStateDirBusyError)) {
        err(message(error))
        return 1
      }
      out(`Read-only snapshot. ${error.message}`)
      try {
        locked = snapshotUnresolvedSpendIntents()
      } catch (snapshotError: unknown) {
        err(message(snapshotError))
        return 1
      }
    }
    if (locked.length === 0) {
      out('No locked spend intents.')
      return 0
    }
    for (const entry of locked) {
      const kind = entry.keyed ? '  [idempotency key]' : ''
      const blocks = entry.blocks.length > 0 ? `  (blocks x402 payments to: ${entry.blocks.join(', ')})` : ''
      out(`${new Date(entry.since).toISOString()}  ${entry.handle}  ${displaySpendIntentKey(entry.key)}${kind}${blocks}`)
    }
    return 0
  }

  if (command === 'resolve' && selector !== undefined && extra.length === 0) {
    if (outcome !== 'settled' && outcome !== 'unsettled') {
      err('Say what reconciliation found: settled (value moved) or unsettled (nothing moved).')
      err(USAGE)
      return 2
    }
    let locked: UnresolvedSpendIntentEntry[]
    try {
      ensureJournalLoaded()
      locked = listUnresolvedSpendIntents()
    } catch (error: unknown) {
      err(message(error))
      return 1
    }
    const target = spendIntentKeyFromSelector(selector, locked.map((entry) => entry.key))
    if ('error' in target) {
      err(
        target.error === 'not-plain'
          ? 'Select the intent by the id: handle that `list` prints; this key cannot be passed safely through a shell.'
          : `No locked spend intent with handle ${selector.replace(/[^A-Za-z0-9_:-]/g, '?')}.`
      )
      return target.error === 'not-plain' ? 2 : 1
    }
    let resolved
    try {
      resolved = resolveSpendIntent(target.key, outcome as SpendIntentOutcome)
    } catch (error: unknown) {
      err(message(error))
      return 1
    }
    if (!resolved) {
      err(`No locked spend intent with key ${displaySpendIntentKey(target.key)}.`)
      return 1
    }
    const shown = `${displaySpendIntentKey(resolved.key)} (${locked.find((e) => e.key === resolved.key)?.handle})`
    if (resolved.outcome === 'unsettled') {
      out(`Resolved as unsettled: ${shown}. The lock is cleared; a retry may pay.`)
    } else if (resolved.keyRetired) {
      out(`Resolved as settled: ${shown}. Its idempotency key is retired: a retry with it is refused, never paid again.`)
    } else {
      out(`Resolved as settled: ${shown}. The lock is cleared. This intent had no idempotency key to retire; an identical new request is a new payment.`)
    }
    return 0
  }

  err(USAGE)
  return 2
}
