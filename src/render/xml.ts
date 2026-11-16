/**
 * Pretty-printed XML (docs/cli.md §6.6).
 *
 * The library's indented serialisation: an element whose content is only text
 * stays on one line, and mixed content is left as it is. On top of that, DEL,
 * C1 and bidi controls become character references (LANG-13), so the output is
 * safe to write to a terminal.
 */

import { serializeXml, type XmlElement } from '@node-net/netconf/core';
import { xmlSafe } from './safe.js';

export function prettyXml(element: XmlElement, indent = '  '): string {
  return xmlSafe(serializeXml(element, { indent }));
}
