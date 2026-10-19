import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { Message } from '@ag-ui/core';
import { buildTranscriptItems, parseSavedFile } from '../src/client/chat-turns';
import { ChatTranscript } from '../src/client/ChatTranscript';
import { FileCard } from '../src/client/FileCard';

const saved = {
  saved: true,
  file: {
    id: 'f1',
    spaceId: 's1',
    name: 'prices.csv',
    kind: 'csv',
    size: 2048,
    url: '/#/spaces/s1/files/f1',
  },
  space: 'Research',
};

/** One turn: the owner asks, the Dot saves a file and answers. */
function turn(result: unknown, toolName = 'save_space_file'): Message[] {
  return [
    { id: 'u1', role: 'user', content: 'Put the prices in a file' },
    {
      id: 'a1',
      role: 'assistant',
      content: 'Saved the prices.',
      toolCalls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: toolName, arguments: '{}' },
        },
      ],
    },
    {
      id: 't1',
      role: 'tool',
      toolCallId: 'c1',
      content: typeof result === 'string' ? result : JSON.stringify(result),
    },
  ] as Message[];
}

describe('saved file results', () => {
  it('read the details a card needs', () => {
    expect(parseSavedFile(JSON.stringify(saved))).toEqual({
      id: 'f1',
      spaceId: 's1',
      name: 'prices.csv',
      kind: 'csv',
      size: 2048,
      space: 'Research',
    });
  });

  it('ignore anything that is not a saved file', () => {
    expect(parseSavedFile(undefined)).toBeUndefined();
    expect(parseSavedFile('not json "saved"')).toBeUndefined();
    expect(parseSavedFile('{"saved":false}')).toBeUndefined();
    expect(
      parseSavedFile(JSON.stringify({ ...saved, file: { id: 'x' } })),
    ).toBeUndefined();
    expect(
      parseSavedFile(
        JSON.stringify({ ...saved, file: { ...saved.file, kind: 'exe' } }),
      ),
    ).toBeUndefined();
    expect(parseSavedFile('[]')).toBeUndefined();
  });
});

describe('file cards in the chat', () => {
  it('follow the Dot’s reply, after the work and its text', () => {
    const items = buildTranscriptItems(turn(saved), []);
    const kinds = items.map((item) => item.kind);
    expect(kinds).toContain('file');
    expect(kinds.indexOf('file')).toBeGreaterThan(
      items.findIndex(
        (item) => item.kind === 'bubble' && item.role === 'assistant',
      ),
    );
  });

  it('are not made for a failed save', () => {
    const items = buildTranscriptItems(
      turn({ error: 'File not found in this Space.' }),
      [],
    );
    expect(items.some((item) => item.kind === 'file')).toBe(false);
  });

  it('render with the name, size and Space and link to the viewer', () => {
    const html = renderToStaticMarkup(
      <ChatTranscript
        messages={turn(saved).filter((message) => message.role !== 'tool')}
        allMessages={turn(saved)}
        calls={[]}
      />,
    );
    expect(html).toContain('prices.csv');
    expect(html).toContain('Table · 2.0 KB · in Research');
    expect(html).toContain('href="#/spaces/s1/files/f1"');
    expect(html).toContain('target="_blank"');
    // The tool's raw JSON is never printed.
    expect(html).not.toContain('&quot;saved&quot;');
  });

  it('label each kind of file', () => {
    const card = (kind: string) =>
      renderToStaticMarkup(
        <FileCard
          file={{
            id: 'f',
            spaceId: 's',
            name: 'n',
            kind: kind as never,
            size: 1,
            space: '',
          }}
        />,
      );
    expect(card('html')).toContain('Web page · 1 B');
    expect(card('markdown')).toContain('Document');
    expect(card('csv')).not.toContain('· in');
  });
});

describe('opening a card', () => {
  it('shows the file beside the chat when the chat can, and links to the Space when it cannot', () => {
    const file = {
      id: 'f1',
      spaceId: 's1',
      name: 'a.csv',
      kind: 'csv' as const,
      size: 1,
      space: 'Research',
    };
    const opened: unknown[] = [];
    const card = FileCard({ file, onOpen: (picked) => opened.push(picked) });
    // The main button hands the file to the chat; the small link still opens a new window.
    const main = (
      card.props.children as { props: { onClick: () => void } }[]
    )[0]!;
    main.props.onClick();
    expect(opened).toEqual([file]);
    expect(
      renderToStaticMarkup(<FileCard file={file} onOpen={() => undefined} />),
    ).toContain('target="_blank"');
  });
});
