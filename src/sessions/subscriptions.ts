/**
 * Dynamic subscriptions read through the library (RFC 8639, 8641; OPS-15).
 *
 * `establish-subscription` opens a `DynamicSubscription`, and nnc reads it in
 * the background for as long as it lives: its queue is bounded, so one left
 * unread would overflow and be deleted. Each update is shown as a line naming
 * the subscription and what the update is, and so is how it ended.
 *
 * The library routes each notification to its subscription and also emits it
 * as the session's plain `notification` event. So that a subscription's
 * updates aren't shown twice, a notification is matched to a subscription
 * when it arrives by the library's own routing rules: one in the
 * subscribed-notifications or YANG-Push namespace belongs to the subscription
 * its `<id>` names, and an event record (no id) to the session's one stream
 * subscription. While an establish waits for its reply, notifications those
 * rules would give it are held back, as the library holds them for it too.
 */

import type { NetconfClient, Notification } from '@node-net/netconf/core';
import {
  SUBSCRIBED_NOTIFICATIONS_NS,
  YANG_PUSH_NS,
  type DynamicSubscription,
  type EstablishOptions,
  type SubscriptionsOps,
} from '@node-net/netconf/operations/subscriptions';
import { endItem, notificationItem, updateJson, updateWhat, type ShownItem, type SubscriptionPart } from '../render/notifications.js';

/** Notifications the library turns into updates (shown by the reader) or into the subscription's end (shown when it ends). */
const READ_BY_SUBSCRIPTION = new Set(['subscription-suspended', 'subscription-resumed', 'push-update', 'push-change-update']);
const ENDING = new Set(['subscription-terminated', 'subscription-completed']);

export class SessionSubscriptions {
  /** What a subscription made of each notification it read, for `notifications` and `--json`. */
  private readonly parts = new WeakMap<Notification, SubscriptionPart>();
  private readonly numbers = new WeakMap<Notification, number>();
  /** Establishes waiting for their reply, by kind. */
  private readonly establishing = { stream: 0, datastore: 0 };
  /** Notifications held back while an establish waits, in arrival order. */
  private held: { readonly n: Notification; readonly number: number }[] = [];

  constructor(
    private readonly client: NetconfClient,
    private readonly show: (item: ShownItem) => void,
  ) {}

  private get ops(): SubscriptionsOps | undefined {
    return (this.client.ops as { readonly subscriptions?: SubscriptionsOps }).subscriptions;
  }

  /** The subscriptions open on this session, by id. */
  get active(): ReadonlyMap<number, DynamicSubscription> {
    return this.ops?.active ?? new Map();
  }

  /** What a subscription made of a notification, if one read it. */
  partOf(n: Notification): SubscriptionPart | undefined {
    return this.parts.get(n);
  }

  /** A notification has arrived (it is notification `number` of the session): show it, unless a subscription will. */
  received(n: Notification, number: number): void {
    this.numbers.set(n, number);
    const owner = this.owner(n);
    if (owner === 'held') this.held.push({ n, number });
    else if (owner === undefined) this.show(notificationItem(n, number));
    else this.claimed(n, number, owner);
  }

  /**
   * `establish-subscription`: open it through the library, and read it until it ends.
   * Notifications that arrive before the reply are shown once the outcome is known.
   */
  async establish(options: EstablishOptions & Readonly<Record<string, unknown>>): Promise<DynamicSubscription> {
    const ops = this.ops;
    if (ops === undefined) throw new TypeError('establish-subscription: the subscriptions extension is not enabled');
    const kind = 'datastore' in options && options.datastore !== undefined ? 'datastore' : 'stream';
    this.establishing[kind]++;
    let sub: DynamicSubscription | undefined;
    try {
      sub = await ops.establish(options);
      return sub;
    } finally {
      this.establishing[kind]--;
      if (sub !== undefined) this.read(sub);
      this.release();
    }
  }

  /** Which subscription a notification belongs to, by the library's routing; `held` while an establish may claim it. */
  private owner(n: Notification): number | 'held' | undefined {
    const ev = n.event;
    const waiting = this.establishing.stream + this.establishing.datastore > 0;
    if (ev !== undefined && (ev.ns === SUBSCRIBED_NOTIFICATIONS_NS || ev.ns === YANG_PUSH_NS)) {
      const text = ev.child('id', ev.ns)?.text().trim();
      const id = text !== undefined && /^\d+$/.test(text) ? Number(text) : undefined;
      if (id !== undefined && this.active.has(id)) return id;
      return waiting ? 'held' : undefined;
    }
    // An event record carries no id: it belongs to the session's one stream subscription.
    for (const sub of this.active.values()) if (sub.kind === 'stream') return sub.id;
    return this.establishing.stream > 0 ? 'held' : undefined;
  }

  /**
   * A notification a subscription owns. Its reader shows the updates, and its end
   * line says how it ended; the rest (modified, replay-completed) are shown here.
   */
  private claimed(n: Notification, number: number, id: number): void {
    const name = n.event?.ns === SUBSCRIBED_NOTIFICATIONS_NS || n.event?.ns === YANG_PUSH_NS ? n.event.name : undefined;
    if (name === undefined || READ_BY_SUBSCRIPTION.has(name)) return;
    // Kept for `notifications`; an end is shown by its end line instead.
    const part: SubscriptionPart = { subscription: id, what: name.replace(/^subscription-/, '') };
    this.parts.set(n, part);
    if (!ENDING.has(name)) this.show(notificationItem(n, number, part));
  }

  /** After an establish: what was held back goes to its subscription, or is shown as it is. */
  private release(): void {
    if (this.establishing.stream + this.establishing.datastore > 0) return;
    const held = this.held;
    this.held = [];
    for (const { n, number } of held) {
      const owner = this.owner(n);
      if (owner === undefined || owner === 'held') this.show(notificationItem(n, number));
      else this.claimed(n, number, owner);
    }
  }

  /**
   * Read a subscription until it ends, showing each update, then how it ended.
   * Never breaks out: that would delete the subscription. A session closing
   * ends it quietly, since the session's own message says so.
   */
  private read(sub: DynamicSubscription): void {
    void (async () => {
      try {
        for await (const update of sub) {
          try {
            const part: SubscriptionPart = { subscription: sub.id, what: updateWhat(update), update: updateJson(update) };
            this.parts.set(update.notification, part);
            this.show(notificationItem(update.notification, this.numbers.get(update.notification) ?? 0, part));
          } catch {
            // A line that can't be formatted must not end the loop, which would delete the subscription.
          }
        }
      } catch {
        // Overflow (or any failure reading) ends the subscription; `ended` says how.
      }
      const end = await sub.ended;
      if (end.reason !== 'closed') this.show(endItem(sub.id, end));
    })();
  }
}
