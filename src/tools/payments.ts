/**
 * payments.ts — send_payment tool.
 * Executes ETH or ERC20 token transfers via the AgentAccountV2 contract.
 */
import { z } from 'zod';
import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { agentExecute, agentTransferToken, getGlobalRegistry } from 'agentwallet-sdk';
import { getWallet, getConfig, type AgentWalletInstance } from '../utils/client.js';
import {
  textContent,
  explorerTxUrl,
  chainName,
  formatError,
} from '../utils/format.js';
import { withReservedSpend } from './budget.js';
import {
  DefiniteSpendFailure,
  IDEMPOTENCY_KEY_JSON_SCHEMA,
  IdempotencyKeyZodSchema,
  requireSettlementHash,
  runClassifiedSpend,
  sendPaymentIntentIdentity,
  withSpendIntent,
} from '../utils/spend-intent.js';

const NATIVE_TOKEN = zeroAddress;

// ─── Schema ────────────────────────────────────────────────────────────────

export const SendPaymentSchema = z.object({
  to: z
    .string()
    .describe('Recipient address (0x-prefixed, checksummed or lowercase)'),
  amount_eth: z
    .string()
    .describe(
      'Amount to send, expressed in ETH (e.g. "0.001"). ' +
      'For ERC20 tokens, this is the human-readable amount (e.g. "1.5" for 1.5 USDC). ' +
      'Use the token_decimals parameter to control precision.'
    ),
  token: z
    .string()
    .optional()
    .describe(
      'ERC20 token contract address. ' +
      'Omit or use "0x0000000000000000000000000000000000000000" for native ETH.'
    ),
  token_decimals: z
    .number()
    .int()
    .min(0)
    .max(18)
    .optional()
    .describe(
      'Optional assertion of the token decimal places. The authoritative value is the ' +
      'token registry entry or the token contract decimals(); a mismatch is rejected ' +
      'before policy evaluation or signing.'
    ),
  memo: z
    .string()
    .max(200)
    .optional()
    .describe('Optional memo/note for this payment (logged locally, not on-chain).'),
  idempotencyKey: IdempotencyKeyZodSchema.optional()
    .describe(
      'Caller-supplied idempotency key. The same key replays the original transfer; ' +
        'reusing it with a different payload is refused; distinct keys allow two equal ' +
        'payments. Retries without a key collapse on the payment payload for five minutes.'
    ),
});

export type SendPaymentInput = z.infer<typeof SendPaymentSchema>;

// ─── Tool definition ───────────────────────────────────────────────────────

export const sendPaymentTool = {
  name: 'send_payment',
  description:
    'Send ETH or ERC20 tokens from the Agent Wallet. ' +
    'If the amount is within the configured spend limits, it executes immediately and returns the tx hash. ' +
    'If it exceeds limits, the transaction is queued for owner approval (use queue_approval to manage). ' +
    'Always check spend limits first with check_spend_limit to avoid surprises. ' +
    'Identical retries replay the original transfer; pass idempotencyKey to distinguish two equal payments. ' +
    'An RPC drop after broadcast fail-closes instead of sending a second transfer.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      to: {
        type: 'string',
        description: 'Recipient wallet address (0x-prefixed)',
      },
      amount_eth: {
        type: 'string',
        description: 'Amount in ETH (or token units). E.g. "0.001" for 0.001 ETH, "1.5" for 1.5 USDC',
      },
      token: {
        type: 'string',
        description: 'ERC20 token address. Omit for native ETH.',
      },
      token_decimals: {
        type: 'number',
        description:
          'Optional assertion of the token decimals. The authoritative value comes from the ' +
          'token registry or the token contract; a mismatching value is rejected.',
      },
      memo: {
        type: 'string',
        description: 'Optional memo for this payment (not stored on-chain)',
        maxLength: 200,
      },
      idempotencyKey: {
        ...IDEMPOTENCY_KEY_JSON_SCHEMA,
        description:
          'Optional idempotency key (1-128 non-whitespace chars). Distinct keys allow two equal payments.',
      },
    },
    required: ['to', 'amount_eth'],
  },
};

// ─── Handler ───────────────────────────────────────────────────────────────

