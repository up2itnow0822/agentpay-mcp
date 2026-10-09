import { describe, it, expect, beforeEach } from 'vitest';
import {
  X402_SETTLEMENT_LOG_MAX,
  _resetX402SettlementLog,
  listX402Settlements,
  recordX402Settlement,
  recordX402SettlementReplay,
} from '../src/utils/x402-receipt-log.js';

const TX_A = '0xc480941a588f513a6f4ecbcee0826ea66147b0f68488131572522830b4ac60fb';
const TX_B = '0x66e6299fee8deb3c350e639edf1de966dbbf639b0a4834080e9a98c438b60340';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const DAI_BASE = '0x50c5725949A6F0c72E6C4a641F24049A917Db0Cb';

describe('x402 settlement receipt log', () => {
  beforeEach(() => {
    _resetX402SettlementLog();
  });

  it('deduplicates the same settlement tx hash for an intent key', () => {
    recordX402Settlement({
      intentKey: 'x402_pay#invoice-1',
      url: 'https://api.example.com/premium',
      method: 'GET',
      amount: '1000000',
      token: USDC_BASE,
      recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
      txHash: TX_A,
    });
    const second = recordX402Settlement({
      intentKey: 'x402_pay#invoice-1',
      url: 'https://api.example.com/other',
      method: 'POST',
      amount: '2',
      token: DAI_BASE,
      recipient: '0xdead',
      txHash: TX_A,
    });

    expect(listX402Settlements()).toHaveLength(1);
    expect(second.txHash).toBe(TX_A);
    expect(second.url).toBe('https://api.example.com/premium');
  });

  it('records a new generation when the same intent settles with a new tx hash', () => {
    recordX402Settlement({
      intentKey: 'x402_pay#invoice-1',
      url: 'https://api.example.com/premium',
      method: 'GET',
      amount: '1000000',
      token: USDC_BASE,
      recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
      txHash: TX_A,
    });
    const second = recordX402Settlement({
      intentKey: 'x402_pay#invoice-1',
      url: 'https://api.example.com/premium',
      method: 'GET',
      amount: '1000000',
      token: USDC_BASE,
      recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
      txHash: TX_B,
    });
    const replayed = recordX402SettlementReplay('x402_pay#invoice-1');
    const receipts = listX402Settlements();

    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.txHash).toBe(TX_A);
    expect(receipts[0]?.replayCount).toBe(0);
    expect(second.txHash).toBe(TX_B);
    expect(replayed?.txHash).toBe(TX_B);
    expect(replayed?.replayCount).toBe(1);
  });

  it('increments replay count without adding a second tx', () => {
    recordX402Settlement({
      intentKey: 'k1',
      url: 'https://api.example.com/premium',
      method: 'GET',
      amount: '1000000',
      token: USDC_BASE,
      recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
      txHash: TX_A,
    });
    const replayed = recordX402SettlementReplay('k1');

    expect(replayed?.replayCount).toBe(1);
    expect(listX402Settlements()).toHaveLength(1);
    expect(listX402Settlements()[0]?.txHash).toBe(TX_A);
  });

  it('evicts the oldest settlement when the cap is exceeded', () => {
    for (let i = 0; i < X402_SETTLEMENT_LOG_MAX + 1; i++) {
      recordX402Settlement({
        intentKey: `k${i}`,
        url: `https://api.example.com/${i}`,
        method: 'GET',
        amount: '1',
        token: USDC_BASE,
        recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
        txHash: TX_A,
      });
    }

    const receipts = listX402Settlements();
    expect(receipts).toHaveLength(X402_SETTLEMENT_LOG_MAX);
    expect(receipts[0]?.intentKey).toBe('k1');
    expect(receipts.at(-1)?.intentKey).toBe(`k${X402_SETTLEMENT_LOG_MAX}`);
  });

  it('retains the settlement token so non-USDC amounts stay reconcilable', () => {
    const receipt = recordX402Settlement({
      intentKey: 'x402_pay#dai',
      url: 'https://api.example.com/dai',
      method: 'GET',
      amount: '1000000',
      token: DAI_BASE,
      recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
      txHash: TX_A,
    });

    expect(receipt.token).toBe(DAI_BASE);
    expect(listX402Settlements()[0]?.token).toBe(DAI_BASE);
  });
});
