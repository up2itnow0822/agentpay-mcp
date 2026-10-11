import { vi } from 'vitest'

const HELD = {
  reservationId: 'test-reservation',
  status: 'held' as const,
}

export function reservedResult() {
  return {
    status: 'reserved' as const,
    reservation: { ...HELD },
  }
}

export function policyEngine(reserve: ReturnType<typeof vi.fn>) {
  return {
    check: vi.fn(),
    reserve,
    commit: vi.fn().mockReturnValue(true),
    release: vi.fn().mockReturnValue(true),
    lock: vi.fn().mockReturnValue(true),
    applyOutcome: vi.fn().mockReturnValue(true),
  }
}

export function isEvmTxHashMock(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{64}$/.test(value)
}

export function classifySpendErrorMock(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? '')
  if (/timed out|timeout|ECONNRESET|ETIMEDOUT|network error/i.test(message)) {
    return {
      status: 'hold-unknown' as const,
      retrySafe: false,
      txHashes: [] as string[],
      reason: message,
    }
  }
  return {
    status: 'released' as const,
    retrySafe: true,
    txHashes: [] as string[],
    reason: message || 'definite pre-broadcast failure',
  }
}
