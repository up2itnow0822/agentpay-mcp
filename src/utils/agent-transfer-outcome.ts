/**
 * SDK 7 wrapper: agentTransferToken returns only a tx hash. Parse the receipt
 * for TransactionQueued so queued / over-limit spends are never reported as paid.
 */
import { parseEventLogs, type Hash } from 'viem'
import { AgentAccountV2Abi, agentTransferToken } from 'agentwallet-sdk'
import type { AgentWalletInstance } from './client.js'

export type AgentTransferOutcome =
  | { status: 'executed'; txHash: Hash }
  | { status: 'queued'; txHash: Hash; pendingTxId: bigint }

export async function agentTransferTokenWithOutcome(
  wallet: AgentWalletInstance,
  params: { token: `0x${string}`; to: `0x${string}`; amount: bigint }
): Promise<AgentTransferOutcome> {
  const hash = await agentTransferToken(wallet, params)
  const receipt = await wallet.publicClient.waitForTransactionReceipt({ hash }).catch(() => {
    throw new Error(`send_token: transaction submitted (${hash}) but receipt was not available.`)
  })
  if (receipt.status !== 'success') {
    throw new Error(`send_token: transaction reverted (tx: ${hash}).`)
  }
  const walletAddr = wallet.address.toLowerCase()
  const queuedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionQueued',
    logs: receipt.logs.filter((log) => log.address.toLowerCase() === walletAddr),
  })[0]
  if (queuedLog) {
    return { status: 'queued', txHash: hash, pendingTxId: queuedLog.args.txId }
  }
  return { status: 'executed', txHash: hash }
}