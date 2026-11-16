/**
 * The one open session (docs/cli.md §11). Every command reaches it through
 * `cli.session`, so named sessions later change this module and the prompt,
 * not the commands.
 */

import type { NetconfClient, Notification, PendingCommit } from '@node-net/netconf/core';
import type { QueuedChange } from '../commands/content.js';
import type { ShownItem } from '../render/notifications.js';
import type { SessionSubscriptions } from './subscriptions.js';
import type { Target } from '../targets.js';

/** The messages received in a session, newest last, for showing a reply exactly as received (docs/cli.md §6.6). */
export class MessageLog {
  private static readonly KEEP = 50;
  private readonly texts: string[] = [];
  /** How many messages have been received in all. */
  count = 0;

  add(text: string): void {
    this.texts.push(text);
    if (this.texts.length > MessageLog.KEEP) this.texts.shift();
    this.count++;
  }

  /** The last <rpc-reply> received after the first `since` messages, if one was. */
  lastReplySince(since: number): string | undefined {
    const fresh = this.texts.slice(Math.max(0, this.texts.length - (this.count - since)));
    return fresh.reverse().find((t) => /^\s*(<\?xml[^>]*\?>\s*)?<([\w.-]+:)?rpc-reply[\s>]/.test(t));
  }
}

export interface ActiveSession {
  readonly kind: 'client';
  /** Target name, or the host for an ad hoc connection. */
  readonly name: string;
  readonly target: Target;
  readonly host: string;
  readonly port: number;
  /** `jump1:22` when connected through a jump host. */
  readonly via: string | undefined;
  /** How the session reached the device. */
  readonly transport: 'ssh' | 'tls' | 'sim';
  /** The device called us (`listen`, RFC 8071); `host` and `port` are then where it called from. */
  readonly calledHome: boolean;
  readonly client: NetconfClient;
  readonly readOnly: boolean;
  /** Host-key (SSH) or server-certificate (TLS) verification was turned off for this session. */
  readonly insecure: boolean;
  /** SHA256 fingerprint of the device's host key (SSH) or certificate (TLS). */
  readonly fingerprint: string | undefined;
  /** The server's hello, exactly as received. */
  readonly rawHello: string | undefined;
  /** Messages received, for `--raw` and `show-last --raw`. */
  readonly received: MessageLog;
  /** Profile id, or undefined when none is in use. */
  readonly profile: string | undefined;
  /** How the profile was chosen. */
  readonly profileSource: 'named' | 'detected' | 'none';
  /** The profiles auto-detection considered, by id (none when the target names its profile). */
  readonly considered: readonly string[];
  readonly connectedAt: Date;
  /** Set while `disconnect` is closing the session, so its close isn't reported as the server's. */
  disconnecting: boolean;
  /** Set when the close-session reply didn't arrive in time. */
  closeReplyMissed: boolean;
  /** Datastores this session has locked with the lock command. */
  readonly locks: Set<string>;
  /** A confirmed commit this session started that hasn't been confirmed or cancelled yet. */
  confirmedCommit: { readonly rollbackAt: Date; readonly persist: string | undefined } | undefined;
  /** An open transaction (`begin`): the changes `set` and `remove` have queued. */
  transaction: { readonly changes: QueuedChange[] } | undefined;
  /** The confirmed commit `apply --confirmed` made, until it is confirmed, reverted or rolled back. */
  pending: PendingCommit | undefined;
  /** Every notification received in this session, oldest first. */
  readonly notifications: Notification[];
  /** While `notifications --follow` runs: receives each notification, subscription update and end instead of the notice. */
  readonly followers: Set<(item: ShownItem) => void>;
  /** Dynamic subscriptions this session reads through the library (OPS-15). */
  readonly subscriptions: SessionSubscriptions;
}
