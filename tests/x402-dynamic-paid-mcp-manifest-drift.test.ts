import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  assertNoStaticPaidMcpManifestAssumptions,
  compareDynamicPaidMcpManifestSnapshots,
  validateDynamicPaidMcpManifestSnapshot,
  type DynamicPaidMcpManifestSnapshot,
} from '../src/utils/x402-dynamic-paid-mcp-manifest-drift.js';

const latest = JSON.parse(
  readFileSync(new URL('../docs/fixtures/dynamic-paid-mcp-manifest-rugmunch-2026-05-04.json', import.meta.url), 'utf8')
) as DynamicPaidMcpManifestSnapshot;

const baseline = JSON.parse(
  readFileSync(new URL('../docs/fixtures/dynamic-paid-mcp-manifest-rugmunch-2026-05-04-baseline.json', import.meta.url), 'utf8')
) as DynamicPaidMcpManifestSnapshot;

describe('dynamic paid MCP manifest drift proof', () => {
  it('validates a fresh no-trial paid MCP snapshot while warning on capability drift', () => {
    const report = validateDynamicPaidMcpManifestSnapshot(latest, {
      now: new Date('2026-05-04T06:00:00Z'),
      maxSnapshotAgeHours: 24,
    });

    expect(report.stale).toBe(false);
    expect(report.hasSupportedNetworks).toBe(true);
    expect(report.hasPricingClarity).toBe(true);
    expect(report.hasTrialPolicyClarity).toBe(true);
    expect(report.hasDirectoryEndpointFreshness).toBe(true);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'info', field: 'pricing.endpointCount' }),
        expect.objectContaining({ severity: 'warning', field: 'capabilities.free_trial' }),
      ])
    );
    expect(report.findings.some((finding) => finding.severity === 'critical')).toBe(false);
  });

  it('flags stale snapshots so buyer agents refresh before routing', () => {
    const report = validateDynamicPaidMcpManifestSnapshot(latest, {
      now: new Date('2026-05-06T06:00:00Z'),
      maxSnapshotAgeHours: 24,
    });

    expect(report.stale).toBe(true);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ severity: 'warning', field: 'capturedAt' })
    );
  });

  it('detects launch-night drift in tool count and trial policy', () => {
    const drift = compareDynamicPaidMcpManifestSnapshots(baseline, latest);

    expect(drift.changedFields).toEqual(
      expect.arrayContaining(['mcp.totalTools', 'trial.enabled', 'trial.description', 'commitSha'])
    );
    expect(drift.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ severity: 'warning', field: 'mcp.totalTools' }),
        expect.objectContaining({ severity: 'critical', field: 'trial.enabled' }),
      ])
    );
  });

  it('catches static buyer assumptions about tool count and trial policy', () => {
    const drift = assertNoStaticPaidMcpManifestAssumptions(baseline, latest);

    expect(drift.changedFields).toContain('mcp.totalTools');
    expect(drift.changedFields).toContain('trial.enabled');
    expect(latest.mcp.totalTools).not.toBe(baseline.mcp.totalTools);
    expect(latest.trial.enabled).toBe(false);
  });

  it('fails closed when no-trial snapshots omit endpoint pricing', () => {
    const broken = {
      ...latest,
      pricing: {
        ...latest.pricing,
        endpointsWithPrice: 29,
      },
    } as DynamicPaidMcpManifestSnapshot;

    const report = validateDynamicPaidMcpManifestSnapshot(broken, {
      now: new Date('2026-05-04T06:00:00Z'),
    });

    expect(report.hasPricingClarity).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ severity: 'critical', field: 'pricing' })
    );
  });
});
