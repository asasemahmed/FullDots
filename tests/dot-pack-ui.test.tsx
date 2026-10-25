import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
vi.mock('../src/client/api', () => ({
  api: vi.fn(),
  authHeaders: () => ({}),
}));
import {
  ExportDotButton,
  ImportDotPanel,
  packSummary,
  readPackText,
} from '../src/client/DotPack';
import {
  DOT_PACK_KIND,
  DOT_PACK_VERSION,
  dotPackSchema,
} from '../src/shared/dot-pack';

const base = {
  kind: DOT_PACK_KIND,
  version: DOT_PACK_VERSION,
  name: 'Market Scout',
  instructions: 'Track prices and summarise them.',
};

describe('packSummary', () => {
  it('shows the name, role, rules count, approval mode and prompts count', () => {
    const pack = dotPackSchema.parse({
      ...base,
      approvalMode: 'writes',
      rules: { send_messages: 'ask', publish: 'never', spend_money: 'inherit' },
      prompts: [{ title: 'Digest', body: 'Summarise.' }],
    });
    expect(packSummary(pack)).toMatchObject({
      name: 'Market Scout',
      instructions: 'Track prices and summarise them.',
      rulesSet: 2,
      approval: 'writes',
      prompts: 1,
      approvalNote: undefined,
    });
  });

  it('says a pack asking for "off" starts on "sensitive"', () => {
    const summary = packSummary(
      dotPackSchema.parse({ ...base, approvalMode: 'off' }),
    );
    expect(summary.approval).toBe('sensitive');
    expect(summary.approvalNote).toContain('starts on Sensitive');
  });
});

describe('readPackText: refusals show a clear reason', () => {
  it('accepts a valid pack and returns the raw JSON for the import', () => {
    const result = readPackText(JSON.stringify(base));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.raw).toEqual(base);
  });

  it('refuses text that is not JSON', () => {
    expect(readPackText('{ nope')).toEqual({
      ok: false,
      error: 'This file is not valid JSON.',
    });
  });

  it('refuses an unknown field and names it', () => {
    const result = readPackText(JSON.stringify({ ...base, token: 'x' }));
    expect(result).toMatchObject({ ok: false });
    if (!result.ok)
      expect(result.error).toBe(
        'The pack has a field FullDots does not know: token.',
      );
  });

  it('refuses a wrong kind', () => {
    const result = readPackText(JSON.stringify({ ...base, kind: 'other' }));
    expect(result).toEqual({
      ok: false,
      error: 'This file is not a FullDots Dot pack.',
    });
  });

  it('refuses a role over 2,000 characters', () => {
    const result = readPackText(
      JSON.stringify({ ...base, instructions: 'x'.repeat(2001) }),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok)
      expect(result.error).toBe(
        'instructions: The role is at most 2,000 characters.',
      );
  });

  it('refuses a file over 200 KB before reading it as a pack', () => {
    const result = readPackText(`{"pad":"${'a'.repeat(200_001)}"}`);
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.error).toContain('too large');
  });
});

describe('the export and import controls', () => {
  it('renders an Export button for a Dot', () => {
    const markup = renderToStaticMarkup(
      <ExportDotButton
        dot={
          {
            id: 'dot-1',
            name: 'Scout',
          } as never
        }
      />,
    );
    expect(markup).toContain('>Export<');
  });

  it('renders the import panel with a file input and no preview before a file is chosen', () => {
    const markup = renderToStaticMarkup(
      <ImportDotPanel mutate={async () => true} onImported={() => {}} />,
    );
    expect(markup).toContain('type="file"');
    expect(markup).toContain('Have a Dot pack');
    expect(markup).not.toContain('Create this Dot');
  });
});
