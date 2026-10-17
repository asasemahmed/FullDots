import { expect, it, vi } from 'vitest';

// The download helper imports the API client, which reads the session token from storage as it
// loads. Tests run without a DOM, so it gets an empty one before the module is imported.
vi.stubGlobal('sessionStorage', {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
});
const { filenameFrom } = await import('../src/client/conversation-export');

it('reads the UTF-8 file name the export route writes', () => {
  expect(
    filenameFrom(
      `attachment; filename="Plane the launch.md"; filename*=UTF-8''Pl%C3%A4ne%20f%C3%BCr%20den%20Start.md`,
    ),
  ).toBe('Pläne für den Start.md');
});

it('falls back to the plain file name', () => {
  expect(filenameFrom('attachment; filename="Plan the launch.md"')).toBe(
    'Plan the launch.md',
  );
});

it('reports no file name for a missing or malformed header', () => {
  expect(filenameFrom(null)).toBeUndefined();
  expect(filenameFrom(`attachment; filename*=UTF-8''%E0%A4%A`)).toBeUndefined();
  expect(filenameFrom('attachment')).toBeUndefined();
});
