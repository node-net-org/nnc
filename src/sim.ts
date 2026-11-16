/**
 * Simulated devices (docs/cli.md §8): a `"transport": "sim"` target reaches a
 * device the host provides in-process, such as a FakeServer or a simulator in
 * a web page, instead of an SSH or TLS endpoint. Everything above the
 * connection (hello, profile, trace, hello capture, commands) is the same.
 */

import type { ConnectionFactory } from '@node-net/netconf/core';
import { CliError, EXIT } from './errors.js';
import type { SecretPrompt, Transports } from './host.js';
import { simDevice, type Use } from './sessions/connect.js';
import type { Target } from './targets.js';

/** Simulated devices by name: each gives a new connection to its device. */
export type SimDevices = Readonly<Record<string, () => ConnectionFactory>>;

/**
 * Transports that reach sim targets through `devices`, and hand every other
 * target to `fallback` (the Node host's SSH and TLS, say). Without a fallback,
 * a target that isn't sim fails, saying only simulated devices can be reached.
 */
export function simTransports(devices: SimDevices, fallback?: Transports): Transports {
  const transports: Transports = {
    reach<T>(target: Target, prompt: SecretPrompt, use: Use<T>): Promise<T> {
      if (target.transport !== 'sim') {
        if (fallback !== undefined) return fallback.reach(target, prompt, use);
        return Promise.reject(new CliError(`cannot reach ${target.name}: only simulated devices ("transport": "sim") can be reached here`, EXIT.connection));
      }
      const name = simDevice(target);
      const device = Object.prototype.hasOwnProperty.call(devices, name) ? devices[name] : undefined;
      if (device === undefined) {
        const known = Object.keys(devices).sort().join(', ');
        return Promise.reject(new CliError(`cannot reach ${target.name}: there is no simulated device "${name}" here${known === '' ? '' : ` (devices: ${known})`}`, EXIT.connection));
      }
      const describe = (err: unknown): Error =>
        err instanceof CliError ? err : new CliError(`sim:${name}: ${err instanceof Error ? err.message : String(err)}`, EXIT.connection);
      return use(device(), 0, { via: undefined, insecure: false, transport: 'sim' }, describe);
    },
  };
  const listen = fallback?.listen;
  if (listen !== undefined) {
    // A simulated device is reached in-process; it never calls home.
    transports.listen = (req) =>
      req.target.transport === 'sim'
        ? Promise.reject(new CliError(`listen: ${req.target.name} is a simulated device, which can't call home; use connect`, EXIT.usage))
        : listen(req);
  }
  if (fallback?.checkHostKey !== undefined) transports.checkHostKey = fallback.checkHostKey;
  return transports;
}
