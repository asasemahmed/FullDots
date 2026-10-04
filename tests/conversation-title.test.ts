import { expect, it } from 'vitest';
import {
  DEFAULT_CONVERSATION_TITLE,
  deriveTitle,
  hasDefaultTitle,
} from '../src/shared/conversation-title';

it('uses the first line of the message, whitespace collapsed', () => {
  expect(deriveTitle('  Plan   my\ttrip to   Lisbon  \nand book hotels')).toBe(
    'Plan my trip to Lisbon',
  );
  expect(deriveTitle('\n\r\n  \n Second line wins\nthird')).toBe(
    'Second line wins',
  );
});

it('does not rewrite what the user typed', () => {
  expect(deriveTitle('Use your computer: open https://example.com')).toBe(
    'Use your computer: open https://example.com',
  );
});

it('cuts long text at a word boundary and adds an ellipsis', () => {
  const title = deriveTitle(
    'Search the web for TH Deggendorf English-taught master programmes and list three',
  );
  expect(title).toBe('Search the web for TH Deggendorf English-taught master…');
  expect(title.length).toBeLessThanOrEqual(60);
});

it('keeps a title that fits exactly', () => {
  const exact = 'a'.repeat(30) + ' ' + 'b'.repeat(29);
  expect(exact).toHaveLength(60);
  expect(deriveTitle(exact)).toBe(exact);
});

it('drops trailing punctuation before the ellipsis and handles unbroken text', () => {
  expect(
    deriveTitle(
      'Explain how scheduling works, then compare it with the alternatives you know about',
    ),
  ).toBe('Explain how scheduling works, then compare it with the…');
  const unbroken = deriveTitle('x'.repeat(200));
  expect(unbroken).toBe(`${'x'.repeat(59)}…`);
});

it('falls back to the placeholder only when there is nothing to use', () => {
  expect(deriveTitle('')).toBe(DEFAULT_CONVERSATION_TITLE);
  expect(deriveTitle(' \n\t ')).toBe(DEFAULT_CONVERSATION_TITLE);
  expect(deriveTitle('', '')).toBe('');
  expect(hasDefaultTitle(' A new thought ')).toBe(true);
  expect(hasDefaultTitle('Plan my trip')).toBe(false);
});
