import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStore } from '../src/server/workspace.js';
import { pageAccess } from '../src/server/page-tools.js';
import {
  spaceFileTools,
  spaceFilesPrompt,
} from '../src/server/space-file-tools.js';
import { categoriesOf, classify } from '../src/server/approvals.js';
import type { ComputerService } from '../src/server/computer-service.js';
import { toolStepLabel } from '../src/shared/step-label.js';

const open: WorkspaceStore[] = [];
afterEach(() => open.splice(0).forEach((ws) => ws.close()));

type Execute = (input: unknown) => Promise<Record<string, unknown>>;

function setup(
  options: { computer?: Partial<ComputerService>; maxBytes?: number } = {},
) {
  const ws = new WorkspaceStore(':memory:', 'owner');
  open.push(ws);
  const dot = ws.dots()[0]!;
  ws.bindThread('thread-1', dot.id, 'Chat');
  const check = vi.fn();
  const access = pageAccess(ws, dot.spaceId, 'thread-1', check);
  const tools = Object.fromEntries(
    spaceFileTools({
      workspace: ws,
      access,
      dotId: dot.id,
      threadId: 'thread-1',
      check,
      signal: new AbortController().signal,
      maxBytes: options.maxBytes ?? 1000,
      ...(options.computer
        ? { computer: options.computer as ComputerService }
        : {}),
    }).map((tool) => [tool.name, tool.execute as unknown as Execute]),
  );
  return { ws, dot, tools, check };
}

