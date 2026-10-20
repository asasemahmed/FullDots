/** Rows shown at most, so a huge file cannot freeze the page. */
export const CSV_ROW_LIMIT = 5000;

export interface ParsedCsv {
  rows: string[][];
  /** Rows in the file beyond the limit that are not in `rows`. */
  omitted: number;
}

/**
 * Reads comma- or tab-separated text (RFC 4180): quoted fields may hold the delimiter, line breaks
 * and doubled quotes. Rows are padded to the widest row so a table lines up.
 */
export function parseCsv(
  text: string,
  delimiter: ',' | '\t' = ',',
  limit = CSV_ROW_LIMIT,
): ParsedCsv {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let counted = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    // A line break at the very end of the file does not start another row.
    if (row.length > 1 || row[0] !== '') {
      counted++;
      if (rows.length < limit) rows.push(row);
    }
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i]!;
    if (quoted) {
      if (char === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += char;
    } else if (char === '"' && field === '') quoted = true;
    else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && source[i + 1] === '\n') i++;
      endRow();
    } else field += char;
  }
  if (field !== '' || row.length) endRow();
  const width = rows.reduce((most, line) => Math.max(most, line.length), 0);
  return {
    rows: rows.map((line) =>
      line.length < width
        ? [...line, ...Array(width - line.length).fill('')]
        : line,
    ),
    omitted: counted - rows.length,
  };
}

/** Sorts body rows by one column: numbers as numbers when every value is one, otherwise as text. */
export function sortRows(
  rows: readonly string[][],
  column: number,
  direction: 'asc' | 'desc',
): string[][] {
  const values = rows.map((line) => line[column] ?? '');
  const numeric = values.every(
    (value) => value.trim() !== '' && Number.isFinite(Number(value)),
  );
  const factor = direction === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    const left = a[column] ?? '';
    const right = b[column] ?? '';
    return (
      factor *
      (numeric
        ? Number(left) - Number(right)
        : left.localeCompare(right, undefined, { numeric: true }))
    );
  });
}
