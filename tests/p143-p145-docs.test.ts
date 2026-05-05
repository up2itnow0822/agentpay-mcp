import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readDoc(path: string): string {
  return readFileSync(new URL(path, import.meta.url), 'utf8');
}

describe('P-143/P-144/P-145 docs', () => {
  it('documents paid-tool quality thresholds and fail-closed signing gates', () => {
    const doc = readDoc('../docs/paid-tool-quality-thresholds.md');

    expect(doc).toContain('score gates');
    expect(doc).toContain('provider-health snapshot');
    expect(doc).toContain('fail-closed approval gate');
    expect(doc).toContain('decision: "deny"');
  });

  it('documents authorized cybersecurity scan controls', () => {
    const doc = readDoc('../docs/authorized-cybersecurity-scan-profile.md');

    expect(doc).toContain('target authorization attestation');
    expect(doc).toContain('allowed-domain binding');
    expect(doc).toContain('per-target spend cap');
    expect(doc).toContain('x402 receipt');
  });

  it('states post-quantum envelope compatibility without claiming ML-DSA implementation', () => {
    const doc = readDoc('../docs/post-quantum-spend-envelope-compatibility.md');

    expect(doc).toContain('does not claim post-quantum cryptography');
    expect(doc).toContain('ML-DSA-65 signing');
    expect(doc).toContain('Requires adapter');
  });
});
