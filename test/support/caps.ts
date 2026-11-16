/** Capability URIs used by the operation tests. */
export const BASE10 = 'urn:ietf:params:netconf:base:1.0';
export const BASE11 = 'urn:ietf:params:netconf:base:1.1';
const cap = (name: string): string => `urn:ietf:params:netconf:capability:${name}`;
export const CANDIDATE = cap('candidate:1.0');
export const STARTUP = cap('startup:1.0');
export const WRITABLE_RUNNING = cap('writable-running:1.0');
export const VALIDATE11 = cap('validate:1.1');
export const CONFIRMED_COMMIT11 = cap('confirmed-commit:1.1');
export const ROLLBACK = cap('rollback-on-error:1.0');
export const XPATH = cap('xpath:1.0');
export const LAB_MODULE = 'urn:example:lab?module=lab&revision=2024-01-01';

/** A device with everything the base operations can use. */
export const FULL = [BASE10, BASE11, CANDIDATE, STARTUP, WRITABLE_RUNNING, VALIDATE11, CONFIRMED_COMMIT11, ROLLBACK, XPATH, LAB_MODULE];
/** A device with only the base capabilities. */
export const BARE = [BASE10, BASE11, LAB_MODULE];
