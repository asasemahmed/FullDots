import { describe, expect, it } from 'vitest';
import {
  classify,
  intentHash,
  isDestructiveCommand,
  normalizeName,
  normalizeUrl,
  pickIntentArgs,
  redactArgs,
  type ClassifyInput,
  type ElementIdentity,
} from '../src/server/approvals.js';

const destructive: [string, boolean][] = [
  ['ls -la', false],
  ['rm -rf build', true],
  ['/bin/rm -rf build', true],
  ['echo hi > out.txt', true],
  ['echo hi >| out.txt', true],
  ['echo hi >> log', false],
  ['cat a | grep b', false],
  ['ls && rm x', true],
  ['ls; rm x', true],
  ['false || rm x', true],
  ['curl https://x', false],
  ['curl -X GET https://x', false],
  ['curl -XGET https://x', false],
  ['curl -sSL -D - https://x', false],
  ['curl -X POST https://x', true],
  ['curl -XPOST https://x', true],
  ['curl -d a=1 https://x', true],
  ['curl --data-binary @f https://x', true],
  ['curl --request DELETE https://x', true],
  ['wget https://x', false],
  ['wget --post-data=a=1 https://x', true],
  ['git status', false],
  ['git push', true],
  ['git push origin main', true],
  ['sudo apt update', true],
  ['env A=1 rm x', true],
  ['env A=1 ls', false],
  ['nohup docker ps', true],
  ['time rm x', true],
  ['npm publish', true],
  ['npm test', false],
  ['mv a b', true],
  ['chmod +x f', true],
  ['cmd 2>&1', false],
  ['cmd 2>/dev/null', false],
  ['cmd > /dev/null 2>&1', false],
  ['cmd 2> err.log', true],
  ['python -c "print(1)"', false],
  ['python -c "print(1 > 0)"', false],
  ['echo "a > b"', false],
  ['kill 123', true],
  ['ssh host', true],
  ['cat file | tee out.txt', true],
  ['cat file | tee -a out.txt', false],
  ['echo $(rm x)', true],
  ['echo "$(rm x)"', true],
  ['echo "a; rm x"', false],
  ['sleep 1 & rm x', true],
  ["sh -c 'rm -rf build'", true],
  ['bash -c "git push"', true],
  ["find . -name '*.log' -delete", true],
  ['ls | xargs rm', true],
  ['eval "rm -rf x"', true],
  ["sh -c 'ls -la'", false],
  ['bash -c "echo hi"', false],
  ['find . -name x', false],
  ['xargs echo', false],
  ["/bin/bash -lc 'rm x'", true],
  ['cmd /c del x', true],
  ['cmd.exe /c "dir"', false],
  ['powershell -Command "Remove-Item x"', true],
  ['pwsh -c "Get-ChildItem"', false],
  ['powershell -EncodedCommand AAAA', true],
  ['bash -c', true],
  ['bash script.sh', false],
  ['A="1 2" sh -c \'rm x\'', true],
  ['echo "a b" && sh -c \'rm x\'', true],
  ['echo "x" | sh -c \'ls\'', false],
  ['sh -c "sh -c \\"rm x\\""', true],
  ['eval ls', false],
  ['eval $CMD', true],
  ['find . -exec rm {} \\;', true],
  ["find . -name '-delete'", false],
  ['ls | xargs -I{} rm {}', true],
  ['ls | xargs -n 1 git push', true],
  ['ls | xargs -0 cat', false],
  ["ls | xargs sh -c 'rm $0'", true],
  ['ls | xargs', false],
  ['', false],
];

describe('isDestructiveCommand', () => {
  it.each(destructive)('%j -> %s', (command, expected) => {
    expect(isDestructiveCommand(command)).toBe(expected);
  });
});

const el = (role: string, name: string): ElementIdentity => ({ role, name });

function run(
  input: ClassifyInput,
  mode: 'sensitive' | 'writes' | 'off',
): { level: string; gated: boolean } {
  const { level, gated } = classify(input, mode);
  return { level, gated };
}

