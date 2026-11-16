/**
 * How notifications and subscription updates are shown (docs/cli.md §6.3,
 * OPS-09, OPS-15): one line for the prompt and `notifications`, and plain
 * data for `--json`.
 */

import { toObject, type Notification } from '@node-net/netconf/core';
import { decodeBaseNotification } from '@node-net/netconf/operations/base-notifications';
import type { DynamicSubscription, SubscriptionEnd, SubscriptionUpdate } from '@node-net/netconf/operations/subscriptions';
import { shownValue } from './safe.js';

/** Something to show above the prompt or to `notifications --follow`: a line, and the same as data. */
export interface ShownItem {
  readonly line: string;
  readonly json: object;
}

/** What a subscription made of a notification, kept for `notifications` (OPS-15). */
export interface SubscriptionPart {
  readonly subscription: number;
  /** `suspended · insufficient-resources` */
  readonly what: string;
  /** The decoded update, as data; absent for a notification the library doesn't turn into one (`modified`). */
  readonly update?: object;
}

/** `notification 3 · 2026-11-07T10:00:00Z · netconf-config-change` */
export function notificationLine(n: Notification, number: number, part?: SubscriptionPart): string {
  if (part !== undefined) return `notification ${number} · ${shownValue(n.eventTime)} · subscription ${part.subscription} · ${part.what}`;
  return `notification ${number} · ${n.eventTime} · ${n.event?.name ?? '(no content)'}`;
}

/**
 * A notification as plain data, with the library's typed decoding for RFC 6470
 * base notifications. A base notification that breaks its YANG module keeps its raw
 * content and says why it could not be decoded. One a subscription read
 * carries the subscription's id and its decoded update.
 */
export function notificationJson(n: Notification, number: number, part?: SubscriptionPart): object {
  let decoded: object | undefined;
  let decodeError: string | undefined;
  try {
    decoded = decodeBaseNotification(n);
  } catch (e) {
    decodeError = e instanceof Error ? e.message : String(e);
  }
  return {
    number,
    eventTime: n.eventTime,
    event: n.event?.name ?? null,
    namespace: n.event?.ns ?? null,
    content: n.event === undefined ? null : toObject(n.event),
    ...(decoded === undefined ? {} : { decoded }),
    ...(decodeError === undefined ? {} : { decodeError }),
    ...(part === undefined ? {} : { subscription: part.subscription, ...(part.update === undefined ? {} : { update: part.update }) }),
  };
}

/** The line and data for a notification. */
export function notificationItem(n: Notification, number: number, part?: SubscriptionPart): ShownItem {
  return { line: notificationLine(n, number, part), json: notificationJson(n, number, part) };
}

const incomplete = (u: { readonly incomplete: boolean }): string => (u.incomplete ? ' · incomplete' : '');

/** The names of an element's children, each once, in order. */
function childNames(names: readonly string[]): string {
  const unique = [...new Set(names)];
  return unique.length === 0 ? '(empty)' : unique.map(shownValue).join(', ');
}

/** What a subscription update is, for its line: `event · link-down`, `suspended · insufficient-resources`, … */
export function updateWhat(u: SubscriptionUpdate): string {
  switch (u.type) {
    case 'event':
      return `event · ${u.notification.event?.name ?? '(no content)'}`;
    case 'push-update':
      return `push-update · ${childNames(u.contents.elements.map((e) => e.name))}${incomplete(u)}`;
    case 'push-change-update':
      return `push-change-update · ${u.patch.edits.length} edit${u.patch.edits.length === 1 ? '' : 's'}${incomplete(u)}`;
    case 'suspended':
      return `suspended · ${shownValue(reasonLabel(u.reason))}`;
    case 'resumed':
      return 'resumed';
  }
}

/** A subscription update as data, for `--json`. */
export function updateJson(u: SubscriptionUpdate): object {
  switch (u.type) {
    case 'event':
      return { type: u.type, eventTime: u.eventTime };
    case 'push-update':
      return { type: u.type, eventTime: u.eventTime, incomplete: u.incomplete, contents: toObject(u.contents) };
    case 'push-change-update':
      return {
        type: u.type,
        eventTime: u.eventTime,
        incomplete: u.incomplete,
        edits: u.patch.edits.map((e) => ({
          editId: e.editId,
          operation: e.operation,
          target: e.target,
          ...(e.value.length > 0 ? { value: e.value.map((v) => ({ [v.name]: toObject(v) })) } : {}),
        })),
      };
    case 'suspended':
      return { type: u.type, eventTime: u.eventTime, reason: u.reason };
    case 'resumed':
      return { type: u.type, eventTime: u.eventTime };
  }
}

/** `subscription 7 ended · terminated (no-such-subscription)` */
export function endItem(id: number, end: SubscriptionEnd): ShownItem {
  const how = end.reason === 'terminated' && end.identity !== undefined ? `terminated (${shownValue(reasonLabel(end.identity))})` : end.reason;
  return { line: `subscription ${id} ended · ${how}`, json: { subscription: id, ended: end.reason, ...(end.identity !== undefined ? { identity: end.identity } : {}) } };
}

/** A reason identity as shown: one of the subscription modules' own by name (`insufficient-resources`), another with its module. */
function reasonLabel(identity: string): string {
  for (const module of ['ietf-subscribed-notifications:', 'ietf-yang-push:']) if (identity.startsWith(module)) return identity.slice(module.length);
  return identity;
}

/** A datastore identity as shown: a standard one by name (`operational`), another with its module. */
function datastoreLabel(identity: string | undefined): string {
  if (identity === undefined) return '?';
  return identity.startsWith('ietf-datastores:') ? identity.slice('ietf-datastores:'.length) : identity;
}

/** What a subscription subscribes to: `stream NETCONF`, `datastore operational · on-change`, `… · replay`. */
export function subscriptionWhat(sub: DynamicSubscription): string {
  const parts =
    sub.kind === 'stream'
      ? [`stream ${shownValue(sub.stream ?? '?')}`]
      : [`datastore ${shownValue(datastoreLabel(sub.datastore))}`, ...(sub.trigger !== undefined ? [sub.trigger] : [])];
  if (sub.replay) parts.push('replay');
  return parts.join(' · ');
}

/** A subscription as data, for `establish-subscription --json`. */
export function subscriptionJson(sub: DynamicSubscription): object {
  return {
    id: sub.id,
    kind: sub.kind,
    ...(sub.stream !== undefined ? { stream: sub.stream } : {}),
    ...(sub.datastore !== undefined ? { datastore: sub.datastore } : {}),
    ...(sub.trigger !== undefined ? { trigger: sub.trigger } : {}),
    replay: sub.replay,
  };
}
