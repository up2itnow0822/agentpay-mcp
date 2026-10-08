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

describe('x402 settlement receipt log', () => {
  beforeEach(() => {
    _resetX402SettlementLog();
  });

  it('records a settlement once per intent key', () => {
    recordX402Settlement({
      intentKey: 'x402_pay#invoice-1',
      url: 'https://api.example.com/premium',
      method: 'GET',
      amount: '1000000',
      recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
      txHash: TX_A,
    });
    const second = recordX402Settlement({
      intentKey: 'x402_pay#invoice-1',
      url: 'https://api.example.com/other',
      method: 'POST',
      amount: '2',
      recipient: '0xdead',
      txHash: TX_B,
    });

    expect(listX402Settlements()).toHaveLength(1);
    expect(second.txHash).toBe(TX_A);
    expect(second.url).toBe('https://api.example.com/premium');
  });

  it('increments replay count without adding a second tx', () => {
    recordX402Settlement({
      intentKey: 'k1',
      url: 'https://api.example.com/premium',
      method: 'GET',
      amount: '1000000',
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
        recipient: '0xfeedfacefeedfacefeedfacefeedfacefeedface',
        txHash: TX_A,
      });
    }

    const receipts = listX402Settlements();
    expect(receipts).toHaveLength(X402_SETTLEMENT_LOG_MAX);
    expect(receipts[0]?.intentKey).toBe('k1');
    expect(receipts.at(-1)?.intentKey).toBe(`k${X402_SETTLEMENT_LOG_MAX}`);
  });
});
