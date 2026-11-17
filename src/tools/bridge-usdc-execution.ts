/**
 * bridge_usdc execution path (CCTP V2). Not exposed through MCP while route A is active.
 */
import { createBridge } from 'agentwallet-sdk'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWalletClient = any
import { getConfig, getWallet } from '../utils/client.js'
import { textContent, formatError } from '../utils/format.js'
import { assertConfiguredBridgeSource } from '../utils/wallet-chain.js'
import {
  DefiniteSpendFailure,
  bridgeUsdcIntentIdentity,
  classifyBridgeApproveUsdc,
  requireSettlementHash,
  runClassifiedSpend,
  withSpendIntent,
  wrapDefiniteSdkReads,
  runLockedSpendResume,
} from '../utils/spend-intent.js'
import { withReservedSpend } from './budget.js'
import { parseAmountStrict } from '../utils/amount.js'
import {
  bridgeUsdcResumeAfterBurn,
  bridgeUsdcWithAttestationGuard,
  BridgeAttestationTimeoutError,
  getBridgeAttestationPending,
  clearBridgeAttestationPending,
} from '../utils/bridge-attestation-guard.js'
import { assertExpectedSmartWallet } from '../utils/wallet-binding.js'
import type { BridgeUsdcInput } from './bridge.js'

const SUPPORTED_CHAINS = [
  'base', 'ethereum', 'optimism', 'arbitrum', 'polygon',
  'avalanche', 'linea', 'unichain', 'sonic', 'worldchain',
] as const

type SupportedChain = (typeof SUPPORTED_CHAINS)[number]

const USDC_DECIMALS = 6

export async function handleBridgeUsdcExecution(
  input: BridgeUsdcInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet()
    const config = getConfig()

    if (input.fromChain === input.toChain) {
      throw new Error('fromChain and toChain must be different')
    }

    assertConfiguredBridgeSource(input.fromChain, 'bridge_usdc')

    const rawAmount = parseAmountStrict(input.amount, USDC_DECIMALS)
    const intent = bridgeUsdcIntentIdentity({
      fromChain: input.fromChain,
      toChain: input.toChain,
      rawAmount,
      idempotencyKey: input.idempotencyKey,
    })

    const attestationPending = getBridgeAttestationPending(intent.key)
    if (attestationPending) {
      const resumeBridge = classifyBridgeApproveUsdc(
        wrapDefiniteSdkReads(
          createBridge(wallet.walletClient as AnyWalletClient, input.fromChain as SupportedChain)
        )
      )
      const { value } = await runLockedSpendResume(
        intent.key,
        intent.fingerprint,
        async () => {
          const result = await runClassifiedSpend(wallet.walletClient, () =>
            bridgeUsdcResumeAfterBurn(resumeBridge, attestationPending)
          )
          clearBridgeAttestationPending(intent.key)
          const burnTxHash = requireSettlementHash(result.burnTxHash, 'bridge_usdc burn')
          const mintTxHash = requireSettlementHash(result.mintTxHash, 'bridge_usdc mint')
          return {
            success: true as const,
            burnTxHash,
            mintTxHash,
            fromChain: result.fromChain,
            toChain: result.toChain,
            recipient: result.recipient,
            amount: input.amount,
            rawAmount: rawAmount.toString(),
            elapsedMs: result.elapsedMs,
            attestationResumed: true,
          }
        },
        { durable: Boolean(input.idempotencyKey?.trim()) }
      )
      return { content: [textContent(JSON.stringify(value))] }
    }

    const { value, replayed } = await withSpendIntent(
      intent.key,
      async () => {
        const bridgeRecipient = wallet.walletClient?.account?.address
        if (!bridgeRecipient) {
          throw new DefiniteSpendFailure(
            'Wallet client has no account; cannot verify spend policy for bridge_usdc.'
          )
        }
        return withReservedSpend(
          {
            merchant: bridgeRecipient,
            amount: rawAmount,
            decimals: USDC_DECIMALS,
          },
          async () => {
            const bridge = classifyBridgeApproveUsdc(
              wrapDefiniteSdkReads(
                createBridge(wallet.walletClient as AnyWalletClient, input.fromChain as SupportedChain)
              )
            )
            await assertExpectedSmartWallet(wallet, config, { requireBinding: true })
            const result = await runClassifiedSpend(wallet.walletClient, () =>
              bridgeUsdcWithAttestationGuard(
                bridge,
                rawAmount,
                input.toChain as SupportedChain,
                {},
                input.fromChain as SupportedChain,
                intent.key
              )
            )
            const burnTxHash = requireSettlementHash(result.burnTxHash, 'bridge_usdc burn')
            const mintTxHash = requireSettlementHash(result.mintTxHash, 'bridge_usdc mint')

            return {
              success: true as const,
              burnTxHash,
              mintTxHash,
              fromChain: result.fromChain,
              toChain: result.toChain,
              recipient: result.recipient,
              amount: input.amount,
              rawAmount: rawAmount.toString(),
              elapsedMs: result.elapsedMs,
            }
          }
        )
      },
      {
        durable: Boolean(input.idempotencyKey?.trim()),
        fingerprint: intent.fingerprint,
      }
    )

    return {
      content: [
        textContent(
          JSON.stringify(replayed ? { ...value, idempotentRetry: true } : value)
        ),
      ],
    }
  } catch (error: unknown) {
    if (error instanceof BridgeAttestationTimeoutError) {
      return {
        content: [
          textContent(
            JSON.stringify({
              success: false,
              attestationPending: true,
              burnTxHash: error.burnTxHash,
              message: error.message,
            })
          ),
        ],
        isError: true,
      }
    }
    return {
      content: [textContent(formatError(error, 'bridge_usdc'))],
      isError: true,
    }
  }
}