// The CI dependency audit: fails on any high or critical advisory, except the ones listed in
// audit-allowlist.json with a reason and a review-by date. An entry past its date fails again,
// so an exception is looked at again instead of living forever.
//
//   node scripts/audit.mjs            # runs `npm audit --json` and checks it
//   node scripts/audit.mjs report.json  # checks a saved report instead
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const BLOCKING = new Set(['high', 'critical']);

/** The advisory id (GHSA-...) from an advisory URL, else the URL itself. */
const advisoryId = (url) => String(url).split('/').pop();

/**
 * Root advisories of high or critical severity in an `npm audit --json` (v2) report.
 * Packages that are only vulnerable through a dependency point at the same roots.
 */
export function blockingAdvisories(report) {
  const found = new Map();
  for (const [name, entry] of Object.entries(report.vulnerabilities ?? {}))
    for (const via of entry.via ?? [])
      if (typeof via === 'object' && BLOCKING.has(via.severity)) {
        const id = advisoryId(via.url);
        const known = found.get(id) ?? {
          id,
          title: via.title,
          severity: via.severity,
          packages: new Set(),
        };
        known.packages.add(via.name ?? name);
        found.set(id, known);
      }
  return [...found.values()].map((item) => ({
    ...item,
    packages: [...item.packages].sort(),
  }));
}

/** What fails the audit: advisories not allowed, or allowed past their review date. */
export function auditProblems(report, allowlist, today = new Date()) {
  const day = today.toISOString().slice(0, 10);
  const problems = [];
  for (const advisory of blockingAdvisories(report)) {
    const allowed = allowlist.find((entry) => entry.id === advisory.id);
    const where = `${advisory.packages.join(', ')}: ${advisory.title}`;
    if (!allowed)
      problems.push(`${advisory.severity} ${advisory.id} in ${where}`);
    else if (allowed.reviewBy < day)
      problems.push(
        `${advisory.id} was allowed until ${allowed.reviewBy}; review it again (${where})`,
      );
  }
  return problems;
}

function main() {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const allowlist = JSON.parse(
    readFileSync(new URL('../audit-allowlist.json', import.meta.url), 'utf8'),
  ).allow;
  let raw;
  if (process.argv[2]) raw = readFileSync(process.argv[2], 'utf8');
  else
    try {
      // Under `npm run`, npm names its own CLI; calling it through node avoids a shell on Windows.
      const npmCli = process.env.npm_execpath;
      raw = execFileSync(
        npmCli ? process.execPath : 'npm',
        [...(npmCli ? [npmCli] : []), 'audit', '--json'],
        { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
      );
    } catch (error) {
      // npm audit exits non-zero whenever it finds anything; the report is still on stdout.
      raw = error.stdout;
    }
  if (!raw) {
    console.error('npm audit gave no report.');
    process.exit(2);
  }
  const report = JSON.parse(raw);
  if (report.error) {
    console.error(
      `npm audit failed: ${report.error.summary ?? report.error.code}`,
    );
    process.exit(2);
  }
  const problems = auditProblems(report, allowlist);
  const allowed = blockingAdvisories(report).filter((advisory) =>
    allowlist.some((entry) => entry.id === advisory.id),
  );
  for (const advisory of allowed)
    console.log(
      `allowed: ${advisory.id} (${advisory.packages.join(', ')}), see audit-allowlist.json`,
    );
  if (problems.length) {
    console.error('High or critical advisories:');
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  const counts = report.metadata?.vulnerabilities ?? {};
  console.log(
    `No new high or critical advisories (low ${counts.low ?? 0}, moderate ${counts.moderate ?? 0}).`,
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main();
