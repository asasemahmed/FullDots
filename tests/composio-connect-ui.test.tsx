import { randomUUID } from 'node:crypto';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));

import { ApprovalCard } from '../src/client/ApprovalCard';
import { parseApprovalResult } from '../src/client/chat-turns';

describe('Connect key form', () => {
  it('uses a password box for a secret and a text box for the rest', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        result={{
          status: 'handoff',
          handoffId: '',
          kind: 'credential',
          reason: 'Perplexity needs a key you already have.',
          toolkit: 'perplexityai',
          fields: [
            {
              name: 'api_key',
              label: 'API key',
              help: 'From the vendor.',
              secret: true,
              required: true,
            },
            {
              name: 'subdomain',
              label: 'Subdomain',
              help: 'The site prefix.',
              secret: false,
              required: true,
            },
          ],
        }}
      />,
    );
    expect(html).toContain('type="password"');
    expect(html).toContain('type="text"');
    expect(html).toContain('API key');
    expect(html).toContain('From the vendor.');
    expect(html).not.toContain('Open the Connect link');
    expect(html).not.toContain('href=');
  });

  it('keeps the Connect link when the handoff has a url and no fields', () => {
    const html = renderToStaticMarkup(
      <ApprovalCard
        result={{
          status: 'handoff',
          handoffId: '',
          kind: 'credential',
          reason: 'Gmail needs you to connect before this can run.',
          url: 'https://backend.composio.dev/s/gmail',
        }}
      />,
    );
    expect(html).toContain('https://backend.composio.dev/s/gmail');
    expect(html).toContain('Open the Connect link');
    expect(html).not.toContain('type="password"');
  });

  it('drops a value that was smuggled into the field list', () => {
    const secret = `fd-test-${randomUUID()}`;
    const parsed = parseApprovalResult(
      JSON.stringify({
        status: 'handoff',
        handoffId: '',
        kind: 'credential',
        reason: 'Connect',
        url: 'https://backend.composio.dev/s/start',
        toolkit: 'perplexityai',
        fields: [
          {
            name: 'api_key',
            label: 'API key',
            help: '',
            secret: true,
            required: true,
            value: secret,
          },
        ],
      }),
    );
    expect(parsed).toMatchObject({
      toolkit: 'perplexityai',
      fields: [{ name: 'api_key', secret: true }],
    });
    expect(parsed).not.toHaveProperty('url');
    expect(JSON.stringify(parsed)).not.toContain(secret);
  });
});
