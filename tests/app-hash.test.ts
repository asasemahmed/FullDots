import { expect, it } from 'vitest';
import { parseAppHash } from '../src/client/app-hash';

it('parses the approvals, thread and space hashes', () => {
  expect(parseAppHash('#/approvals')).toEqual({ view: 'approvals' });
  expect(parseAppHash('#/dots/dot-1/threads/th-9')).toEqual({
    view: 'thread',
    dotId: 'dot-1',
    threadId: 'th-9',
  });
  expect(parseAppHash('#/dots/a%20b/threads/c%2Fd')).toEqual({
    view: 'thread',
    dotId: 'a b',
    threadId: 'c/d',
  });
  expect(parseAppHash('#/spaces/s1')).toEqual({
    view: 'space',
    spaceId: 's1',
    pageId: undefined,
  });
  expect(parseAppHash('#/spaces/s1/pages/p2')).toEqual({
    view: 'space',
    spaceId: 's1',
    pageId: 'p2',
  });
});

it('ignores unknown or malformed hashes', () => {
  for (const hash of [
    '',
    '#',
    '#/',
    '#/approvals/extra',
    '#/dots/d1',
    '#/dots/d1/threads',
    '#/dots/d1/threads/t1/more',
    '#/dots/%E0%A4%A/threads/t1',
    '#/other',
  ])
    expect(parseAppHash(hash), hash).toBeUndefined();
});