describe('classify: exec, files, pages', () => {
  const rm: ClassifyInput = {
    tool: 'computer_exec',
    args: { command: 'rm -rf build' },
  };
  const ls: ClassifyInput = {
    tool: 'computer_exec',
    args: { command: 'ls' },
  };
  it('classifies exec by command', () => {
    expect(run(rm, 'sensitive')).toEqual({ level: 'sensitive', gated: true });
    expect(run(rm, 'writes')).toEqual({ level: 'sensitive', gated: true });
    expect(run(rm, 'off')).toEqual({ level: 'sensitive', gated: false });
    expect(run(ls, 'sensitive')).toEqual({ level: 'write', gated: false });
    expect(run(ls, 'writes')).toEqual({ level: 'write', gated: true });
    expect(run(ls, 'off')).toEqual({ level: 'write', gated: false });
  });
  it.each(['computer_files_write', 'create_space_page', 'edit_space_page'])(
    '%s is a write',
    (tool) => {
      const input = { tool, args: {} };
      expect(run(input, 'sensitive')).toEqual({ level: 'write', gated: false });
      expect(run(input, 'writes')).toEqual({ level: 'write', gated: true });
      expect(run(input, 'off')).toEqual({ level: 'write', gated: false });
    },
  );
  it.each([
    'computer_read',
    'computer_navigate',
    'request_approval',
    'whatever',
  ])('%s is never gated', (tool) => {
    for (const mode of ['sensitive', 'writes', 'off'] as const)
      expect(run({ tool, args: {} }, mode)).toEqual({
        level: 'none',
        gated: false,
      });
  });
  it('gives readable reasons', () => {
    expect(classify(rm, 'sensitive').reason).toBe('destructive shell command');
    expect(
      classify(
        {
          tool: 'computer_click',
          args: {},
          element: el('button', 'Send'),
        },
        'sensitive',
      ).reason,
    ).toBe('sensitive button "Send"');
    expect(
      classify(
        {
          tool: 'mcp__gh__create',
          args: {},
          mcp: { readOnly: false, destructive: false },
        },
        'writes',
      ).reason,
    ).toBe('connector tool can change data');
  });
});

describe('classify: MCP', () => {
  it('treats a connector tool with unknown annotations as sensitive', () => {
    for (const mode of ['sensitive', 'writes'] as const)
      expect(
        classify({ tool: 'mcp__github__thing', args: {} }, mode),
      ).toMatchObject({ level: 'sensitive', gated: true });
  });
  const mcp = (
    readOnly: boolean,
    destructive: boolean,
    override?: 'allow' | 'ask' | 'deny',
  ): ClassifyInput => ({
    tool: 'mcp__github__thing',
    args: {},
    mcp: { readOnly, destructive, override },
  });
  it('uses readOnly and destructive hints', () => {
    expect(run(mcp(true, false), 'writes')).toEqual({
      level: 'none',
      gated: false,
    });
    expect(run(mcp(false, false), 'sensitive')).toEqual({
      level: 'write',
      gated: false,
    });
    expect(run(mcp(false, false), 'writes')).toEqual({
      level: 'write',
      gated: true,
    });
    expect(run(mcp(false, true), 'sensitive')).toEqual({
      level: 'sensitive',
      gated: true,
    });
    expect(run(mcp(false, true), 'off')).toEqual({
      level: 'sensitive',
      gated: false,
    });
  });
  it('treats a tool without hints as a write', () => {
    expect(run({ tool: 'mcp__x__y', args: {} }, 'writes').gated).toBe(true);
  });
  it('honours overrides', () => {
    expect(run(mcp(false, true, 'allow'), 'sensitive').gated).toBe(false);
    expect(run(mcp(false, false, 'allow'), 'writes').gated).toBe(false);
    expect(run(mcp(true, false, 'ask'), 'sensitive')).toEqual({
      level: 'write',
      gated: true,
    });
    expect(run(mcp(true, false, 'ask'), 'writes').gated).toBe(true);
    expect(run(mcp(false, true, 'ask'), 'sensitive')).toEqual({
      level: 'sensitive',
      gated: true,
    });
    for (const mode of ['sensitive', 'writes', 'off'] as const)
      expect(classify(mcp(true, false, 'deny'), mode)).toEqual({
        level: 'sensitive',
        gated: true,
        reason: 'denied',
      });
  });
  it('mode off silences everything except per-tool ask and deny', () => {
    expect(run(mcp(false, true, 'ask'), 'off').gated).toBe(true);
    expect(run(mcp(true, false, 'ask'), 'off').gated).toBe(true);
    expect(run(mcp(false, true), 'off').gated).toBe(false);
  });
});

