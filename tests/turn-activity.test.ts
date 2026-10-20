import type { Message } from '@ag-ui/core';
import { describe, expect, it } from 'vitest';
import { activityText, turnActivity } from '../src/client/turn-activity';

const user: Message = { id: 'u', role: 'user', content: 'Find a venue' };
const call = (id: string, name: string) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{}' },
});

describe('turn activity', () => {
  it('thinks until the reply starts', () => {
    expect(turnActivity([user])).toEqual({ kind: 'thinking' });
    expect(
      turnActivity([user, { id: 'a', role: 'assistant', content: '' }]),
    ).toEqual({ kind: 'thinking' });
  });

  it('types while the reply streams in', () => {
    expect(
      turnActivity([
        user,
        { id: 'a', role: 'assistant', content: 'Here are three' },
      ]),
    ).toEqual({ kind: 'typing' });
  });

  it('works while a tool call waits for its result, then thinks again', () => {
    const asked: Message = {
      id: 'a',
      role: 'assistant',
      content: '',
      toolCalls: [call('c1', 'search_web')],
    };
    expect(turnActivity([user, asked])).toEqual({
      kind: 'using-tool',
      label: 'Searching the web',
    });
    const answered: Message = {
      id: 't',
      role: 'tool',
      toolCallId: 'c1',
      content: '[]',
    };
    expect(turnActivity([user, asked, answered])).toEqual({
      kind: 'thinking',
    });
    expect(
      turnActivity([user, { ...asked, content: 'Done' }, answered]),
    ).toEqual({ kind: 'thinking' });
  });

  it('words the status line', () => {
    expect(activityText({ kind: 'thinking' })).toBe('Thinking…');
    expect(activityText({ kind: 'typing' })).toBe('Writing…');
    expect(activityText({ kind: 'using-tool', label: 'Opening website' })).toBe(
      'Opening website…',
    );
  });
});
