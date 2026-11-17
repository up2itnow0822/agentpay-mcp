/**
 * Shared viem-shaped receipt logs for SDK 7 transfer/outcome tests.
 */
import {
  encodeAbiParameters,
  encodeEventTopics,
  getAddress,
  pad,
  parseAbiItem,
  toEventHash,
  type Address,
  type Hex,
} from 'viem'

const _transferTopics = encodeEventTopics({
  abi: [parseAbiItem('event Transfer(address indexed from, address indexed to, uint256 value)')],
  eventName: 'Transfer',
})

export const ERC20_TRANSFER_TOPIC = _transferTopics[0]! as Hex

export function erc20TransferLog(token: Address, from: Address, to: Address, amount: bigint) {
  return {
    address: getAddress(token),
    topics: [ERC20_TRANSFER_TOPIC, pad(from, { size: 32 }), pad(to, { size: 32 })] as [Hex, Hex, Hex],
    data: pad(`0x${amount.toString(16)}`, { size: 32 }),
  }
}

export function queuedWalletLog(walletAddr: Address, to: Address, txId: bigint) {
  const wallet = getAddress(walletAddr)
  return {
    address: wallet,
    topics: [
      toEventHash({
        type: 'event',
        name: 'TransactionQueued',
        inputs: [
          { name: 'txId', type: 'uint256', indexed: true },
          { name: 'to', type: 'address', indexed: true },
          { name: 'value', type: 'uint256', indexed: false },
          { name: 'token', type: 'address', indexed: false },
          { name: 'amount', type: 'uint256', indexed: false },
        ],
      }),
      pad(`0x${txId.toString(16)}`, { size: 32 }),
      pad(to, { size: 32 }),
    ] as [Hex, Hex, Hex],
    data: encodeAbiParameters(
      [
        { name: 'value', type: 'uint256' },
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
      ],
      [0n, '0x0000000000000000000000000000000000000000', 0n]
    ),
  }
}

export function executedWalletLog(walletAddr: Address, to: Address, value: bigint) {
  const wallet = getAddress(walletAddr)
  return {
    address: wallet,
    topics: [
      toEventHash({
        type: 'event',
        name: 'TransactionExecuted',
        inputs: [
          { name: 'target', type: 'address', indexed: true },
          { name: 'value', type: 'uint256', indexed: false },
          { name: 'data', type: 'bytes', indexed: false },
          { name: 'executor', type: 'address', indexed: true },
        ],
      }),
      pad(to, { size: 32 }),
      pad(wallet, { size: 32 }),
    ] as [Hex, Hex, Hex],
    data: encodeAbiParameters(
      [
        { name: 'value', type: 'uint256' },
        { name: 'data', type: 'bytes' },
      ],
      [value, '0x']
    ),
  }
}
