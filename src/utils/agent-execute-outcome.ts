/**
 * SDK 7 wrapper #3: verify native agentExecute receipts before reporting Sent.
 */
import { parseEventLogs, type Hash } from 'viem'
import { AgentAccountV2Abi, agentExecute } from 'agentwallet-sdk'
import type { AgentWalletInstance } from './client.js'
import { UnverifiedSpendError, waitForSuccessReceipt } from './agent-transfer-outcome.js'

export type AgentExecuteOutcome =
  | { executed: true; txHash: Hash }
  | { executed: false; txHash: Hash; pendingTxId: bigint }

export async function agentExecuteWithOutcome(
  wallet: AgentWalletInstance,
  params: { to: `0x${string}`; value: bigint; data?: `0x${string}` },
  label = 'send_payment'
): Promise<AgentExecuteOutcome> {
  const account = wallet.walletClient.account
  if (!account) {
    throw new Error(`${label}: wallet client has no signing account.`)
  }
  const hash = await wallet.contract.write.agentExecute(
    [params.to, params.value, params.data ?? '0x'],
    { value: params.value, account, chain: wallet.chain }
  )
  const receipt = await waitForSuccessReceipt(wallet, hash, label)
  const walletAddr = wallet.address.toLowerCase()
  const walletLogs = receipt.logs.filter((log) => log.address.toLowerCase() === walletAddr)
  const queuedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionQueued',
    logs: walletLogs,
  })[0]
  const executedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionExecuted',
    logs: walletLogs,
  })[0]
  if (queuedLog) {
    return { executed: false, txHash: hash, pendingTxId: queuedLog.args.txId }
  }
  if (!executedLog) {
    throw new UnverifiedSpendError(label, hash, 'no TransactionExecuted or TransactionQueued log')
  }
  return { executed: true, txHash: hash }
}

/** Legacy entry: uses SDK agentExecute then re-verifies the receipt strictly. */
export async function agentExecuteVerified(
  wallet: AgentWalletInstance,
  params: Parameters<typeof agentExecute>[1],
  label = 'send_payment'
): Promise<AgentExecuteOutcome> {
  const hash = (await agentExecute(wallet, params)).txHash
  const receipt = await waitForSuccessReceipt(wallet, hash, label)
  const walletAddr = wallet.address.toLowerCase()
  const walletLogs = receipt.logs.filter((log) => log.address.toLowerCase() === walletAddr)
  const queuedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionQueued',
    logs: walletLogs,
  })[0]
  const executedLog = parseEventLogs({
    abi: AgentAccountV2Abi,
    eventName: 'TransactionExecuted',
    logs: walletLogs,
  })[0]
  if (queuedLog) {
    return { executed: false, txHash: hash, pendingTxId: queuedLog.args.txId }
  }
  if (!executedLog) {
    throw new UnverifiedSpendError(label, hash, 'no TransactionExecuted or TransactionQueued log')
  }
  return { executed: true, txHash: hash }
}