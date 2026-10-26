/**
 * `agentpay-mcp spend-intents list|resolve <key>` — operator reconciliation.
 *
 * Reads and appends the journal named by AGENTPAY_STATE_DIR. Run it while the
 * server is stopped (the server replays the journal at startup), after
 * confirming on-chain whether the locked intent settled or moved nothing.
 */
import {
  ensureJournalLoaded,
  listUnresolvedSpendIntents,
  resolveSpendIntent,
  spendJournalPath,
  STATE_DIR_ENV,
} from '../utils/spend-intent.js'

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
  ensureJournalLoaded()
  const [command, key] = args
  if (command === 'list') {
    const locked = listUnresolvedSpendIntents()
    if (locked.length === 0) {
      out('No locked spend intents.')
      return 0
    }
    for (const entry of locked) {
      out(`${new Date(entry.since).toISOString()}  ${entry.key}`)
    }
    return 0
  }
  if (command === 'resolve' && key) {
    if (resolveSpendIntent(key)) {
      out(`Resolved: ${key}`)
      return 0
    }
    err(`No locked spend intent with key: ${key}`)
    return 1
  }
  err('Usage: agentpay-mcp spend-intents list | resolve <key>')
  return 2
}
