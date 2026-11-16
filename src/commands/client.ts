/**
 * Session commands for client sessions (docs/cli.md §6.3). Neither sends anything.
 */

import { parseCapability, parseXml } from '@node-net/netconf/core';
import { CliError } from '../errors.js';
import { toJson } from '../render/safe.js';
import { prettyXml } from '../render/xml.js';
import type { Cli } from '../cli.js';
import type { ActiveSession } from '../sessions/active.js';
import { sendHello } from './low.js';
import { usageError } from '../errors.js';
import type { Command } from './registry.js';

function session(cli: Cli): ActiveSession {
  if (cli.session === undefined) throw new CliError('not connected');
  return cli.session;
}

export const helloCommand: Command = {
  name: 'hello',
  group: 'messages',
  // In a framed session nnc has no Session: the hello is a message you frame and send yourself.
  listings: [
    { group: 'messages', kinds: ['client'] },
    { group: 'transport', kinds: ['framed'] },
  ],
  example: 'hello --raw',
  summary: "Show the server's <hello> (client sessions), or send a client hello (framed sessions)",
  describe: {
    client: "Show the server's <hello> (--raw: exactly as received)",
    framed: 'Send a client <hello> advertising base:1.0 and base:1.1, or only the one --base names',
  },
  args: [],
  options: {
    raw: { type: 'boolean', description: 'client sessions: print the server hello exactly as received, before any profile corrections' },
    base: { type: 'string', value: '<1.0|1.1>', values: ['1.0', '1.1'], description: 'framed sessions: advertise only this base version' },
  },
  kinds: ['client', 'framed'],
  run(cli, args) {
    if (cli.kind === 'framed') {
      if (args.options['raw'] !== undefined) throw usageError("hello: --raw is for client sessions; in this framed session hello sends a hello, and server-hello --raw shows the server's");
      return sendHello(cli, args);
    }
    if (args.options['base'] !== undefined) throw usageError("hello: --base is for framed sessions; in this client session hello shows the server's hello");
    const raw = session(cli).rawHello;
    if (raw === undefined) throw new CliError("the server's hello was not captured");
    if (args.options['raw'] === true) return Promise.resolve({ raw });
    return Promise.resolve({ text: prettyXml(parseXml(raw)) });
  },
};

type Origin = 'device' | 'added by profile' | 'removed by profile';

export const capabilitiesCommand: Command = {
  name: 'capabilities',
  group: 'messages',
  example: 'capabilities',
  summary: "List the server's capabilities after profile corrections (its YANG modules and features: modules)",
  args: [],
  options: {
    json: { type: 'boolean', description: 'print as JSON' },
  },
  kinds: ['client'],
  run(cli, args) {
    const s = session(cli).client.session;
    const json = args.options['json'] === true;
    const used = s.serverCapabilities.toArray();
    const sent = s.advertisedCapabilities.toArray();
    const sentIds = new Set(sent.map((u) => parseCapability(u).id));
    const usedIds = new Set(used.map((u) => parseCapability(u).id));
    const entries: { uri: string; origin: Origin }[] = [
      ...used.map((uri) => ({ uri, origin: sentIds.has(parseCapability(uri).id) ? ('device' as const) : ('added by profile' as const) })),
      ...sent.filter((uri) => !usedIds.has(parseCapability(uri).id)).map((uri) => ({ uri, origin: 'removed by profile' as const })),
    ];
    if (json) return Promise.resolve({ text: toJson(entries, 2) });
    return Promise.resolve({
      text: entries.map((e) => (e.origin === 'device' ? e.uri : `${e.uri}  [${e.origin}]`)).join('\n'),
    });
  },
};
