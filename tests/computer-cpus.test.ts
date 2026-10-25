import { describe, expect, it } from 'vitest';
import {
  computerCpus,
  DEFAULT_COMPUTER_CPUS,
} from '../deployment/computers/computer-cpus';

describe('COMPUTER_CPUS', () => {
  it('defaults to 2 CPUs when unset or blank', () => {
    for (const raw of [undefined, '', '   ']) {
      expect(computerCpus(raw, 16)).toEqual({
        ok: true,
        cpus: DEFAULT_COMPUTER_CPUS,
        nanoCpus: 2_000_000_000,
      });
    }
  });

  it('turns a decimal number of CPUs into billionths of a CPU', () => {
    expect(computerCpus('1', 16)).toMatchObject({ nanoCpus: 1_000_000_000 });
    expect(computerCpus('0.5', 16)).toMatchObject({ nanoCpus: 500_000_000 });
    expect(computerCpus(' 1.5 ', 16)).toMatchObject({
      nanoCpus: 1_500_000_000,
    });
    // 0.1 * 1e9 is 100000000.00000001 in floating point; Docker needs an integer.
    expect(computerCpus('0.1', 16)).toMatchObject({ nanoCpus: 100_000_000 });
    expect(computerCpus('0.01', 16)).toMatchObject({ nanoCpus: 10_000_000 });
    expect(computerCpus('64', 64)).toMatchObject({ nanoCpus: 64_000_000_000 });
  });

  it('treats 0 as no limit', () => {
    for (const raw of ['0', '0.0', '000']) {
      expect(computerCpus(raw, 16)).toEqual({
        ok: true,
        cpus: 0,
        nanoCpus: undefined,
      });
    }
  });

  it('rejects anything else with a message that names the setting', () => {
    for (const raw of [
      '-1',
      '65',
      '64.5',
      '100',
      '1000',
      '0.001',
      '0.009',
      'abc',
      '2 cpus',
      '1e1',
      '0x10',
      'Infinity',
      'NaN',
      '1,5',
      '.5',
      '2.',
      '1.0000000001',
    ]) {
      const result = computerCpus(raw, 128);
      expect(result.ok, raw).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain('COMPUTER_CPUS');
        expect(result.reason).toContain(JSON.stringify(raw));
      }
    }
  });

  it('lowers the limit to the CPUs the host has instead of failing every container', () => {
    const result = computerCpus('4', 2);
    expect(result).toMatchObject({
      ok: true,
      cpus: 2,
      nanoCpus: 2_000_000_000,
    });
    expect(result.ok && result.note).toMatch(/4.*2 CPUs/);
    expect(computerCpus(undefined, 1)).toMatchObject({
      cpus: 1,
      nanoCpus: 1_000_000_000,
    });
    // 0 stays unlimited, and an unknown host count changes nothing.
    expect(computerCpus('0', 1)).toMatchObject({ nanoCpus: undefined });
    expect(computerCpus('8', 0)).toMatchObject({ nanoCpus: 8_000_000_000 });
    expect(computerCpus('2', 2)).not.toHaveProperty('note');
  });
});
