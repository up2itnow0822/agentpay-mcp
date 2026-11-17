/**
 * SDK 7 wrapper #14: bind CCTP messageBytes to MessageTransmitter logs and
 * verify attested burn bodies before receiveMessage.
 */
import type { BridgeChain } from 'agentwallet-sdk'

type EvmBridgeChain = Exclude<BridgeChain, 'solana'>
import {
  CCTP_DOMAIN_IDS,
  MESSAGE_TRANSMITTER_V2,
  USDC_CONTRACT,
} from 'agentwallet-sdk'
import { getAddress, pad, type Address, type Hash, type Hex, type TransactionReceipt } from 'viem'
import { DefiniteSpendFailure } from './spend-intent.js'

const MESSAGE_SENT_TOPIC = '0x8c5261668696ce22758910d05bab8f186d6eb247ceac2af2e82c7dc17669b036'

export interface CctpBurnMessageFields {
  sourceDomain: number
  destinationDomain: number
  burnToken: Address
  mintRecipient: Address
  amount: bigint
}

export interface ExtractedMessageSent {
  messageBytes: Hex
  messageHash: Hex
  nonce: bigint
}

export function decodeCctpBurnMessage(messageBytes: Hex): CctpBurnMessageFields | null {
  const h = messageBytes.toLowerCase().replace(/^0x/, '')
  if (h.length < 376 * 2) return null
  const sourceDomain = Number(BigInt('0x' + h.slice(8, 16)))
  const destinationDomain = Number(BigInt('0x' + h.slice(16, 24)))
  const wordAt = (byteOffset: number) => h.slice(byteOffset * 2, (byteOffset + 32) * 2)
  const burnToken = getAddress(('0x' + wordAt(148 + 32).slice(24)) as `0x${string}`)
  const mintRecipient = getAddress(('0x' + wordAt(148 + 64).slice(24)) as `0x${string}`)
  const amount = BigInt('0x' + wordAt(148 + 96))
  return { sourceDomain, destinationDomain, burnToken, mintRecipient, amount }
}

export function extractMessageSentFromTransmitter(
  receipt: Pick<TransactionReceipt, 'logs'>,
  transmitterAddress: Address
): ExtractedMessageSent {
  const want = transmitterAddress.toLowerCase()
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== want) continue
    if (log.topics[0]?.toLowerCase() !== MESSAGE_SENT_TOPIC.toLowerCase()) continue
    const rawData = log.data
    if (rawData.length < 130) continue
    const dataHex = rawData.slice(2)
    const lengthHex = dataHex.slice(64, 128)
    const messageLength = parseInt(lengthHex, 16)
    if (messageLength === 0) continue
    const messageBytesHex = dataHex.slice(128, 128 + messageLength * 2)
    const messageBytes = ('0x' + messageBytesHex) as Hex
    const nonceBytesHex = messageBytesHex.slice(24, 40)
    const nonce = BigInt('0x' + nonceBytesHex)
    return { messageBytes, messageHash: ('0x' + '00'.repeat(32)) as Hex, nonce }
  }
  throw new DefiniteSpendFailure(
    `Burn receipt has no MessageSent event from MESSAGE_TRANSMITTER_V2 at ${transmitterAddress}.`
  )
}

export function assertAttestedMessageMatchesBurn(
  attestedMessage: Hex,
  burn: {
    sourceDomain: number
    destinationDomain: number
    amount: bigint
    mintRecipient: Address
    fromChain: EvmBridgeChain
    toChain: EvmBridgeChain
  }
): void {
  const decoded = decodeCctpBurnMessage(attestedMessage)
  if (!decoded) {
    throw new DefiniteSpendFailure('Attested CCTP message is too short to decode.')
  }
  if (decoded.sourceDomain !== burn.sourceDomain) {
    throw new DefiniteSpendFailure(
      `Attestation sourceDomain ${decoded.sourceDomain} does not match burn ${burn.sourceDomain}.`
    )
  }
  if (decoded.destinationDomain !== burn.destinationDomain) {
    throw new DefiniteSpendFailure(
      `Attestation destinationDomain ${decoded.destinationDomain} does not match burn ${burn.destinationDomain}.`
    )
  }
  const expectedBurnToken = getAddress(USDC_CONTRACT[burn.fromChain])
  if (getAddress(decoded.burnToken) !== expectedBurnToken) {
    throw new DefiniteSpendFailure(
      `Attestation burnToken ${decoded.burnToken} does not match expected USDC on ${burn.fromChain}.`
    )
  }
  const expectedMintPadded = pad(burn.mintRecipient, { size: 32 }).toLowerCase()
  const decodedMintPadded = pad(decoded.mintRecipient, { size: 32 }).toLowerCase()
  if (decodedMintPadded !== expectedMintPadded) {
    throw new DefiniteSpendFailure('Attestation mintRecipient does not match the burn recipient.')
  }
  if (decoded.amount !== burn.amount) {
    throw new DefiniteSpendFailure(
      `Attestation amount ${decoded.amount.toString()} does not match burn amount ${burn.amount.toString()}.`
    )
  }
  if (decoded.sourceDomain !== CCTP_DOMAIN_IDS[burn.fromChain]) {
    throw new DefiniteSpendFailure('Attested sourceDomain does not match the configured from-chain.')
  }
  if (decoded.destinationDomain !== CCTP_DOMAIN_IDS[burn.toChain]) {
    throw new DefiniteSpendFailure('Attested destinationDomain does not match the configured to-chain.')
  }
}

export async function loadBurnReceiptMessageBytes(
  getReceipt: (hash: Hash) => Promise<Pick<TransactionReceipt, 'logs'>>,
  burnTxHash: Hash,
  fromChain: EvmBridgeChain
): Promise<Hex> {
  const receipt = await getReceipt(burnTxHash)
  const transmitter = MESSAGE_TRANSMITTER_V2[fromChain]
  return extractMessageSentFromTransmitter(receipt, transmitter).messageBytes
}