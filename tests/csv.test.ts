import { describe, expect, it } from 'vitest';
import { CSV_ROW_LIMIT, parseCsv, sortRows } from '../src/client/csv';
import { formatBytes } from '../src/shared/space-files';

describe('CSV parsing', () => {
  it('reads plain rows and ignores the final line break', () => {
    expect(parseCsv('a,b\n1,2\n').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
    expect(parseCsv('a,b\r\n1,2').rows).toHaveLength(2);
  });

  it('reads quoted fields with commas, line breaks and doubled quotes', () => {
    expect(
      parseCsv('name,note\n"Smith, Ann","said ""hi""\nthere"\n').rows,
    ).toEqual([
      ['name', 'note'],
      ['Smith, Ann', 'said "hi"\nthere'],
    ]);
  });

  it('keeps empty cells, pads short rows and drops a byte order mark', () => {
    expect(parseCsv('﻿a,b,c\n1,,3\n4\n').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
      ['4', '', ''],
    ]);
  });

  it('reads tab-separated text', () => {
    expect(parseCsv('a\tb\n1\t2', '\t').rows).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('shows at most the row limit and says how many are left out', () => {
    const lines = Array.from({ length: CSV_ROW_LIMIT + 10 }, (_, i) => `r${i}`);
    const parsed = parseCsv(lines.join('\n'));
    expect(parsed.rows).toHaveLength(CSV_ROW_LIMIT);
    expect(parsed.omitted).toBe(10);
    expect(parseCsv('').rows).toEqual([]);
  });
});

describe('CSV sorting', () => {
  const rows = [
    ['b', '10'],
    ['a', '9'],
    ['c', '100'],
  ];
  it('sorts numbers as numbers and text as text', () => {
    expect(sortRows(rows, 1, 'asc').map((row) => row[1])).toEqual([
      '9',
      '10',
      '100',
    ]);
    expect(sortRows(rows, 0, 'desc').map((row) => row[0])).toEqual([
      'c',
      'b',
      'a',
    ]);
    expect(rows[0]![0]).toBe('b');
  });
});

describe('sizes', () => {
  it('formats bytes', () => {
    expect(formatBytes(12)).toBe('12 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});