export async function handleSendPayment(
  input: SendPaymentInput
): Promise<{ content: Array<{ type: 'text'; text: string }>; isError?: boolean }> {
  try {
    const wallet = getWallet();
    const config = getConfig();

    // Validate recipient address: well-formed and not the burn address.
    if (!isAddress(input.to, { strict: false })) {
      throw new Error(
        `Invalid recipient address: "${input.to}". Must be a 0x-prefixed 42-character hex string.`
      );
    }
    const toAddress = getAddress(input.to);
    if (toAddress === zeroAddress) {
      throw new Error('Invalid recipient address: the zero address would burn the funds.');
    }

    const isNativeEth = !input.token || input.token.toLowerCase() === NATIVE_TOKEN;
    if (!isNativeEth && !isAddress(input.token!, { strict: false })) {
      throw new Error(`Invalid token address: "${input.token}".`);
    }
    const tokenAddress = isNativeEth ? NATIVE_TOKEN : getAddress(input.token!);
    const tokenLabel = isNativeEth ? 'ETH' : tokenAddress;
    const decimals = await resolveTransferDecimals(
      wallet,
      tokenAddress,
      input.token_decimals,
      config.chainId
    );
    const amountWei = parseExactTokenAmount(input.amount_eth, decimals);

    const intent = sendPaymentIntentIdentity({
      chainId: config.chainId,
      tokenAddress,
      recipientAddress: toAddress,
      rawAmount: amountWei,
      idempotencyKey: input.idempotencyKey,
    });

    const { value: txHash, replayed } = await withSpendIntent(
      intent.key,
      () =>
        // Policy is reserved before the write and committed / released /
        // locked by the classified outcome. amountWei is in the token's own
        // base units; decimals lets the policy normalise to its caps.
        withReservedSpend({ merchant: toAddress, amount: amountWei, decimals }, async () =>
          requireSettlementHash(
            await runClassifiedSpend(wallet.walletClient, async () => {
              if (isNativeEth) {
                const result = await agentExecute(wallet, { to: toAddress, value: amountWei });
                return result.txHash;
              }
              return agentTransferToken(wallet, {
                token: tokenAddress,
                to: toAddress,
                amount: amountWei,
              });
            }),
            'send_payment'
          )
        ),
      {
        durable: Boolean(input.idempotencyKey?.trim()),
        fingerprint: intent.fingerprint,
      }
    );

    const explorerUrl = explorerTxUrl(txHash as `0x${string}`, config.chainId);
    const memoLine = input.memo ? `\n📝 Memo: ${input.memo}` : '';
    const replayLine = replayed
      ? '\n♻️ Idempotent retry: original transfer replayed; nothing new was sent.'
      : '';

    return {
      content: [
        textContent(
          `✅ **Payment Sent**\n\n` +
          `  To:      ${toAddress}\n` +
          `  Amount:  ${input.amount_eth} ${tokenLabel}\n` +
          `  Token:   ${tokenLabel}\n` +
          `  Network: ${chainName(config.chainId)}\n` +
          `  TX Hash: ${txHash}\n` +
          `  🔗 ${explorerUrl}` +
          memoLine + replayLine + '\n\n' +
          `ℹ️  If the transaction was over-limit, it was queued for owner approval.\n` +
          `   Use queue_approval (action="list") to check pending transactions.`
        ),
      ],
    };
  } catch (error: unknown) {
    return {
      content: [textContent(formatError(error, 'send_payment'))],
      isError: true,
    };
  }
}

// ─── Token amount parser ───────────────────────────────────────────────────

/**
 * Resolve ERC-20 decimals from an explicit override or the TokenRegistry.
 * Never assume 18 decimals for an arbitrary token address — that silently
 * overpays by 10^12 for USDC (6 decimals) when callers omit token_decimals.
 */
export function resolveTokenDecimals(
  token: Address,
  explicitDecimals: number | undefined,
  chainId: number
): number {
  const authoritative = knownTokenDecimals(token, chainId);
  if (authoritative !== undefined) {
    assertDecimalsMatch(token, explicitDecimals, authoritative);
    return authoritative;
  }
  if (explicitDecimals !== undefined) return explicitDecimals;

  throw new Error(
    `Unknown decimals for token ${token} on chain ${chainId}. ` +
      'Register the token with add_custom_token or use a registry-known token.'
  );
}

