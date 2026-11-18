import { expect, it } from 'vitest';
import { fileHash } from '../src/client/file-links';

it('builds the file viewer hash with the space and file in route order', () => {
  expect(fileHash('space-123', 'file-456')).toBe(
    '#/spaces/space-123/files/file-456',
  );
});
