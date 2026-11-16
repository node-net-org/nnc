/**
 * Paths typed in commands: `~` at the start means the home directory (docs/cli.md §6.1).
 * The home directory is the host's (NncHost.homeDir).
 */

export function expandHome(path: string, home: string): string {
  if (path === '~') return home;
  if (path.startsWith('~/')) return `${home.replace(/\/$/, '')}/${path.slice(2)}`;
  return path;
}
