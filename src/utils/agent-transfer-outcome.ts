/**
 * SDK 7 wrapper #13: classify agentTransferToken receipts (queued vs sent vs unverified).
 */
import {
  encodeEventTopics,
  getAddress,
  parseAbiItem,
  parseEventLogs,
  type Hash,
  type TransactionReceipt,
} from 'viem'
import { AgentAccountV2Abi, agentTransferToken } from 'agentwallet-sdk'
import type { AgentWalletInstance } from './client.js'

const [TRANSFER_TOPIC] = encodeEventTopics({
  abi: [parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')],
  eventName: 'Transfer',
})
const DEFAULT_RECEIPT_TIMEOUT_MS = 120_000

export class UnverifiedSpendError extends Error {
  readonly unverified = true
  readonly txHash: Hash
  constructor(label: string, txHash: Hash, detail: string) {
    super(
      `${label}: sent, unverified (${detail}). txHash=${txHash}. ` +
        'Intent locked; retry with the same idempotency key replays without re-signing.'
    )
    this.name = 'UnverifiedSpendError'
    this.txHash = txHash
  }
}

export function receiptTimeoutMs(): number {
  const raw = process.env['AGENTPAY_RECEIPT_TIMEOUT_MS']?.trim()
  if (!raw) return DEFAULT_RECEIPT_TIMEOUT_MS
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 1_000) {
    return DEFAULT_RECEIPT_TIMEOUT_MS
  }
  return Math.min(n, 600_000)
}

export async function waitForSuccessReceipt(
  wallet: AgentWalletInstance,
  hash: Hash,
  label: string
): Promise<TransactionReceipt> {
  const timeout = receiptTimeoutMs()
  let receipt: TransactionReceipt
  try {
    receipt = await wallet.publicClient.waitForTransactionReceipt({ hash, timeout })
  } catch {
    throw new UnverifiedSpendError(label, hash, `receipt not confirmed within ${timeout}ms`)
  }
  if (receipt.status !== 'success') {
    throw new UnverifiedSpendError(label, hash, `receipt status is ${receipt.status}`)
  }
  return receipt
}

export type AgentTransferOutcome =
  | { status: 'executed'; txHash: Hash }
  | { status: 'queued'; txHash: Hash; pendingTxId: bigint }

function findErc20Transfer(
  receipt: TransactionReceipt,
  token: `0x${string}`,
  walletAddress: `0x${string}`,
  to: `0x${string}`,
  amount: bigint
): boolean {
  const from = walletAddress.toLowerCase()
  const dest = getAddress(to).toLowerCase()
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== token.toLowerCase()) continue
    if (log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC) continue
    const tFrom = log.topics[1] ? ('0x' + log.topics[1].slice(26)).toLowerCase() : ''
    const tTo = log.topics[2] ? ('0x' + log.topics[2].slice(26)).toLowerCase() : ''
    if (tFrom !== from || tTo !== dest) continue
    const value = BigInt(log.data)
    if (value === amount) return true
  }
  return false
}

export async function agentTransferTokenWithOutcome(
  wallet: AgentWalletInstance,
  params: { token: `0x${string}`; to: `0x${string}`; amount: bigint },
  label = 'send_token'
): Promise<AgentTransferOutcome> {
  const hash = await agentTransferToken(wallet, params)
  const receipt = await waitForSuccessReceipt(wallet, hash, label)
  const walletAddr = wallet.address.toLowerCase()
  const walletLogs = receipt.logs.filter((log) => log.address.toLowerCase() === walletAddr)
  const queuedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionQueued',
    logs: walletLogs,
  })[0]
  if (queuedLog) {
    return { status: 'queued', txHash: hash, pendingTxId: queuedLog.args.txId }
  }
  const executedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionExecuted',
    logs: walletLogs,
  })[0]
  if (!executedLog) {
    throw new UnverifiedSpendError(label, hash, 'no TransactionExecuted or TransactionQueued log')
  }
  if (!findErc20Transfer(receipt, params.token, wallet.address, params.to, params.amount)) {
    throw new UnverifiedSpendError(
      label,
      hash,
      'TransactionExecuted without a matching ERC-20 Transfer from the agent wallet'
    )
  }
  return { status: 'executed', txHash: hash }
}