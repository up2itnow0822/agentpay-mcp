/**
 * Tests for parseAmountStrict — strict decimal amount parsing (no floats).
 */
import { describe, it, expect } from 'vitest';
import { parseAmountStrict } from '../src/utils/amount.js';

describe('parseAmountStrict', () => {
  // ─── Valid inputs ─────────────────────────────────────────────────────────

  it('parses integer amounts', () => {
    expect(parseAmountStrict('100', 6)).toBe(100_000_000n);
    expect(parseAmountStrict('1', 18)).toBe(1_000_000_000_000_000_000n);
  });

  it('parses decimal amounts', () => {
    expect(parseAmountStrict('1.5', 6)).toBe(1_500_000n);
    expect(parseAmountStrict('0.001', 18)).toBe(1_000_000_000_000_000n);
  });

  it('parses bare-fraction amounts (".5")', () => {
    expect(parseAmountStrict('.5', 6)).toBe(500_000n);
  });

  it('trims leading/trailing whitespace (documented behavior: " 5 " is accepted)', () => {
    expect(parseAmountStrict(' 5 ', 6)).toBe(5_000_000n);
  });

  it('accepts exactly max decimal places for the asset', () => {
    // Smallest USDC unit
    expect(parseAmountStrict('0.000001', 6)).toBe(1n);
    // Smallest ETH unit (1 wei)
    expect(parseAmountStrict('0.000000000000000001', 18)).toBe(1n);
  });

  it('converts a 17-decimal ETH value exactly (parseFloat collapses it)', () => {
    const exact = parseAmountStrict('1.00000000000000001', 18);
    expect(exact).toBe(1_000_000_000_000_000_010n);
    // The old float path silently drops the fractional tail:
    const floatPath = BigInt(Math.round(parseFloat('1.00000000000000001') * 1e18));
    expect(floatPath).toBe(1_000_000_000_000_000_000n);
    expect(floatPath).not.toBe(exact);
  });

  it('converts large USDC amounts beyond float precision exactly', () => {
    const exact = parseAmountStrict('10000000000000.000001', 6);
    expect(exact).toBe(10_000_000_000_000_000_001n);
    // The old float path loses the final base unit:
    const floatPath = BigInt(Math.round(parseFloat('10000000000000.000001') * 10 ** 6));
    expect(floatPath).not.toBe(exact);
  });

  // ─── Rejected inputs ──────────────────────────────────────────────────────

  it('rejects comma-formatted amounts ("1,000") instead of parsing them as 1', () => {
    expect(() => parseAmountStrict('1,000', 6)).toThrow(
      'Invalid amount: "1,000". Must be a positive number.'
    );
  });

  it('rejects exponent notation ("1e3")', () => {
    expect(() => parseAmountStrict('1e3', 6)).toThrow('Invalid amount');
  });

  it('rejects hex notation ("0x10")', () => {
    expect(() => parseAmountStrict('0x10', 6)).toThrow('Invalid amount');
  });

  it('rejects multiple dots ("1.2.3")', () => {
    expect(() => parseAmountStrict('1.2.3', 6)).toThrow('Invalid amount');
  });

  it('rejects empty and whitespace-only strings', () => {
    expect(() => parseAmountStrict('', 6)).toThrow('Invalid amount');
    expect(() => parseAmountStrict('   ', 6)).toThrow('Invalid amount');
  });

  it('rejects signed amounts ("-5", "+5")', () => {
    expect(() => parseAmountStrict('-5', 6)).toThrow('Invalid amount');
    expect(() => parseAmountStrict('+5', 6)).toThrow('Invalid amount');
  });

  it('rejects trailing dots ("5.")', () => {
    expect(() => parseAmountStrict('5.', 6)).toThrow('Invalid amount');
  });

  it('rejects zero', () => {
    expect(() => parseAmountStrict('0', 6)).toThrow('Must be a positive number');
    expect(() => parseAmountStrict('0.0', 6)).toThrow('Must be a positive number');
  });

  it('rejects excess decimal places instead of truncating or rounding', () => {
    expect(() => parseAmountStrict('0.0000001', 6)).toThrow(
      'Too many decimal places (max 6)'
    );
    expect(() => parseAmountStrict('1.0000000000000000001', 18)).toThrow(
      'Too many decimal places (max 18)'
    );
  });

  it('rejects non-numeric garbage', () => {
    expect(() => parseAmountStrict('not-a-number', 18)).toThrow('Invalid amount');
    expect(() => parseAmountStrict('Infinity', 18)).toThrow('Invalid amount');
    expect(() => parseAmountStrict('NaN', 18)).toThrow('Invalid amount');
  });

  // ─── Error-message label ──────────────────────────────────────────────────

  it('uses the provided label in error messages', () => {
    expect(() => parseAmountStrict('1,000', 6, 'stakeAmount')).toThrow(
      'Invalid stakeAmount: "1,000". Must be a positive number.'
    );
  });

  // ─── Decimals guard ───────────────────────────────────────────────────────

  it('rejects invalid decimals arguments', () => {
    expect(() => parseAmountStrict('1', -1)).toThrow('Invalid decimals');
    expect(() => parseAmountStrict('1', 1.5)).toThrow('Invalid decimals');
  });
});