describe('Dot tools for Space files', () => {
  it('save a file and report it without its contents', async () => {
    const { ws, dot, tools, check } = setup();
    const result = await tools.save_space_file!({
      name: 'prices.csv',
      content: 'item,price\nmilk,2\n',
    });
    expect(result).toMatchObject({
      saved: true,
      file: { name: 'prices.csv', kind: 'csv', size: 18, spaceId: dot.spaceId },
    });
    expect(JSON.stringify(result)).not.toContain('milk');
    expect((result.file as { url: string }).url).toMatch(
      /^\/#\/spaces\/.+\/files\/.+$/,
    );
    expect(check).toHaveBeenCalled();
    const stored = ws.spaceFiles.list(dot.spaceId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.sourceThreadId).toBe('thread-1');
  });

  it('say when a name was taken', async () => {
    const { tools } = setup();
    await tools.save_space_file!({ name: 'a.txt', content: 'one' });
    const second = await tools.save_space_file!({
      name: 'a.txt',
      content: 'two',
    });
    expect(second).toMatchObject({ file: { name: 'a (2).txt' } });
    expect(String(second.note)).toMatch(/a \(2\)\.txt/);
  });

  it('keep a file under a page of the Space and refuse a page from elsewhere', async () => {
    const { ws, dot, tools } = setup();
    const page = ws.pages.create(dot.spaceId, { title: 'Reports' });
    expect(
      await tools.save_space_file!({
        name: 'w41.md',
        content: '# Week 41',
        parentPageId: page.id,
      }),
    ).toMatchObject({ file: { parentId: page.id } });
    await expect(
      tools.save_space_file!({
        name: 'x.md',
        content: 'x',
        parentPageId: 'nope',
      }),
    ).rejects.toThrow(/not in this Space/);
  });

  it('refuse an oversized file with the limit in the message', async () => {
    const { tools } = setup({ maxBytes: 10 });
    await expect(
      tools.save_space_file!({ name: 'big.txt', content: 'x'.repeat(11) }),
    ).rejects.toThrow(/at most/);
  });

  it('stay inside the Spaces the Dot may use', async () => {
    const { ws, dot, tools } = setup();
    const other = ws.createSpace('Private', '');
    expect(ws.canAccessSpace(dot.id, other.id)).toBe(false);
    await expect(
      tools.save_space_file!({
        name: 'a.txt',
        content: 'x',
        spaceId: other.id,
      }),
    ).rejects.toThrow(/access/i);
    await expect(
      tools.list_space_files!({ spaceId: other.id }),
    ).rejects.toThrow(/access/i);
    expect(ws.spaceFiles.list(other.id)).toEqual([]);
  });

  it('list files and read text back, but not binary ones', async () => {
    const { ws, dot, tools } = setup({ maxBytes: 200_000 });
    const text = await tools.save_space_file!({
      name: 'big.txt',
      content: 'y'.repeat(70_000),
    });
    const png = ws.spaceFiles.create(
      dot.spaceId,
      { name: 'pic.png', data: Buffer.from([137, 80, 78, 71]) },
      { maxBytes: 1000 },
    );
    const listed = (await tools.list_space_files!({})) as unknown as {
      name: string;
    }[];
    expect(listed.map((file) => file.name).sort()).toEqual([
      'big.txt',
      'pic.png',
    ]);
    const read = await tools.read_space_file!({
      id: (text.file as { id: string }).id,
    });
    expect(read).toMatchObject({ name: 'big.txt', truncated: true });
    expect(String(read.content)).toHaveLength(60_000);
    await expect(tools.read_space_file!({ id: png.id })).rejects.toThrow(
      /not a text file/,
    );
  });

  it('read a file by its name, even when the name is passed as the id', async () => {
    const { tools } = setup();
    await tools.save_space_file!({
      name: 'Notes-Apps.csv',
      content: 'a,b\n1,2\n',
    });
    for (const input of [{ name: 'notes-apps.csv' }, { id: 'NOTES-APPS.CSV' }])
      expect(await tools.read_space_file!(input)).toMatchObject({
        name: 'Notes-Apps.csv',
        content: 'a,b\n1,2\n',
      });
  });

  it('answer a wrong guess with the files that exist, not a bare "not found"', async () => {
    const { tools } = setup();
    await tools.save_space_file!({ name: 'one.txt', content: '1' });
    await tools.save_space_file!({ name: 'two.txt', content: '2' });
    const error = await tools.read_space_file!({ name: 'missing.csv' }).catch(
      (e: Error) => e,
    );
    expect(String((error as Error).message)).toMatch(/no file "missing\.csv"/i);
    expect(String((error as Error).message)).toContain('one.txt');
    expect(String((error as Error).message)).toContain('two.txt');
    expect(String((error as Error).message)).toMatch(/list_space_files/);
    await expect(tools.read_space_file!({})).rejects.toThrow(/name or its id/);
  });

  it('tell the Dot not to link a file the owner already has a card for', async () => {
    const { tools } = setup();
    const result = await tools.save_space_file!({
      name: 'a.txt',
      content: 'x',
    });
    expect(String(result.note)).toMatch(/card/);
    expect(String(result.note)).toMatch(/Do not add a link/);
  });

  it('copy a text file out of the computer and refuse what it cannot', async () => {
    const action = vi.fn(
      async (_id: string, _a: string, input: { path: string }) =>
        input.path === 'big.txt'
          ? { text: 'x', truncated: true }
          : { text: 'a,b\n1,2\n', truncated: false },
    );
    const { ws, dot, tools } = setup({
      computer: { action } as unknown as Partial<ComputerService>,
    });
    const done = await tools.copy_computer_file_to_space!({
      path: 'out/results.csv',
    });
    expect(done).toMatchObject({
      saved: true,
      file: { name: 'results.csv', kind: 'csv' },
    });
    expect(action).toHaveBeenCalledWith(
      dot.id,
      'files_read',
      { path: 'out/results.csv' },
      'agent',
      expect.anything(),
    );
    expect(ws.spaceFiles.list(dot.spaceId)).toHaveLength(1);
    await expect(
      tools.copy_computer_file_to_space!({ path: 'big.txt' }),
    ).rejects.toThrow(/larger than/);
    action.mockClear();
    await expect(
      tools.copy_computer_file_to_space!({ path: 'photo.png' }),
    ).rejects.toThrow(/Binary/);
    expect(action).not.toHaveBeenCalled();
  });

  it('offer the copy tool only when the Dot has a computer', () => {
    expect(setup().tools.copy_computer_file_to_space).toBeUndefined();
  });
});

describe('approvals and wording', () => {
  it('ask before saving, as writing a file, and honour a "never" rule', () => {
    const save = { tool: 'save_space_file', args: { name: 'a.csv' } };
    expect(classify(save, 'writes').gated).toBe(true);
    expect(classify(save, 'sensitive').gated).toBe(false);
    expect(categoriesOf(save)).toEqual(['write_files']);
    expect(classify(save, 'off', { write_files: 'never' }).denied).toBe(true);
    expect(
      classify({ tool: 'copy_computer_file_to_space', args: {} }, 'writes')
        .gated,
    ).toBe(true);
    expect(
      classify({ tool: 'list_space_files', args: {} }, 'writes').gated,
    ).toBe(false);
    expect(
      classify({ tool: 'read_space_file', args: {} }, 'writes').gated,
    ).toBe(false);
  });

  it('name the steps and tell the Dot how to hand over a file', () => {
    expect(toolStepLabel('save_space_file')).toBe('Saving a file');
    expect(spaceFilesPrompt).toMatch(/save_space_file/);
    expect(spaceFilesPrompt).toMatch(/untrusted/);
  });
});
