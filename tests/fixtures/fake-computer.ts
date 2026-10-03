// A stand-in for the OpenBot computer's HTTP API with the rules that matter to an agent: refs belong
// to the latest snapshot, a navigation or a handback invalidates them, and nothing may act while the
// owner holds the wheel. It answers like the real one (see agent-computer/src/index.ts), so tests
// exercise the same 409 shapes without a browser.
import { ComputerService } from '../../src/server/computer-service.js';
import { WorkspaceStore } from '../../src/server/workspace.js';

export interface FakeElement {
  ref: string;
  role: string;
  name: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  /** A native control: it cannot be filled with text. */
  native?: boolean;
}
export interface FakePage {
  title: string;
  elements: FakeElement[];
}

export class FakeComputer {
  snapshotId = 0;
  holder: 'bot' | 'human' = 'bot';
  resumeSnapshotRequired = false;
  url = 'about:blank';
  title = '';
  elements: FakeElement[] = [];
  /** Pages by URL for navigate. */
  pages: Record<string, FakePage> = {};
  /** What reached the computer, in order, as `action` or `action:detail`. */
  calls: string[] = [];
  bodies: Record<string, unknown[]> = {};
  onClick?: (ref: string, computer: FakeComputer) => void;
  onType?: (ref: string, text: string, computer: FakeComputer) => void;
  onKey?: (key: string, computer: FakeComputer) => void;
  /** A snapshot does not clear the handback flag (a computer that keeps asking). */
  stickyResume = false;
  /** Refs whose click fails with HTTP 502, like an option of a native select. */
  clickFails = new Set<string>();
  /** The next N snapshot calls fail with HTTP 502. */
  failSnapshots = 0;
  /** The next N actions fail with HTTP 502. */
  failActions = 0;

  private count(path: string, body: unknown) {
    this.calls.push(path);
    (this.bodies[path] ??= []).push(body);
  }
  count_of = (path: string) =>
    this.calls.filter((call) => call === path).length;

  show(page: FakePage) {
    this.title = page.title;
    this.elements = page.elements.map((element) => ({ ...element }));
  }
  private gate(mutates: boolean): Response | undefined {
    if (this.holder === 'human')
      return Response.json(
        {
          error:
            'A person has control or has been asked to take control. Wait for them to hand it back before acting.',
          humanHasControl: true,
        },
        { status: 409 },
      );
    if (mutates && this.resumeSnapshotRequired)
      return Response.json(
        {
          error: 'Take a fresh browser snapshot after handback before acting.',
          stale: true,
          snapshotRequired: true,
        },
        { status: 409 },
      );
    return undefined;
  }
  private stale(body: { ref?: string; snapshotId?: number }) {
    if (body.snapshotId !== this.snapshotId)
      return Response.json(
        { error: `That list of elements is out of date.`, stale: true },
        { status: 409 },
      );
    if (!this.elements.some((element) => element.ref === body.ref))
      return Response.json(
        { error: `Nothing on this page has the ref ${body.ref}.`, stale: true },
        { status: 409 },
      );
    return undefined;
  }

