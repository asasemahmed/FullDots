import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) =>
  readFileSync(new URL(`../${path}`, import.meta.url), 'utf8').replace(
    /\r\n/g,
    '\n',
  );

/** The lines nested under `key:` at the given indent, up to the next key at that indent or less. */
function block(text: string, key: string, indent = 0): string {
  const lines = text.split('\n');
  const start = lines.indexOf(`${' '.repeat(indent)}${key}:`);
  if (start < 0) throw new Error(`${key} not found`);
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const depth = line.length - line.trimStart().length;
    if (line.trim() && !line.trim().startsWith('#') && depth <= indent) break;
    body.push(line);
  }
  return body.join('\n');
}

const workflow = read('.github/workflows/release-images.yml');
const job = block(block(workflow, 'jobs'), 'publish', 2);

describe('Release images workflow', () => {
  it('runs only for published releases and manual runs of a tag', () => {
    const on = block(workflow, 'on');
    expect(on).toMatch(/^ {2}release:\n {4}types: \[published\]$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(block(block(on, 'workflow_dispatch', 2), 'tag', 6)).toContain(
      'required: true',
    );
    const triggers = on.match(/^ {2}[a-z_]+:/gm);
    expect(triggers).toEqual(['  release:', '  workflow_dispatch:']);
    expect(on).not.toMatch(/push|pull_request/);
    expect(workflow).not.toContain('pull_request');
  });

  it('grants nothing at the top and only what publishing needs in the job', () => {
    expect(workflow).toMatch(/^permissions: \{\}$/m);
    const permissions = block(job, 'permissions', 4)
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .sort();
    expect(permissions).toEqual([
      'attestations: write',
      'contents: read',
      'id-token: write',
      'packages: write',
    ]);
    expect(workflow.match(/packages: write/g)).toHaveLength(1);
    // GITHUB_TOKEN is the only credential.
    expect(workflow.match(/secrets\.[A-Za-z_]+/g)).toEqual([
      'secrets.GITHUB_TOKEN',
    ]);
  });

  it('builds both targets for amd64 and arm64 from the tag itself', () => {
    expect(job).toMatch(/- target: app\n/);
    expect(job).toMatch(/- target: browser\n/);
    expect(job).toContain('target: ${{ matrix.target }}');
    expect(job).toContain('platforms: linux/amd64,linux/arm64');
    expect(job).toContain('uses: docker/setup-qemu-action@');
    expect(job).toContain('push: true');
    expect(job).toContain('ref: refs/tags/${{ steps.release.outputs.tag }}');
    // Lower case, so a fork publishes to its own namespace with a valid name.
    expect(job).toContain('image=ghcr.io/${GITHUB_REPOSITORY,,}${SUFFIX}');
  });

  it('pins every action to a major version, like the other workflows', () => {
    const uses = workflow.match(/uses: \S+/g)!;
    expect(uses.length).toBeGreaterThan(5);
    for (const line of uses) expect(line).toMatch(/@v\d+$/);
  });

  it('refuses anything but a v-prefixed release tag', () => {
    const pattern = workflow.match(/=~ (\^v\S+\$) \]\]/)?.[1];
    expect(pattern).toBeDefined();
    const tag = new RegExp(pattern!);
    for (const ok of ['v2.0.0', 'v2.1.0-rc.1', 'v10.20.30'])
      expect(tag.test(ok)).toBe(true);
    for (const bad of [
      'main',
      '2.0.0',
      'v2',
      'v2.0',
      'refs/tags/v2.0.0',
      'v2.0.0 ',
      'v2.0.0;id',
      'v2.0.0-rc.1/x',
    ])
      expect(tag.test(bad)).toBe(false);
  });

  it('tags the version, the minor line and latest only for stable releases', () => {
    expect(job).toContain('flavor: latest=false');
    expect(job).toContain('type=semver,pattern={{version}}');
    expect(job).toMatch(
      /type=semver,pattern=\{\{major\}\}\.\{\{minor\}\},.*enable=\$\{\{ steps\.release\.outputs\.stable \}\}/,
    );
    expect(job).toContain(
      'type=raw,value=latest,enable=${{ steps.release.outputs.latest }}',
    );
    expect(job).toContain(
      'stable=true\n          if [[ "$version" == *-* || "$GITHUB_PRERELEASE" == true ]]; then stable=false; fi',
    );
    for (const label of ['source', 'revision', 'version', 'licenses'])
      expect(job).toContain(`org.opencontainers.image.${label}=`);
  });
});

describe('Compose images', () => {
  const services = (file: string) => block(read(file), 'services');
  for (const file of ['compose.yml', 'compose.dokploy.yml']) {
    it(`${file} names the local build by default and keeps build`, () => {
      const app = block(services(file), 'app', 2);
      const browser = block(services(file), 'browser', 2);
      expect(app).toContain('    image: ${FULLDOTS_IMAGE:-fulldots:local}');
      expect(app).toMatch(/ {4}build:\n {6}context: \.\n {6}target: app\n/);
      expect(browser).toContain(
        '    image: ${FULLDOTS_BROWSER_IMAGE:-fulldots-browser:local}',
      );
      expect(browser).toMatch(
        / {4}build:\n {6}context: \.\n {6}target: browser\n/,
      );
    });
  }

  it('documents both variables in .env.example', () => {
    const env = read('.env.example');
    expect(env).toContain(
      '# FULLDOTS_IMAGE=ghcr.io/asasemahmed/fulldots:<version>',
    );
    expect(env).toContain(
      '# FULLDOTS_BROWSER_IMAGE=ghcr.io/asasemahmed/fulldots-browser:<version>',
    );
  });
});
