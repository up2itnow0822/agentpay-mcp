/**
 * bridge.ts — bridge_usdc tool.
 *
 * Wraps agentwallet-sdk v6 BridgeModule (CCTP V2 cross-chain USDC bridge).
 */
import { z } from 'zod'
import { createBridge } from 'agentwallet-sdk'
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyWalletClient = any
import { getWallet } from '../utils/client.js'
import { textContent, formatError } from '../utils/format.js'
import { assertConfiguredBridgeSource } from '../utils/wallet-chain.js'
import {
  DefiniteSpendFailure,
  bridgeUsdcIntentIdentity,
  withSpendIntent,
} from '../utils/spend-intent.js'
import { enforceSpendPolicy } from './budget.js'
import { parseAmountStrict } from '../utils/amount.js'

// Supported CCTP V2 chain names
const SUPPORTED_CHAINS = [
  'base', 'ethereum', 'optimism', 'arbitrum', 'polygon',
  'avalanche', 'linea', 'unichain', 'sonic', 'worldchain',
] as const

type SupportedChain = (typeof SUPPORTED_CHAINS)[number]

// ─── Schema ────────────────────────────────────────────────────────────────

export const BridgeUsdcSchema = z.object({
  fromChain: z
    .enum(SUPPORTED_CHAINS)
    .describe('Source chain name (e.g. "base", "ethereum", "arbitrum")'),
  toChain: z
    .enum(SUPPORTED_CHAINS)
    .describe('Destination chain name (e.g. "polygon", "optimism")'),
  amount: z
    .string()
    .describe('Amount of USDC to bridge in human-readable units, e.g. "100" for 100 USDC'),
  idempotencyKey: z
    .string()
    .trim()
    .min(1)
    .max(128)
    .optional()
    .describe(
      'Caller-supplied idempotency key. Distinct keys allow two equal bridges; ' +
        'the same key replays the original bridge; reusing it with a different ' +
        'payload is refused. MCP retries without a key still collapse on the ' +
        'settled payload for five minutes.'
    ),
})

export type BridgeUsdcInput = z.infer<typeof BridgeUsdcSchema>

// ─── Tool definition ───────────────────────────────────────────────────────

export const bridgeUsdcTool = {
  name: 'bridge_usdc',
  description:
    'Bridge USDC across chains using Circle\'s CCTP V2 protocol. ' +
    'Supported chains: base, ethereum, optimism, arbitrum, polygon, avalanche, linea, unichain, sonic, worldchain. ' +
    'The bridge approves USDC, burns on source, polls Circle IRIS for attestation, then mints on destination. ' +
    'Identical retries replay the original burn/mint; pass idempotencyKey to distinguish two equal bridges. ' +
    'An RPC drop after broadcast fail-closes instead of burning a second time.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      fromChain: {
        type: 'string',
        enum: [...SUPPORTED_CHAINS],
        description: 'Source chain name',
      },
      toChain: {
        type: 'string',
        enum: [...SUPPORTED_CHAINS],
        description: 'Destination chain name',
      },
      amount: {
        type: 'string',
        description: 'Amount of USDC to bridge (human-readable, e.g. "100")',
      },
      idempotencyKey: {
        type: 'string',
        minLength: 1,
        maxLength: 128,
        description:
          'Optional idempotency key (1-128 chars). Distinct keys allow two equal bridges.',
      },
    },
    required: ['fromChain', 'toChain', 'amount'],
  },
}

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleBridgeUsdc(
  input: BridgeUsdcInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet()

    if (input.fromChain === input.toChain) {
      throw new Error('fromChain and toChain must be different')
    }

    assertConfiguredBridgeSource(input.fromChain, 'bridge_usdc')

    // Parse USDC amount (6 decimals) — strict string parsing, no float rounding
    const USDC_DECIMALS = 6
    const rawAmount = parseAmountStrict(input.amount, USDC_DECIMALS)
    const intent = bridgeUsdcIntentIdentity({
      fromChain: input.fromChain,
      toChain: input.toChain,
      rawAmount,
      idempotencyKey: input.idempotencyKey,
    })

    const { value, replayed } = await withSpendIntent(
      intent.key,
      async () => {
      // Enforce the in-process spend policy before burning USDC on the source
      // chain. rawAmount is USDC 6-decimal base units; enforceSpendPolicy
      // normalises it to the policy's 18-decimal ETH-equivalent caps (1 USDC
      // counts as 1 ETH-equivalent) — never compare 6-decimal base units
      // against wei-scale caps directly. CCTP mints to the burning wallet's own
      // address, so the policy merchant is the agent wallet itself: allowlist-only
      // policies must include the agent wallet address to permit bridging.
      const bridgeRecipient = wallet.walletClient?.account?.address
      if (!bridgeRecipient) {
        throw new DefiniteSpendFailure(
          'Wallet client has no account; cannot verify spend policy for bridge_usdc.'
        )
      }
      const policyDecision = await enforceSpendPolicy({
        merchant: bridgeRecipient,
        amount: rawAmount,
        decimals: USDC_DECIMALS,
      })
      if (policyDecision.status === 'rejected') {
        throw new DefiniteSpendFailure(
          policyDecision.reason ??
            `Bridge blocked by spend policy for recipient ${bridgeRecipient}.`
        )
      }
      if (policyDecision.status === 'draft') {
        throw new DefiniteSpendFailure(
          `Bridge exceeds per-tx spend policy and was queued as draft` +
            `${policyDecision.draftId ? ` (${policyDecision.draftId})` : ''}. ` +
            (policyDecision.reason ?? 'Approve the draft before executing.')
        )
      }

      const bridge = createBridge(wallet.walletClient as AnyWalletClient, input.fromChain as SupportedChain)

      const result = await bridge.bridge(rawAmount, input.toChain as SupportedChain)

      return {
        success: true as const,
        burnTxHash: result.burnTxHash,
        mintTxHash: result.mintTxHash,
        fromChain: result.fromChain,
        toChain: result.toChain,
        recipient: result.recipient,
        amount: input.amount,
        rawAmount: rawAmount.toString(),
        elapsedMs: result.elapsedMs,
      }
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
    return {
      content: [textContent(formatError(error, 'bridge_usdc'))],
      isError: true,
    }
  }
}