describe('classify: page interaction', () => {
  it.each(['computer_click', 'computer_select'])(
    '%s by element name',
    (tool) => {
      const on = (element?: ElementIdentity) => ({ tool, args: {}, element });
      for (const mode of ['sensitive', 'writes'] as const) {
        expect(run(on(el('button', 'Send')), mode)).toEqual({
          level: 'sensitive',
          gated: true,
        });
        expect(run(on(el('button', 'Next')), mode)).toEqual({
          level: 'none',
          gated: false,
        });
        expect(run(on(undefined), mode)).toEqual({
          level: 'sensitive',
          gated: true,
        });
      }
      expect(run(on(el('button', 'Send')), 'off').gated).toBe(false);
      expect(run(on(undefined), 'off').gated).toBe(false);
      expect(classify(on(undefined), 'sensitive').reason).toBe(
        'unknown element',
      );
    },
  );

  describe('computer_type', () => {
    const type = (
      submit: boolean | undefined,
      element: ElementIdentity | undefined,
      latestElements: ElementIdentity[] = [],
    ): ClassifyInput => ({
      tool: 'computer_type',
      args: { text: 'hello', submit },
      element,
      latestElements,
    });
    const box = el('textbox', 'Message');
    const send = el('button', 'Send message');
    it('is not gated without submit', () => {
      expect(run(type(undefined, box, [send]), 'sensitive').gated).toBe(false);
      expect(run(type(false, box, [send]), 'writes').gated).toBe(false);
    });
    it('is gated with submit when a sensitive button exists', () => {
      expect(run(type(true, box, [send]), 'sensitive')).toEqual({
        level: 'sensitive',
        gated: true,
      });
      expect(
        run(type(true, box, [el('link', 'Delete account')]), 'writes').gated,
      ).toBe(true);
      expect(
        run(type(true, box, [el('menuitem', 'Pay now')]), 'sensitive').gated,
      ).toBe(true);
    });
    it('is gated with submit when the field itself is sensitive', () => {
      expect(
        run(type(true, el('textbox', 'Confirm email')), 'sensitive').gated,
      ).toBe(true);
    });
    it('is not gated with submit when nothing sensitive is around', () => {
      const search = el('searchbox', 'Search');
      expect(
        run(
          type(true, search, [el('button', 'Go'), el('textbox', 'Send to')]),
          'sensitive',
        ).gated,
      ).toBe(false);
      expect(run(type(true, search), 'writes').gated).toBe(false);
    });
    it('is gated with submit into an unknown element', () => {
      expect(run(type(true, undefined), 'sensitive').gated).toBe(true);
    });
    it('is never gated in mode off', () => {
      expect(run(type(true, box, [send]), 'off').gated).toBe(false);
    });
  });

  describe('computer_key', () => {
    const key = (
      k: string,
      focus?: ElementIdentity,
      latestElements: ElementIdentity[] = [],
    ): ClassifyInput => ({
      tool: 'computer_key',
      args: { key: k },
      focus,
      latestElements,
    });
    it('Enter without known focus is sensitive', () => {
      expect(run(key('Enter'), 'sensitive')).toEqual({
        level: 'sensitive',
        gated: true,
      });
      expect(run(key('Return'), 'sensitive').gated).toBe(true);
      expect(run(key('NumpadEnter'), 'sensitive').gated).toBe(true);
    });
    it('Enter in a "Message" field with a Send button is sensitive', () => {
      expect(
        run(
          key('Enter', el('textbox', 'Message'), [el('button', 'Send')]),
          'sensitive',
        ),
      ).toEqual({ level: 'sensitive', gated: true });
    });
    it('Enter in a sensitive-named field is sensitive', () => {
      expect(
        run(key('Enter', el('textbox', 'Confirm password')), 'sensitive').gated,
      ).toBe(true);
    });
    it('Enter in "Search" with no sensitive button is not gated', () => {
      expect(
        run(
          key('enter', el('searchbox', 'Search'), [el('button', 'Go')]),
          'sensitive',
        ),
      ).toEqual({ level: 'none', gated: false });
    });
    it('Enter in writes mode is a gated write', () => {
      expect(run(key('Enter', el('searchbox', 'Search')), 'writes')).toEqual({
        level: 'write',
        gated: true,
      });
      expect(run(key('Enter'), 'writes')).toEqual({
        level: 'write',
        gated: true,
      });
    });
    it('Ctrl+Enter counts as Enter', () => {
      expect(run(key('Control+Enter'), 'sensitive').gated).toBe(true);
    });
    it('other keys and mode off are not gated', () => {
      expect(run(key('Tab'), 'writes').gated).toBe(false);
      expect(run(key('Escape'), 'sensitive').gated).toBe(false);
      expect(run(key('Enter'), 'off').gated).toBe(false);
    });
  });
});