/** Registry / native decimals, or undefined when the token is unknown. */
function knownTokenDecimals(token: Address, chainId: number): number | undefined {
  if (token.toLowerCase() === NATIVE_TOKEN) return 18;
  return getGlobalRegistry().getTokenByAddress(token, chainId)?.decimals;
}

/**
 * Caller-supplied decimals are an assertion, never an override. Accepting a
 * larger value for a six-decimal token used to scale both the raw transfer
 * and the policy amount by up to 10^12 while the policy saw the small human
 * figure (F2).
 */
function assertDecimalsMatch(
  token: Address,
  explicitDecimals: number | undefined,
  authoritative: number
): void {
  if (explicitDecimals !== undefined && explicitDecimals !== authoritative) {
    throw new DefiniteSpendFailure(
      `token_decimals ${explicitDecimals} does not match the authoritative ` +
        `${authoritative} decimals of ${token}. Refusing to sign.`
    );
  }
}

const ERC20_DECIMALS_ABI = [
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ name: '', type: 'uint8' }],
  },
] as const;

/**
 * Resolve the decimals a transfer will actually be denominated in.
 * Registry / native first; otherwise read decimals() from the token contract
 * on the configured chain. A caller value is only ever cross-checked.
 */
export async function resolveTransferDecimals(
  wallet: AgentWalletInstance,
  token: Address,
  explicitDecimals: number | undefined,
  chainId: number
): Promise<number> {
  const known = knownTokenDecimals(token, chainId);
  if (known !== undefined) {
    assertDecimalsMatch(token, explicitDecimals, known);
    return known;
  }
  const publicClient = (wallet as unknown as {
    publicClient?: { readContract?: (_args: unknown) => Promise<unknown> };
  }).publicClient;
  let onChain: unknown;
  try {
    if (typeof publicClient?.readContract !== 'function') {
      throw new Error('no public client');
    }
    onChain = await publicClient.readContract({
      address: token,
      abi: ERC20_DECIMALS_ABI,
      functionName: 'decimals',
    });
  } catch {
    throw new Error(
      `Unknown decimals for token ${token} on chain ${chainId}: decimals() could not be read ` +
        'from the token contract. Register the token with add_custom_token first.'
    );
  }
  const decimals = Number(onChain);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18) {
    throw new Error(
      `Token ${token} reports unsupported decimals ${String(onChain)}; refusing to sign.`
    );
  }
  assertDecimalsMatch(token, explicitDecimals, decimals);
  return decimals;
}

/**
 * Strict parser for amounts that will be SIGNED: plain decimal notation only,
 * no excess precision (which would silently round), strictly positive.
 */
export function parseExactTokenAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(trimmed);
  if (!match) {
    throw new Error(`Invalid amount: "${amount}". Use a plain positive decimal such as "1.5".`);
  }
  const [, intPart, fracPart = ''] = match;
  if (fracPart.length > decimals) {
    throw new Error(
      `Invalid amount: "${amount}" has more than ${decimals} decimal places for this token.`
    );
  }
  const raw = BigInt(intPart! + fracPart.padEnd(decimals, '0'));
  if (raw <= 0n) {
    throw new Error(`Invalid amount: "${amount}". Must be a positive number.`);
  }
  return raw;
}

/**
 * Parse a human-readable token amount string into base units (bigint).
 * Handles floating-point precision correctly without using JavaScript floats.
 * e.g., "1.5" with decimals=6 → 1500000n
 */
export function parseTokenAmount(amount: string, decimals: number): bigint {
  const trimmed = amount.trim();
  if (!trimmed || isNaN(Number(trimmed))) {
    throw new Error(`Invalid amount: "${amount}"`);
  }

  const [intPart, fracPart = ''] = trimmed.split('.');
  const fracTrimmed = fracPart.slice(0, decimals).padEnd(decimals, '0');
  const intStr = (intPart ?? '0') + fracTrimmed;

  return BigInt(intStr);
}
