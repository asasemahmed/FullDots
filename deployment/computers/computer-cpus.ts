// Added to the pinned OpenBot supervisor at build time (see harden-supervisor.mjs
// and supervisor.Dockerfile). It mirrors upstream's computer-memory-bytes.ts: a
// bad value stops the supervisor at startup with a clear message instead of
// failing later on the first container create.

export const DEFAULT_COMPUTER_CPUS = 2;
export const MAX_COMPUTER_CPUS = 64;
// The smallest limit Docker accepts (0.01 CPU).
export const MIN_COMPUTER_CPUS = 0.01;

export type ComputerCpus =
  | { ok: true; cpus: number; nanoCpus: number | undefined; note?: string }
  | { ok: false; reason: string };

/**
 * `COMPUTER_CPUS` is a decimal number of CPUs for each computer. Unset or blank
 * means the default of 2, and 0 means no limit. `hostCpus` is the CPU count of
 * the machine running Docker: Docker refuses to create a container that asks for
 * more CPUs than the host has, so a larger value is lowered to the host count
 * (and reported in `note`) rather than breaking every computer.
 */
export function computerCpus(
  raw: string | undefined,
  hostCpus?: number,
): ComputerCpus {
  const trimmed = raw?.trim();
  const fail = (): ComputerCpus => ({
    ok: false,
    reason: `COMPUTER_CPUS must be a number of CPUs from ${MIN_COMPUTER_CPUS} to ${MAX_COMPUTER_CPUS}, or 0 for no limit (got ${JSON.stringify(raw)}).`,
  });
  // Digits with an optional fraction only. Number() would also accept "1e1",
  // "0x10", "Infinity" and a bare "" (as 0).
  if (trimmed && !/^\d{1,3}(\.\d{1,9})?$/.test(trimmed)) return fail();
  const requested = trimmed ? Number(trimmed) : DEFAULT_COMPUTER_CPUS;
  if (requested > MAX_COMPUTER_CPUS) return fail();
  if (requested === 0) return { ok: true, cpus: 0, nanoCpus: undefined };
  if (requested < MIN_COMPUTER_CPUS) return fail();
  if (hostCpus && hostCpus >= 1 && requested > hostCpus) {
    return {
      ok: true,
      cpus: hostCpus,
      nanoCpus: Math.round(hostCpus * 1e9),
      note: `COMPUTER_CPUS is ${requested} but Docker's host has ${hostCpus} CPUs; limiting each computer to ${hostCpus}.`,
    };
  }
  return {
    ok: true,
    cpus: requested,
    nanoCpus: Math.round(requested * 1e9),
  };
}
