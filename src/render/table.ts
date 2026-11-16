/**
 * Plain-text tables.
 *
 * Columns are sized to their widest cell (header included) and padded with
 * spaces, since tabs zig-zag as soon as a cell crosses a tab stop. The last
 * column isn't padded, so lines carry no trailing whitespace.
 *
 * The rule under the header always spans the header; a long cell in the last
 * column can stretch it further, but only up to MAX_RULE_WIDTH.
 */

const COLUMN_GAP = '  ';
const MAX_RULE_WIDTH = 100;

export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const last = headers.length - 1;
  const widths = headers.map((h, col) => Math.max(h.length, ...rows.map((row) => (row[col] ?? '').length)));
  const layout = (cells: readonly string[]): string =>
    headers
      .map((_h, col) => {
        const cell = cells[col] ?? '';
        return col === last ? cell : cell.padEnd(widths[col]!);
      })
      .join(COLUMN_GAP)
      .trimEnd();
  const header = layout(headers);
  const body = rows.map(layout);
  const widest = Math.max(header.length, ...body.map((l) => l.length));
  const rule = Math.max(header.length, Math.min(MAX_RULE_WIDTH, widest));
  return [header, '─'.repeat(rule), ...body];
}
