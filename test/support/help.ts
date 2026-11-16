/**
 * Reading nnc's help index (LANG-11): its sections and the extension blocks in Operations.
 */

/** A section of the index, from its heading line up to the next blank line followed by an unindented heading. */
export function section(stdout: string, title: string): string {
  const lines = stdout.split('\n');
  const start = lines.indexOf(title);
  if (start === -1) return '';
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line !== '' && !line.startsWith(' ')) break;
    out.push(line);
  }
  return out.join('\n').replace(/\n+$/, '');
}

/** The lines under a heading inside a section (`  nmda · RFC 8526`), up to the next such heading. */
export function block(stdout: string, heading: string): string {
  const lines = stdout.split('\n');
  const start = lines.indexOf(`  ${heading}`);
  if (start === -1) return '';
  const out: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith('    ')) break;
    out.push(line);
  }
  return out.join('\n');
}

/** The unindented section headings, in order. */
export function sectionTitles(stdout: string): string[] {
  return stdout
    .split('\n')
    .slice(1)
    .filter((l, i, all) => l !== '' && !l.startsWith(' ') && all[i - 1] === '' && !l.startsWith('*') && !l.startsWith('help <command>') && !/ is read-only: /.test(l));
}
