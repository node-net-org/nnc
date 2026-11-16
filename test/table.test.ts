import { describe, expect, it } from 'vitest';
import { formatTable } from '../src/render/table.js';

describe('formatTable', () => {
  it('rules the header across the widest line', () => {
    const lines = formatTable(['A', 'B'], [['xx', 'yyyy']]);
    expect(lines).toEqual(['A   B', '────────', 'xx  yyyy']);
  });

  it('spans a header wider than the rule cap', () => {
    const wide = 'W'.repeat(120);
    const [header, rule] = formatTable(['NAME', wide], [['n', 'x']]);
    expect(rule!.length).toBe(header!.length);
  });

  it('caps the rule when only a last-column cell is long', () => {
    const [, rule] = formatTable(['K', 'V'], [['k', 'v'.repeat(200)]]);
    expect(rule).toBe('─'.repeat(100));
  });
});
