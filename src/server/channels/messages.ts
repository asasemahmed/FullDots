import type { ChannelNode } from '@copilotkit/channels-core';

export const textNode = (value: string): ChannelNode => ({
  type: 'text',
  props: { value },
});
export const section = (text: string): ChannelNode => ({
  type: 'section',
  props: { children: [textNode(text)] },
});
export function splitReply(text: string): string[] {
  const chunks: string[] = [];
  let part = '',
    cost = 0;
  // Leave room for provider formatting and HTML entity expansion.
  for (const character of text) {
    const size = '&<>"\''.includes(character) ? 6 : character.length;
    if (cost + size > 2400) {
      chunks.push(part);
      part = '';
      cost = 0;
    }
    part += character;
    cost += size;
  }
  if (part) chunks.push(part);
  return chunks;
}
export function buttons(approve: string, deny: string): ChannelNode[] {
  return [
    section('Review the action details above, then choose Approve or Deny.'),
    {
      type: 'actions',
      props: {
        children: [
          {
            type: 'button',
            props: {
              onClick: { id: approve },
              style: 'primary',
              children: [textNode('Approve')],
            },
          },
          {
            type: 'button',
            props: {
              onClick: { id: deny },
              style: 'danger',
              children: [textNode('Deny')],
            },
          },
        ],
      },
    },
  ];
}
export function safeFailure(error: unknown): string {
  const name =
    error instanceof Error &&
    ['Error', 'TypeError', 'AbortError', 'TimeoutError'].includes(error.name)
      ? error.name
      : 'Error';
  const status =
    error && typeof error === 'object' && 'status' in error
      ? error.status
      : undefined;
  return typeof status === 'number' &&
    Number.isInteger(status) &&
    status >= 100 &&
    status <= 599
    ? `${name} (HTTP ${status})`
    : name;
}
