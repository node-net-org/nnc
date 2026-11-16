// @node-net/nnc/core must run in any JavaScript runtime (docs/cli.md §2.6),
// so nnc can run in a web page. After a build, this:
//
// 1. bundles it for the browser platform with no aliases or externals, and
//    fails on any import that can't be resolved or loaded there (a Node
//    built-in, ssh2's native code);
// 2. runs the bundle in a context with only web-platform globals (no Buffer,
//    process or require), with an in-memory host and a simulated device:
//    trace frames, connect, status, capabilities, get-config, disconnect.
//
//   npm run build && node scripts/portable-check.mjs

import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { rolldown } from 'rolldown';

const entry = fileURLToPath(new URL('./portable-smoke.mjs', import.meta.url));

const problems = [];
let output;
try {
  const bundle = await rolldown({
    input: entry,
    platform: 'browser',
    onLog(level, log) {
      // An import that can't be resolved for the browser is left external with a warning: that is a failure here.
      if (level === 'warn' || log.code === 'UNRESOLVED_IMPORT') problems.push(`${log.code ?? level}: ${log.message}`);
    },
  });
  ({ output } = await bundle.generate({ format: 'iife' }));
  await bundle.close();
} catch (err) {
  problems.push(`bundle failed: ${err.message}`);
}
if (problems.length > 0) fail('@node-net/nnc/core does not bundle for the browser', problems);

const code = output[0].code;
const leftovers = [...code.matchAll(/(?:require\(|from\s*)["'](node:[\w/]+|ssh2)["']/g)].map((m) => m[1]);
if (leftovers.length > 0) fail('the browser bundle still imports Node modules', leftovers);

// Web-platform globals only. The JavaScript built-ins (Promise, Map, Uint8Array, …) come with the context itself.
const context = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  queueMicrotask,
  structuredClone,
  TextEncoder,
  TextDecoder,
  URL,
  AbortController,
  AbortSignal,
  Event,
  EventTarget,
  DOMException,
  performance,
  atob,
  btoa,
});
vm.runInContext(code, context, { filename: 'portable-bundle.js' });
for (const name of ['Buffer', 'process', 'require']) {
  if (vm.runInContext(`typeof ${name}`, context) !== 'undefined') fail(`the check context has ${name}`, []);
}

let result;
try {
  result = await vm.runInContext('portableSmoke()', context);
} catch (err) {
  fail('the smoke run failed without Node globals', [err.stack ?? String(err)]);
}
const expect = (ok, what) => {
  if (!ok) fail(`smoke: ${what}`, [`exit ${result.exitCode}`, '--- out', result.out, '--- err', result.err]);
};
expect(result.exitCode === 0, 'every command succeeded');
expect(/connected to lab \(sim:router\)/.test(result.out + result.err), 'connect reached the simulated device');
expect(/simulated device/.test(result.out), 'status names the simulated transport');
expect(/urn:ietf:params:netconf:base:1\.1/.test(result.out), 'capabilities lists the server hello');
expect(/\(no data\)/.test(result.out), 'get-config returned an empty configuration');
expect(/frames/.test(result.err), 'the trace showed frames');

const kib = (new TextEncoder().encode(code).length / 1024).toFixed(0);
console.log(`portable:check ok: @node-net/nnc/core bundles for the browser (${kib} KiB unminified) and runs nnc without Node globals`);

function fail(message, details) {
  console.error(`portable:check: ${message}`);
  for (const d of details) console.error(`  ${d}`);
  process.exit(1);
}
