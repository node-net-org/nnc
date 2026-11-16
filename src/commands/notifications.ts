/**
 * Notifications the device sends during a client session (docs/cli.md §6.3).
 * The session keeps every one received; each is shown above the prompt as it
 * arrives, unless `notifications --follow` is printing them. Subscription
 * updates and ends (OPS-15) are shown the same way.
 */

import { CliError } from '../errors.js';
import { notificationItem, type ShownItem } from '../render/notifications.js';
import { toJson } from '../render/safe.js';
import type { Command } from './registry.js';

export const notificationsCommand: Command = {
  name: 'notifications',
  group: 'messages',
  example: 'notifications --follow',
  summary: 'List the notifications received in this session (--follow: print new ones until Ctrl-C)',
  args: [],
  options: {
    follow: { type: 'boolean', description: 'print new notifications as they arrive, until Ctrl-C' },
    json: { type: 'boolean', description: 'print as JSON (one object per line with --follow)' },
  },
  kinds: ['client'],
  async run(cli, args, signal) {
    const s = cli.session;
    if (s === undefined) throw new CliError('not connected');
    const json = args.options['json'] === true;

    if (args.options['follow'] !== true) {
      // A notification a subscription read is listed as that subscription's update (OPS-15).
      const all = s.notifications.map((n, i) => notificationItem(n, i + 1, s.subscriptions.partOf(n)));
      if (json) return { text: toJson(all.map((item) => item.json), 2) };
      if (all.length === 0) return { text: '(no notifications)' };
      return { text: all.map((item) => item.line).join('\n') };
    }

    // Follow until Ctrl-C (the command's signal) or the session ends. Printed as they
    // arrive; with `> path`, collected and written to the file when the follow ends.
    const collected: string[] = [];
    const redirecting = cli.redirecting;
    const print = (item: ShownItem): void => {
      const line = json ? toJson(item.json) : item.line;
      if (redirecting) collected.push(line);
      else cli.io.out(`${line}\n`);
    };
    await new Promise<void>((resolve) => {
      const stop = (): void => {
        s.followers.delete(print);
        signal.removeEventListener('abort', stop);
        offClosed();
        resolve();
      };
      const offClosed = s.client.session.on('closed', stop);
      s.followers.add(print);
      if (signal.aborted) stop();
      else signal.addEventListener('abort', stop, { once: true });
    });
    return redirecting ? { raw: collected.map((l) => `${l}\n`).join('') } : undefined;
  },
};
