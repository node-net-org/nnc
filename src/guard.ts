/**
 * The read-only guard (docs/cli.md §9).
 *
 * On a read-only session, anything that could change device state is refused
 * before it is sent. The decision comes from the library's operation
 * descriptors (`mutates`), not from a list kept here, so a new extension
 * or device profile is covered without CLI changes. Whatever isn't known to
 * be harmless counts as a write: the guard fails closed.
 */

import type { OperationDescriptor, XmlElement } from '@node-net/netconf/core';
import { CliError, EXIT } from './errors.js';
import type { ActiveSession } from './sessions/active.js';

function refuse(message: string): never {
  throw new CliError(`${message}; nothing was sent`, EXIT.readOnly);
}

/** Refuse a described operation that changes state, on a read-only session. */
export function guardOperation(session: ActiveSession, descriptor: OperationDescriptor, command: string): void {
  if (!session.readOnly || !descriptor.mutates) return;
  if (descriptor.device !== undefined) {
    refuse(
      `${command}: refused: ${session.name} is read-only, and profile ${descriptor.device} doesn't mark ${descriptor.name} as read-only. ` +
        `If it doesn't change state, mark it "mutates": false in the profile`,
    );
  }
  refuse(`${command}: refused: ${session.name} is read-only and ${descriptor.name} changes device state`);
}

/**
 * Refuse a content write (`set <path>`, `remove`) on a read-only session. A
 * content write always changes state, whatever workflow carries it, so there
 * is nothing to look up: it is refused before the path is even resolved.
 */
export function guardWrite(session: ActiveSession, command: string): void {
  if (session.readOnly) refuse(`${command}: refused: ${session.name} is read-only and ${command} changes device state`);
}

/**
 * Refuse an `rpc` body on a read-only session unless its root element is a
 * known operation that doesn't change state, or the target allows it by name.
 * Lookup is by local name and namespace, so a known name in another namespace
 * is treated as unknown.
 */
export function guardRpc(session: ActiveSession, body: XmlElement): void {
  if (!session.readOnly) return;
  // Only RPCs: an extension read (kind 'read') is a <get>, not an operation element, so its name proves nothing.
  const known = session.client.ops.list.find(
    (d) => d.device === undefined && d.kind !== 'read' && d.name === body.name && d.namespace === (body.ns ?? ''),
  );
  const command = `rpc <${body.name}>`;
  if (known !== undefined) {
    guardOperation(session, known, command);
    return;
  }
  if (session.target.allowRpcs?.includes(body.name) === true) return;
  refuse(
    `${command}: refused: ${session.name} is read-only and <${body.name}>${body.ns === undefined || body.ns === '' ? '' : ` (${body.ns})`} isn't known to be read-only. ` +
      `To allow it, describe it in the device profile with "mutates": false, or add "${body.name}" to the target's allowRpcs`,
  );
}

/** Refuse low-level sessions on read-only targets: the guard can't see what is typed in them. */
export function guardLowLevel(targetName: string, kind: 'framed' | 'raw'): never {
  throw new CliError(
    `connect --${kind}: refused: ${targetName} is read-only, and low-level sessions (framed, raw) aren't allowed on read-only targets; ` +
      'nothing was opened',
    EXIT.readOnly,
  );
}