describe('intentHash', () => {
  const base = {
    tool: 'computer_type',
    url: 'https://example.com/form',
    element: el('textbox', 'Message'),
    args: { ref: 'e1', snapshotId: 1, text: 'hello', submit: true },
  };
  it('ignores ref and snapshotId for computer ref actions', () => {
    const other = {
      ...base,
      args: { ...base.args, ref: 'e9', snapshotId: 42 },
    };
    expect(intentHash(other)).toBe(intentHash(base));
    expect(
      intentHash({ ...base, args: pickIntentArgs(base.tool, base.args) }),
    ).toBe(intentHash(base));
  });
  it('ignores query strings, fragments and trailing slash in the URL', () => {
    const hash = (url: string) => intentHash({ ...base, url });
    expect(hash('https://example.com/form?a=1#top')).toBe(
      hash('https://example.com/form'),
    );
    expect(hash('https://example.com/form/')).toBe(
      hash('https://example.com/form'),
    );
    expect(hash('https://example.com/other')).not.toBe(
      hash('https://example.com/form'),
    );
    expect(hash('https://other.com/form')).not.toBe(
      hash('https://example.com/form'),
    );
  });
  it('ignores whitespace and case in the element name', () => {
    expect(intentHash({ ...base, element: el('textbox', '  MESSAGE ') })).toBe(
      intentHash(base),
    );
    expect(
      intentHash({ ...base, element: el('textbox', 'Mes   sage') }),
    ).not.toBe(intentHash(base));
  });
  it('changes with text, submit, role and tool', () => {
    const hash = (patch: object) => intentHash({ ...base, ...patch });
    expect(hash({ args: { ...base.args, text: 'bye' } })).not.toBe(
      intentHash(base),
    );
    expect(hash({ args: { ...base.args, submit: false } })).not.toBe(
      intentHash(base),
    );
    expect(hash({ element: el('button', 'Message') })).not.toBe(
      intentHash(base),
    );
    expect(hash({ tool: 'computer_select' })).not.toBe(intentHash(base));
  });
  it('is independent of key order and drops undefined', () => {
    const a = intentHash({
      tool: 'mcp__x__y',
      args: { b: 1, a: { d: 1, c: [1, { z: 1, y: 2 }] } },
    });
    const b = intentHash({
      tool: 'mcp__x__y',
      args: { a: { c: [1, { y: 2, z: 1 }], d: 1 }, b: 1, gone: undefined },
    });
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(intentHash({ tool: 'x', args: {}, url: undefined })).toBe(
      intentHash({ tool: 'x', args: {} }),
    );
  });
  it('uses the exec command and the files path as the intent', () => {
    const exec = (command: string) =>
      intentHash({ tool: 'computer_exec', args: { command, timeoutMs: 1000 } });
    expect(exec('ls')).toBe(exec('ls'));
    expect(exec('ls')).not.toBe(exec('ls -a'));
    const write = (path: string) =>
      intentHash({
        tool: 'computer_files_write',
        args: { path, contents: 'x' },
      });
    expect(write('a.txt')).not.toBe(write('b.txt'));
  });
  it('pickIntentArgs keeps only the approved fields for ref actions', () => {
    expect(
      pickIntentArgs('computer_click', { ref: 'e1', snapshotId: 3 }),
    ).toEqual({});
    expect(
      pickIntentArgs('computer_select', {
        ref: 'e1',
        snapshotId: 3,
        option: 'A',
      }),
    ).toEqual({ option: 'A' });
    expect(pickIntentArgs('computer_key', { key: 'Enter' })).toEqual({
      key: 'Enter',
    });
    const exec = { command: 'ls' };
    expect(pickIntentArgs('computer_exec', exec)).toBe(exec);
  });
});