  handle = async (url: string, init?: RequestInit): Promise<Response> => {
    const path = new URL(url).pathname;
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : {};
    this.count(path.slice(1), body);
    const ref = typeof body.ref === 'string' ? body.ref : undefined;
    const typed = body as { ref?: string; snapshotId?: number };
    const acting = ['/navigate', '/click', '/type', '/key', '/scroll'];
    if (acting.includes(path) || path === '/exec' || path === '/files/write') {
      const refused = this.gate(acting.includes(path));
      if (refused) return refused;
      if (this.failActions > 0) {
        this.failActions -= 1;
        return Response.json({ error: 'The action failed.' }, { status: 502 });
      }
    }
    switch (path) {
      case '/snapshot': {
        if (this.failSnapshots > 0) {
          this.failSnapshots -= 1;
          return Response.json({ error: 'Snapshot failed.' }, { status: 502 });
        }
        this.snapshotId += 1;
        if (this.holder === 'bot' && !this.stickyResume)
          this.resumeSnapshotRequired = false;
        return Response.json({
          snapshotId: this.snapshotId,
          url: this.url,
          title: this.title,
          elements: this.elements.map(
            // eslint-disable-next-line @typescript-eslint/no-unused-vars
            ({ native, ...element }) => element,
          ),
          truncated: false,
        });
      }
      case '/navigate': {
        const target = String(body.url);
        const page = this.pages[target] ?? { title: 'Page', elements: [] };
        this.url = target;
        this.show(page);
        this.snapshotId += 1;
        return Response.json({
          url: this.url,
          title: this.title,
          text: 'Page text',
          truncated: false,
          elapsedMs: 5,
        });
      }
      case '/click': {
        const refused = this.stale(typed);
        if (refused) return refused;
        if (this.clickFails.has(ref!))
          return Response.json(
            { error: 'Element is not visible.' },
            { status: 502 },
          );
        this.onClick?.(ref!, this);
        return Response.json({
          action: 'click',
          ref,
          url: this.url,
          elapsedMs: 1,
        });
      }
      case '/type': {
        const refused = this.stale(typed);
        if (refused) return refused;
        const element = this.elements.find((item) => item.ref === ref)!;
        if (
          element.native ||
          !['textbox', 'searchbox', 'combobox'].includes(element.role)
        )
          return Response.json(
            {
              error:
                'Element is not an <input>, <textarea> or [contenteditable].',
            },
            { status: 502 },
          );
        element.value = String(body.text);
        this.onType?.(ref!, String(body.text), this);
        return Response.json({
          action: 'type',
          ref,
          characters: String(body.text).length,
          submitted: body.submit === true,
          url: this.url,
        });
      }
      case '/key':
        this.onKey?.(String(body.key), this);
        return Response.json({ action: 'key', key: body.key, url: this.url });
      case '/scroll':
        return Response.json({
          action: 'scroll',
          deltaY: body.deltaY,
          url: this.url,
        });
      case '/read':
        return Response.json({
          url: this.url,
          title: this.title,
          text: 'Page text',
          truncated: false,
        });
      case '/screenshot':
        return Response.json({
          base64: 'iVBORw0KGgo'.repeat(6000),
          width: 1280,
          height: 800,
          capturedAt: '2026-01-01T00:00:00.000Z',
          url: this.url,
        });
      case '/files/read':
        return Response.json({
          path: 'a.txt',
          text: 'hello',
          truncated: false,
        });
      case '/exec':
        return Response.json({
          stdout: 'ok',
          stderr: '',
          exitCode: 0,
          command: 'secret',
        });
    }
    return Response.json({ error: 'Not found.' }, { status: 404 });
  };
}

/** The supervisor and the computer behind one fetch, as ComputerService sees them. */
export function fakeTransport(fake: FakeComputer, id: string): typeof fetch {
  return async (input, init) => {
    const url = String(input);
    if (url.endsWith('/computers'))
      return Response.json({
        computers: [
          {
            botId: id,
            container: `opendots-computer-${id}`,
            status: 'running',
          },
        ],
      });
    return fake.handle(url, init);
  };
}

export function computerFixture() {
  const workspace = new WorkspaceStore(':memory:', 'owner');
  const id = workspace.dots()[0].id;
  const fake = new FakeComputer();
  const config = {
    baseUrl: 'https://example.com',
    voiceName: 'voice',
    slackUsers: [],
    runtimeUrl: 'http://localhost',
    computerSupervisorUrl: 'http://127.0.0.1:4312',
    computerSupervisorToken: 'supervisor-secret',
    computerToken: 'master-secret',
  };
  const transport = fakeTransport(fake, id);
  const service = new ComputerService(
    workspace,
    config,
    () => false,
    transport,
  );
  workspace.computers.patch(id, {
    enabled: true,
    browser: true,
    files: true,
    shell: true,
  });
  return { workspace, id, service, fake, config, transport };
}

export const page = (title: string, elements: FakeElement[]): FakePage => ({
  title,
  elements,
});
