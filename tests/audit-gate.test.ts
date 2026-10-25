import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain JavaScript script without types
import { auditProblems, blockingAdvisories } from '../scripts/audit.mjs';

const advisory = (id: string, name: string, severity: string) => ({
  source: 1,
  name,
  dependency: name,
  title: `${name} problem`,
  url: `https://github.com/advisories/${id}`,
  severity,
  range: '<9.0.0',
});
// The shape of `npm audit --json`: packages vulnerable through a dependency name it as a string.
const report = (...vias: ReturnType<typeof advisory>[]) => ({
  vulnerabilities: {
    ...Object.fromEntries(
      vias.map((via) => [via.name, { severity: via.severity, via: [via] }]),
    ),
    '@ag-ui/client': { severity: 'high', via: ['zod'] },
  },
  metadata: { vulnerabilities: { low: 1, moderate: 2 } },
});
const allow = [{ id: 'GHSA-known', package: 'zod', reviewBy: '2027-01-31' }];
const today = new Date('2026-10-25T12:00:00Z');

describe('the dependency audit gate', () => {
  it('passes when the only high advisory is allowed and within its date', () => {
    expect(
      auditProblems(
        report(advisory('GHSA-known', 'zod', 'high')),
        allow,
        today,
      ),
    ).toEqual([]);
  });

  it('fails on any other high or critical advisory, and names it', () => {
    const problems = auditProblems(
      report(
        advisory('GHSA-known', 'zod', 'high'),
        advisory('GHSA-new', 'left-pad', 'critical'),
      ),
      allow,
      today,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('critical GHSA-new in left-pad');
  });

  it('ignores low and moderate advisories', () => {
    expect(
      auditProblems(report(advisory('GHSA-x', 'tiny', 'moderate')), [], today),
    ).toEqual([]);
  });

  it('fails again once an allowed advisory is past its review date', () => {
    const problems = auditProblems(
      report(advisory('GHSA-known', 'zod', 'high')),
      allow,
      new Date('2027-02-01T00:00:00Z'),
    );
    expect(problems[0]).toContain('allowed until 2027-01-31');
  });

  it('counts each root advisory once, not once per package that depends on it', () => {
    expect(
      blockingAdvisories(report(advisory('GHSA-known', 'zod', 'high'))),
    ).toHaveLength(1);
  });

  it('allows only the known zod advisory, with a reason and a review date', () => {
    const file = JSON.parse(readFileSync('audit-allowlist.json', 'utf8'));
    expect(file.allow.map((entry: { id: string }) => entry.id)).toEqual([
      'GHSA-mrhx-c7xc-m3w5',
    ]);
    for (const entry of file.allow) {
      expect(entry.reason.length).toBeGreaterThan(40);
      expect(entry.reviewBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