describe('normalizeUrl and normalizeName', () => {
  it('normalizes URLs', () => {
    expect(normalizeUrl('https://a.com/x/?q=1#h')).toBe('https://a.com/x');
    expect(normalizeUrl('https://a.com')).toBe('https://a.com/');
    expect(normalizeUrl('https://a.com/')).toBe('https://a.com/');
    expect(normalizeUrl(undefined)).toBe('');
    expect(normalizeUrl(' Not A URL ')).toBe('not a url');
  });
  it('normalizes names', () => {
    expect(normalizeName('  Send \n  Message ')).toBe('send message');
  });
});

describe('redactArgs', () => {
  it('shows the exec command verbatim with the timeout', () => {
    expect(
      redactArgs('computer_exec', { command: 'rm -rf build', timeoutMs: 5000 }),
    ).toBe('rm -rf build (timeout 5000 ms)');
    expect(redactArgs('computer_exec', { command: 'ls' })).toBe('ls');
  });
  it('hides text typed into sensitive fields', () => {
    expect(
      redactArgs(
        'computer_type',
        { text: 'hunter2', submit: true },
        el('textbox', 'Password'),
      ),
    ).toBe('type "[hidden]" into textbox "Password" and press Enter');
    expect(
      redactArgs('computer_type', { text: 'hello' }, el('textbox', 'Message')),
    ).toBe('type "hello" into textbox "Message"');
    expect(redactArgs('computer_type', { text: 'hunter2' })).not.toContain(
      'hunter2',
    );
  });
  it('describes clicks, selects and keys', () => {
    expect(redactArgs('computer_click', {}, el('button', 'Send'))).toBe(
      'click button "Send"',
    );
    expect(
      redactArgs(
        'computer_select',
        { option: 'Blue' },
        el('combobox', 'Colour'),
      ),
    ).toBe('choose "Blue" in combobox "Colour"');
    expect(redactArgs('computer_key', { key: 'Enter' })).toBe(
      'press Enter (focus unknown)',
    );
    expect(
      redactArgs(
        'computer_key',
        { key: 'Enter' },
        undefined,
        el('textbox', 'Search'),
      ),
    ).toBe('press Enter in textbox "Search"');
  });
  it('masks secret-named keys in MCP args, including nested ones', () => {
    const text = redactArgs('mcp__gh__call', {
      title: 'hi',
      token: 'ghp_secretvalue',
      nested: {
        Authorization: 'Bearer abc',
        list: [{ password: 'pw', ok: 1 }],
      },
      apiKey: 'k',
    });
    expect(text).toContain('mcp__gh__call');
    expect(text).toContain('"title":"hi"');
    expect(text).toContain('"token":"[hidden]"');
    expect(text).toContain('"Authorization":"[hidden]"');
    expect(text).toContain('"apiKey":"[hidden]"');
    expect(text).toContain('"ok":1');
    for (const secret of ['ghp_secretvalue', 'Bearer abc', '"pw"'])
      expect(text).not.toContain(secret);
  });
  it('clips to 2000 characters', () => {
    const long = redactArgs('computer_files_write', {
      path: 'a',
      contents: 'x'.repeat(5000),
    });
    expect(Array.from(long)).toHaveLength(2000);
    expect(long.endsWith('…')).toBe(true);
    expect(
      Array.from(redactArgs('computer_exec', { command: 'y'.repeat(9000) })),
    ).toHaveLength(2000);
  });
});
