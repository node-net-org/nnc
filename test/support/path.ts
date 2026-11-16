/**
 * A device for the content and device commands (PATH area): ietf-interfaces
 * and a lab module in the hello, configuration data for reads, and a profile
 * with named paths and operations.
 */
import { x, type XmlElement } from '@node-net/netconf';
import type { RpcHandler } from '@node-net/netconf/testing';
import { BASE10, BASE11, CANDIDATE, STARTUP, VALIDATE11, WRITABLE_RUNNING } from './caps.js';
import { fixture, type Fixture } from './fixture.js';

export const IF_NS = 'urn:ietf:params:xml:ns:yang:ietf-interfaces';
export const LAB_NS = 'urn:example:lab';
export const IF_MODULE = `${IF_NS}?module=ietf-interfaces&revision=2018-02-20`;
export const LAB = `${LAB_NS}?module=lab&revision=2024-01-01`;

/** A candidate device that advertises ietf-interfaces and lab. */
export const CAPS = [BASE10, BASE11, CANDIDATE, STARTUP, WRITABLE_RUNNING, VALIDATE11, IF_MODULE, LAB];
/** A device without a candidate: edits go to running. */
export const RUNNING_CAPS = [BASE10, BASE11, WRITABLE_RUNNING, IF_MODULE, LAB];

export function config(): XmlElement[] {
  return [
    x('interfaces', { xmlns: IF_NS },
      x('interface', x('name', 'eth0'), x('description', 'uplink'), x('enabled', 'true')),
      x('interface', x('name', 'eth1'), x('description', 'spare'), x('enabled', 'false'))),
    x('system', { xmlns: LAB_NS }, x('name', 'router1'), x('location', 'lab')),
  ];
}

/** Replies with the configuration for get-config, plus state for get; everything else is ok. */
export const handler: RpcHandler = (_rpc, { operation }) => {
  if (operation?.name === 'get-config') return { data: config() };
  if (operation?.name === 'get') return { data: [...config(), x('uptime', { xmlns: LAB_NS }, '42')] };
  return 'ok';
};

export const PROFILE = {
  id: 'lab-test',
  description: 'The test lab device',
  status: 'unverified',
  match: { anyModule: ['lab'] },
  quirks: { maxInFlight: 2 },
  workflow: { lock: true },
  paths: { systemName: '/lab:system/name', interfaces: '/ietf-interfaces:interfaces/interface' },
  operations: {
    show: {
      description: 'Run a show command',
      mutates: false,
      params: { command: 'string' },
      request: '<show xmlns="urn:example:lab"><command>{{command}}</command></show>',
      result: { path: 'output', as: 'text' },
    },
    reboot: { description: 'Reboot the device', request: '<reboot xmlns="urn:example:lab"/>' },
  },
};

export interface PathFixture extends Fixture {
  /** The directory holding PROFILE, for a target's profilesDir. */
  readonly profilesDir: string;
}

/**
 * Targets:
 * - router1 names the lab-test profile and is read-only;
 * - lab1 names it and is writable;
 * - auto1 auto-detects it;
 * - plain1 finds no profile.
 */
export async function pathFixture(options: { caps?: readonly string[]; handler?: RpcHandler; profile?: object } = {}): Promise<PathFixture> {
  const f = await fixture({ fake: { capabilities: [...(options.caps ?? CAPS)], handler: options.handler ?? handler } });
  const profilesDir = f.profile(options.profile ?? PROFILE);
  const id = ((options.profile ?? PROFILE) as { id: string }).id;
  f.home.targets({
    router1: f.target({ readOnly: true, profile: id, profilesDir }),
    lab1: f.target({ profile: id, profilesDir }),
    auto1: f.target({ profilesDir }),
    plain1: f.target(),
  });
  return Object.assign(f, { profilesDir });
}
