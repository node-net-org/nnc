/**
 * A test SSH server plus a HOME whose known_hosts trusts it and whose targets
 * file has `router1` pointing at it (password from a file).
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { XmlElement } from '@node-net/netconf';
import { knownHostsLine, makeHome, type Home } from './nnc.js';
import { startSshServer, type TestSshServer, type TestSshServerOptions } from './ssh-server.js';

export interface Fixture {
  readonly server: TestSshServer;
  readonly home: Home;
  /** Path of a file holding the router1 password. */
  readonly passwordFile: string;
  /** A target pointing at the server, with extra fields. */
  target(extra?: object): object;
  /** Write a profile into HOME/profiles and return the directory. */
  profile(spec: object): string;
  /** Number of `<rpc>`s the most recent session received, other than <close-session>. */
  rpcsSent(): number;
  /** The operations (first child of each `<rpc>`) the most recent session received, other than <close-session>. */
  sent(): XmlElement[];
  close(): Promise<void>;
}

export async function fixture(options: TestSshServerOptions = {}, targetExtra: object = {}): Promise<Fixture> {
  const server = await startSshServer(options);
  const home = makeHome();
  home.knownHosts([knownHostsLine(server.port, server.publicKeyLine)]);
  const passwordFile = home.file('router1.pass', `${options.password ?? 'secret'}\n`);
  const target = (extra: object = {}): object => ({
    host: '127.0.0.1',
    port: server.port,
    username: options.username ?? 'admin',
    password: { file: passwordFile },
    ...extra,
  });
  home.targets({ router1: target(targetExtra) });
  return {
    server,
    home,
    passwordFile,
    target,
    profile: (spec) => {
      const dir = join(home.dir, 'profiles');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, `${(spec as { id: string }).id}.json`), JSON.stringify(spec));
      return dir;
    },
    rpcsSent: () => (server.last()?.requests ?? []).filter((r) => r.elements[0]?.name !== 'close-session').length,
    sent: () => (server.last()?.requests ?? []).map((r) => r.elements[0]!).filter((op) => op.name !== 'close-session'),
    close: () => server.close(),
  };
}
