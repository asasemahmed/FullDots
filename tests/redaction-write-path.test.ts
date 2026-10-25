// Notes and saved memories are redacted on their way into storage, and only there.
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/server/app.js';
import { DotNotesService } from '../src/server/dot-notes-service.js';
import { DotNotesStore } from '../src/server/dot-notes-store.js';
import { InboxStore } from '../src/server/inbox-store.js';
import { Platform } from '../src/server/platform.js';
import { Runner } from '../src/server/runner.js';
import { Store } from '../src/server/store.js';
import { WorkspaceStore } from '../src/server/workspace.js';
import { NOTE_MAX, type DotNote } from '../src/shared/notes.js';
import type { Memory } from '../src/shared/types.js';

// Built at run time so no key-shaped text sits in the source. Not a real key.
const fakeKey = (prefix: string, seed: string, length = 40) =>
  prefix +
  createHash('sha256')
    .update(seed)
    .digest('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .padEnd(length, 'x')
    .slice(0, length);

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The log lines written while `run` executes; they must carry a count and never a secret. */
function warnings(run: () => void): string[] {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  run();
  const lines = warn.mock.calls.map((call) => call.join(' '));
  warn.mockRestore();
  return lines;
}

function notesRig() {
  const db = new DatabaseSync(':memory:');
  cleanups.push(() => db.close());
  const notes = new DotNotesStore(db);
  const inbox = new InboxStore(db);
  const service = new DotNotesService({
    notes,
    inbox,
    dot: (id) =>
      id === 'dot' ? { name: 'Scout', notesProposals: true } : undefined,
  });
  return { notes, inbox, service };
}

describe('a Dot note', () => {
  it('is stored redacted, and the log says how many but not what', () => {
    const { notes } = notesRig();
    const key = fakeKey('sk-', 'note-key');
    const lines = warnings(() => {
      notes.put(
        'dot',
        `Staging uses ${key} and the owner likes short answers.`,
      );
    });
    expect(notes.get('dot').text).toBe(
      'Staging uses [redacted] and the owner likes short answers.',
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('1 secret-like value');
    expect(lines.join('\n')).not.toContain(key);
  });

  it('writes nothing to the log when there was nothing to hide', () => {
    const { notes } = notesRig();
    expect(
      warnings(() => void notes.put('dot', 'Likes short answers.')),
    ).toEqual([]);
  });

  it('keeps redacted text in the history, and a restore does not bring a secret back', () => {
    const { notes } = notesRig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = fakeKey('ghp_', 'history', 36);
    notes.put('dot', `token ${key}`);
    notes.put('dot', 'Something else.');
    const stored = notes.versions('dot').map((version) => version.text);
    expect(stored).toEqual(['token [redacted]']);
    expect(JSON.stringify(notes.versions('dot'))).not.toContain(key);
  });

  it('redacts a line saved from a proposal, without repeating it on a retry', () => {
    const { notes } = notesRig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = fakeKey('AIza', 'append', 35);
    notes.appendLine('dot', `Maps key is ${key}`);
    notes.appendLine('dot', `Maps key is ${key}`);
    expect(notes.get('dot').text).toBe('Maps key is [redacted]');
  });

  it('applies the size limit to the redacted text', () => {
    const { notes } = notesRig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = Array.from({ length: 200 }, (_, i) =>
      fakeKey('sk-', `size-${i}`, 60),
    ).join(' ');
    expect(text.length).toBeGreaterThan(NOTE_MAX);
    expect(notes.put('dot', text).text).toBe(
      Array(200).fill('[redacted]').join(' '),
    );
  });

  it('is redacted in a proposal too, before the owner sees or saves it', () => {
    const { notes, inbox, service } = notesRig();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = fakeKey('xoxb-', 'proposal-1234567890-', 30);
    const item = service.propose({
      dotId: 'dot',
      threadId: 'thread',
      note: `Slack bot token is ${key}`,
    });
    expect(item.text).toBe('Slack bot token is [redacted]');
    expect(inbox.get(item.id)?.text).toBe('Slack bot token is [redacted]');
    expect(service.save(item.id).note).toBe('Slack bot token is [redacted]');
    expect(notes.get('dot').text).toBe('Slack bot token is [redacted]');
  });

  it('is redacted when the owner writes it through the API, and the chat is not touched', async () => {
    const store = new Store(':memory:');
    const workspace = new WorkspaceStore(':memory:', 'owner');
    const platform = new Platform(store, workspace, {
      apiKey: 'fixture',
      model: 'custom-model',
      baseUrl: 'https://unused.invalid/v1',
      voiceName: 'marin',
    });
    cleanups.push(async () => {
      await platform.stop();
      store.close();
      workspace.close();
    });
    const research = { mode: 'sample' as const, baseUrl: '' };
    const app = createApp({
      store,
      runner: new Runner(store, research),
      config: research,
      platform,
    });
    const dot = workspace.dots()[0]!;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = fakeKey('sk-ant-', 'route', 60);
    const response = await app.request(`/api/dots/${dot.id}/notes`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `Use ${key} for tests.` }),
    });
    expect(response.status).toBe(200);
    expect(((await response.json()) as DotNote).text).toBe(
      'Use [redacted] for tests.',
    );
    const read = await app.request(`/api/dots/${dot.id}/notes`);
    expect(JSON.stringify(await read.json())).not.toContain(key);
  });
});

describe('a saved memory', () => {
  it('is stored redacted when created and when edited', () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    const key = fakeKey('github_pat_', 'memory', 60);
    const lines = warnings(() => {
      const saved = store.saveMemory(`My token is ${key}, remember it.`);
      expect(saved.text).toBe('My token is [redacted], remember it.');
      const edited = store.saveMemory(`New one: ${key}`, saved.id);
      expect(edited.text).toBe('New one: [redacted]');
    });
    expect(store.memories().map((memory) => memory.text)).toEqual([
      'New one: [redacted]',
    ]);
    expect(lines).toHaveLength(2);
    expect(lines.join('\n')).toContain('1 secret-like value');
    expect(lines.join('\n')).not.toContain(key);
  });

  it('leaves an ordinary memory exactly as written', () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    const text =
      'Prefers short briefs. See https://github.com/asasemahmed/FullDots.';
    expect(warnings(() => void store.saveMemory(text))).toEqual([]);
    expect(store.memories()[0]?.text).toBe(text);
  });

  it('is redacted when written through the API', async () => {
    const store = new Store(':memory:');
    cleanups.push(() => store.close());
    const research = { mode: 'sample' as const, baseUrl: '' };
    const app = createApp({
      store,
      runner: new Runner(store, research),
      config: research,
    });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const key = fakeKey('AKIA', 'api-memory', 16).toUpperCase();
    const response = await app.request('/api/memories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `AWS id ${key}` }),
    });
    expect(response.status).toBe(201);
    expect(((await response.json()) as Memory).text).toBe('AWS id [redacted]');
    expect(JSON.stringify(store.memories())).not.toContain(key);
  });
});
