import { validateConnectorConfig } from '../shared/connector-config';
import type { RegistryServer } from '../shared/registry';
// Type-only: importing the sheet's values here would make a cycle through ConnectorGallery.
import type { ConnectorDraft, ValueRow } from './ConnectorSheet';

export const CONNECTORS_DOCS_URL =
  'https://github.com/asasemahmed/FullDots/blob/main/docs/CONNECTORS.md';
export const LOCAL_PROGRAMS_DOCS_URL = `${CONNECTORS_DOCS_URL}#local-programs-stdio-and-host-trust`;

/**
 * What "Add" on a Discover result does. Nothing here saves, connects or runs
 * anything: a draft only opens the connector form, and Save is the owner's choice.
 */
export type RegistryAdd =
  | { kind: 'draft'; draft: ConnectorDraft }
  | { kind: 'local-off'; reason: string }
  | { kind: 'unsupported'; reason: string };

// A concrete version such as 1.2.3 or 1.2.3-beta.1: no "latest", no wildcards like 1.x, no ranges.
const PINNED_VERSION = /^\d+(\.\d+)*([-+][0-9A-Za-z.+_-]*)?$/;
// A package name that cannot start with a dash, so it cannot be read as a flag.
const PACKAGE_NAME = /^[A-Za-z0-9@][A-Za-z0-9@._/-]*$/;

const unsupported = (reason: string): RegistryAdd => ({
  kind: 'unsupported',
  reason,
});

/** A connector name from the title, else the last part of the registry name, within the form's rules. */
export function connectorNameFor(server: RegistryServer): string {
  const base = server.title || server.name.split('/').pop() || server.name;
  const cleaned = base
    .replace(/[^A-Za-z0-9 _-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[^A-Za-z0-9]+/, '')
    .slice(0, 40)
    .replace(/[ _-]+$/, '');
  return cleaned || 'Registry server';
}

/** The command a local program connector runs, as the form shows it. */
export function draftCommandLine(
  draft: Pick<ConnectorDraft, 'command' | 'args'>,
): string {
  return [
    draft.command.trim(),
    ...draft.args
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  ].join(' ');
}

function remotePlan(name: string, url: string): RegistryAdd {
  if (url.includes('{'))
    return unsupported(
      'This address has a placeholder in braces that needs a value. Add it by hand with Custom connector.',
    );
  // The same rules the connector route applies to a URL on save.
  const { errors } = validateConnectorConfig(
    { name, transport: 'http', url },
    { allowStdio: false },
  );
  const problem = errors.find((error) => error.startsWith('url'));
  if (problem)
    return unsupported(
      `This address is refused: ${problem.replace(/^url: /, '')}.`,
    );
  return {
    kind: 'draft',
    draft: {
      name,
      transport: 'http',
      url,
      command: '',
      args: '',
      cwd: '',
      rows: [],
    },
  };
}

function packagePlan(
  name: string,
  pkg: RegistryServer['packages'][number],
  allowStdio: boolean,
): RegistryAdd {
  if (pkg.registryType !== 'npm' && pkg.registryType !== 'pypi')
    return unsupported(
      `Packages from ${pkg.registryType} cannot be added from here yet. Only npm and PyPI packages can.`,
    );
  if (pkg.transport !== 'stdio')
    return unsupported(
      `This package runs its own ${pkg.transport} server. Only programs that talk over stdio can be added from here yet.`,
    );
  if (!pkg.identifier || !pkg.version || !PINNED_VERSION.test(pkg.version))
    return unsupported(
      'The registry does not give a fixed version for this package, so it cannot be pinned. Add it by hand with Custom connector.',
    );
  // The identifier is passed as an argument; a leading dash would read as a flag to npx or uvx.
  if (!PACKAGE_NAME.test(pkg.identifier))
    return unsupported(
      'The package name from the registry is not in a form FullDots can run. Add it by hand with Custom connector.',
    );
  if (!allowStdio)
    return {
      kind: 'local-off',
      reason:
        'Local programs are off on this server. Set CONNECTORS_ALLOW_STDIO=true to allow this one.',
    };
  const npm = pkg.registryType === 'npm';
  const rows: ValueRow[] = pkg.envNames.map((envName) => ({
    name: envName,
    kind: 'env',
    value: '',
  }));
  return {
    kind: 'draft',
    draft: {
      name,
      transport: 'stdio',
      url: '',
      command: npm ? 'npx' : 'uvx',
      args: npm
        ? `-y\n${pkg.identifier}@${pkg.version}`
        : `${pkg.identifier}==${pkg.version}`,
      cwd: '',
      rows,
      auth: 'none',
    },
  };
}

/** Works out what Add does for a registry entry. Prefers a hosted endpoint over a local package. */
export function registryAddPlan(
  server: RegistryServer,
  allowStdio: boolean,
): RegistryAdd {
  const name = connectorNameFor(server);
  const remote = server.remotes.find(
    (item) => item.type === 'streamable-http' || item.type === 'sse',
  );
  if (remote) return remotePlan(name, remote.url);
  if (server.packages.length) {
    const pkg =
      server.packages.find(
        (item) => item.registryType === 'npm' || item.registryType === 'pypi',
      ) ?? server.packages[0]!;
    return packagePlan(name, pkg, allowStdio);
  }
  return unsupported(
    'The registry lists no hosted address or package for this server, so FullDots cannot connect to it.',
  );
}
