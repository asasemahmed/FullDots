import { expect, it } from 'vitest';
import type { Message } from '@ag-ui/core';
import {
  exportConversationMarkdown,
  type ExportInput,
} from '../src/server/conversation-export.js';

const toolCall = (name: string, id = name) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{}' },
});

const toolResult = (toolCallId: string, content: string): Message => ({
  id: `result-${toolCallId}`,
  role: 'tool',
  toolCallId,
  content,
});

/** A one-Dot conversation whose history is the given messages. */
function exportOf(
  messages: Message[],
  overrides: Partial<ExportInput> = {},
): string {
  return exportConversationMarkdown({
    conversation: {
      id: 't1',
      title: 'Plan the launch',
      dotId: 'dot-1',
      createdAt: Date.UTC(2025, 9, 17, 9, 14),
      updatedAt: Date.UTC(2025, 9, 17, 9, 31),
    },
    members: [{ id: 'dot-1', name: 'Scout' }],
    authors: {},
    messages,
    ...overrides,
  }).markdown;
}

it('writes the title, the Dot and both dates', () => {
  const markdown = exportOf([
    { id: 'u1', role: 'user', content: 'Who are our competitors?' },
  ]);
  expect(markdown).toContain('# Plan the launch');
  expect(markdown).toContain('**Dot:** Scout');
  expect(markdown).toContain('**Started:** 2025-10-17 09:14 UTC');
  expect(markdown).toContain('**Last activity:** 2025-10-17 09:31 UTC');
});

it('writes the owner and the Dot in the order they spoke', () => {
  const markdown = exportOf([
    { id: 'u1', role: 'user', content: 'Who are our competitors?' },
    { id: 'a1', role: 'assistant', content: 'Three of them.' },
    { id: 'u2', role: 'user', content: 'Name them.' },
  ]);
  expect(markdown).toContain('## You\n\nWho are our competitors?');
  expect(markdown).toContain('## Scout\n\nThree of them.');
  expect(markdown.indexOf('Who are our competitors?')).toBeLessThan(
    markdown.indexOf('Three of them.'),
  );
  expect(markdown.indexOf('Three of them.')).toBeLessThan(
    markdown.indexOf('Name them.'),
  );
});

it('summarises each tool call in one line and never copies a tool result', () => {
  const markdown = exportOf([
    { id: 'u1', role: 'user', content: 'Look it up' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Found it.',
      toolCalls: [
        toolCall('search_web', 'c1'),
        toolCall('computer_navigate', 'c2'),
        toolCall('mcp__github__list_issues', 'c3'),
        toolCall('something_new', 'c4'),
      ],
    },
    toolResult('c1', 'a result body that must not be copied'),
    toolResult('c2', 'another result body'),
  ]);
  expect(markdown).toContain('- Searching the web');
  expect(markdown).toContain('- Opening website');
  expect(markdown).toContain('- Using github');
  expect(markdown).toContain('- Using a tool');
  // The one line a call needs comes from its name; its result body is never copied.
  expect(markdown).not.toContain('a result body that must not be copied');
  expect(markdown).not.toContain('another result body');
});

it('lists a turn\u2019s tool calls under the reply they belong to', () => {
  const markdown = exportOf([
    { id: 'u1', role: 'user', content: 'Look it up' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Found it.',
      toolCalls: [toolCall('search_web', 'c1')],
    },
  ]);
  expect(markdown.indexOf('- Searching the web')).toBeLessThan(
    markdown.indexOf('Found it.'),
  );
});

it('merges one Dot\u2019s consecutive messages into a single section', () => {
  const markdown = exportOf([
    { id: 'u1', role: 'user', content: 'Look it up' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Looking.',
      toolCalls: [toolCall('search_web', 'c1')],
    },
    { id: 'a2', role: 'assistant', content: 'Found it.' },
  ]);
  expect(markdown.match(/## Scout/g)).toHaveLength(1);
  expect(markdown).toContain('Looking.\n\nFound it.');
});

it('labels a turn the server started instead of showing it as the owner', () => {
  const markdown = exportOf([
    {
      id: 'u1',
      role: 'user',
      content: 'Check the inbox',
      metadata: { source: 'task', ref: 't9' },
    },
    { id: 'a1', role: 'assistant', content: 'Nothing new.' },
  ]);
  expect(markdown).toContain('**Scheduled task**\n\nCheck the inbox');
  expect(markdown).not.toContain('## You');
  // The label matches the one the transcript shows for the same turn.
  expect(markdown).toContain('Scheduled task');
});

it('attributes each reply to the Dot that wrote it in a group chat', () => {
  const markdown = exportOf(
    [
      { id: 'u1', role: 'user', content: 'Both of you look' },
      { id: 'a1', role: 'assistant', content: 'On it.' },
      { id: 'a2', role: 'assistant', content: 'Me too.' },
    ],
    {
      members: [
        { id: 'dot-1', name: 'Scout' },
        { id: 'dot-2', name: 'Researcher' },
      ],
      authors: { a1: 'dot-1', a2: 'dot-2' },
    },
  );
  expect(markdown).toContain('**Dots:** Scout, Researcher');
  expect(markdown).toContain('## Scout\n\nOn it.');
  expect(markdown).toContain('## Researcher\n\nMe too.');
});

it('falls back to the host Dot when a reply has no recorded author', () => {
  const markdown = exportOf(
    [{ id: 'a1', role: 'assistant', content: 'Hello' }],
    {
      members: [
        { id: 'dot-1', name: 'Scout' },
        { id: 'dot-2', name: 'Researcher' },
      ],
    },
  );
  expect(markdown).toContain('## Scout\n\nHello');
});

it('says so when a conversation has nothing in it', () => {
  const markdown = exportOf([]);
  expect(markdown).toContain('# Plan the launch');
  expect(markdown).toContain('_This conversation has no messages yet._');
});

it('writes unknown for a conversation nothing was ever sent in', () => {
  const markdown = exportOf([{ id: 'u1', role: 'user', content: 'Hi' }], {
    conversation: {
      id: 't1',
      title: 'Plan the launch',
      dotId: 'dot-1',
      createdAt: Date.UTC(2025, 9, 17, 9, 14),
      updatedAt: null,
    },
  });
  expect(markdown).toContain('**Last activity:** unknown');
});

it('builds a file name from the title, dropping what a file name cannot carry', () => {
  const nameOf = (title: string) =>
    exportConversationMarkdown({
      conversation: {
        id: 't1',
        title,
        dotId: 'dot-1',
        createdAt: 0,
        updatedAt: null,
      },
      members: [{ id: 'dot-1', name: 'Scout' }],
      authors: {},
      messages: [],
    }).filename;
  expect(nameOf('Plan the launch')).toBe('Plan the launch.md');
  expect(nameOf('Launch: Q3/Q4 "plans"?')).toBe('Launch Q3Q4 plans.md');
  // Letters outside ASCII are kept: they are readable on every platform.
  expect(nameOf('Pläne für den Start')).toBe('Pläne für den Start.md');
  expect(nameOf('   ')).toBe('conversation.md');
  expect(nameOf('x'.repeat(200))).toBe(`${'x'.repeat(80)}.md`);
});
