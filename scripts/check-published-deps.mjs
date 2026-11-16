#!/usr/bin/env node
// Refuses to publish while a @node-net/ package this one depends on is not on
// the registry at a version its range accepts. Without this, the published
// package would be uninstallable. It runs as prepublishOnly, so a release
// waits for its siblings: publish in dependency order (yang, netconf,
// netconf-server, nnc).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

const deps = Object.entries({ ...pkg.dependencies, ...pkg.peerDependencies }).filter(([name]) => name.startsWith('@node-net/'));
const unpublished = [];
for (const [name, range] of deps) {
  let found = '';
  try {
    found = execFileSync('npm', ['view', `${name}@${range}`, 'version', '--json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (err) {
    // E404 means not on the registry at all; anything else (offline, auth) is
    // not an answer, so refuse without claiming the dependency is unpublished.
    const out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    if (!/E404|404 Not Found/.test(out)) {
      console.error(`${pkg.name}: could not check ${name}@${range} on the registry:\n${out.trim()}`);
      process.exit(1);
    }
  }
  if (found === '' || found === '[]') unpublished.push(`${name}@${range}`);
}

if (unpublished.length > 0) {
  console.error(`${pkg.name}: publish ${unpublished.join(', ')} first; ${pkg.name} depends on it and would not install.`);
  process.exit(1);
}
console.log(`ok   ${pkg.name}: @node-net dependencies on the registry (${deps.map(([n, r]) => `${n}@${r}`).join(', ') || 'none'})`);
