# @node-net/nnc: design

Status: draft for review, revision 1, 2026-11-07. Companion to [net-netconf-design.md](https://github.com/node-net-org/netconf/blob/main/docs/net-netconf-design.md), whose layer model (§3) this document follows.

## 1. What it is for

`nnc` (the `@node-net/nnc` package) is an interactive NETCONF client for people. It connects to one device, opens a session, and lets you send operations and watch what crosses the wire. It exists to **observe the NETCONF protocol**: to see how a device answers, to reproduce its defects, and to check that the library and a device profile behave correctly. It is a separate package from the `@node-net/netconf` library and uses only that library's public API.

**Goals**

- **Show the protocol.** You can see each layer (bytes, framed messages, XML) during any session.
- **Choose the depth when you connect.** A normal session is a full `NetconfClient`. A low-level session gives you the framing or the raw channel and leaves the protocol to you.
- **Use one command language.** It is our own small language, shared by the interactive prompt, `-c` one-liners and script files.
- **Build commands from data.** Commands, help, completion and the read-only guard come from operation descriptors, so a new extension or device profile appears in the CLI without CLI code (§7).
- **Be safe on production devices.** It refuses writes to read-only targets, keeps credentials out of commands and history, and verifies host keys by default.

**Non-goals**

- A JavaScript REPL, or any way to run JavaScript from the prompt.
- More than one session at a time (for now; see §14).
- Configuration management: templating, diffs, rollbacks across devices. Use the library for that.
- YANG validation, or any YANG parsing at runtime.

## 2. Packaging: its own package

### 2.1 Layout

nnc is one package in its own repository, [node-net-org/nnc](https://github.com/node-net-org/nnc):

```
nnc/
├── package.json            "name": "@node-net/nnc"
│                           "bin": { "nnc": "./dist/main.js" }
│                           "dependencies": { "@node-net/netconf": "^0.1.0" }
├── tsconfig.json           the build (src/ to dist/)
├── .dependency-cruiser.cjs the public-API rule
├── src/
└── test/                   with test/fixtures: test-only TLS certificates and YANG modules
```

### 2.2 How it works

- **Imports go through the public API.** nnc writes `import { connect, ssh } from '@node-net/netconf'`, like any other application. The library's `exports` map stops deep imports such as `@node-net/netconf/dist/transport/framing/...`, so Node itself holds nnc to the public API. `.dependency-cruiser.cjs` enforces the rest (§2.6), and runs from `check`.
- **A released library.** `@node-net/netconf` comes from npm, at a version the range accepts. A change nnc needs in the library is released there first. In a workspace with both checkouts, npm links them, so a change can be tried across both before the release.
- **Publishing.** `prepublishOnly` (`scripts/check-published-deps.mjs`) refuses to publish while the `@node-net/netconf` version nnc depends on isn't on npm. The library is 0.1.x, not 0.0.x, so `^0.1.0` admits its patch releases (on 0.0.x a caret means one exact version).

### 2.3 Its own repository

nnc began as a package in a workspace beside the library (§2.4), so the two could change together while the library's API settled. On 2026-11-16 each package moved to its own repository: nnc is [node-net-org/nnc](https://github.com/node-net-org/nnc), published as `@node-net/nnc`, and depends on a released `@node-net/netconf` from npm.

### 2.4 Why a workspace

| | `bin` in `@node-net/netconf` | **Workspace package** | Separate repository |
|---|---|---|---|
| Library users download CLI code | yes | no | no |
| CLI dependencies become library dependencies | yes | no | no |
| Library and CLI change in one commit | yes | yes | no |
| CLI held to the public API | by convention only | by Node (`exports`) | by Node (`exports`) |
| Independent versions | no | yes | yes |

A workspace kept the clean boundary of a separate repository while the library's API was still changing; the split then made it one (§2.3). The CLI also tests design §3.2's rule that third-party code gets exactly what `@node-net/netconf` exports: anything the CLI needs and can't import is a gap in the public API.

### 2.5 Dependencies

The CLI aims for **no runtime dependencies** beyond `@node-net/netconf`. Node has what it needs:

| Need | Node module |
|------|-------------|
| Prompt, line editing, history, tab completion | `node:readline/promises` |
| Command-line arguments | `node:util` `parseArgs` |
| Colour | `node:util` `styleText` (it respects `NO_COLOR` and non-TTY output) |
| Paging | spawn `$PAGER` (default `less -R`) |
| Editing XML | spawn `$EDITOR` on a temporary file |

### 2.6 Hosts: nnc in any JavaScript runtime

nnc runs on a **host** (`src/host.ts`, `NncHost`), which supplies everything it takes from its environment. The rest of the CLI (the command language, sessions, trace and output) never touches Node.js, so the same code runs in the `nnc` command and in a browser terminal without two copies drifting apart.

| The host gives | `nnc` (the Node host, `src/node/`) | Absent means |
|---|---|---|
| `terminal`: output, whether each stream is a (colour) terminal, the line editor (prompt, secrets, notices, Ctrl-C), interrupts, exit | standard streams, readline with Ctrl-R search, SIGINT | required |
| `terminal.page`, `terminal.edit` | `$PAGER`, `$EDITOR` on a temporary file | results print unpaged; `--edit` fails: there is no editor here |
| `files`: read (targets, `@file`, `send-file`), write (`>` and `>>`), list (path completion), append-only logs (trace files) | the file system | required (a host may keep files in memory) |
| `transports.reach`: how a target is reached | SSH, TLS | required |
| `transports.listen`, `transports.checkHostKey` | call home; host-key pins checked when the targets file is read | `listen` fails: not available here |
| `history` | `~/.config/net-netconf/history` | `history` says it isn't kept here |
| `connect` | the root `@node-net/netconf` `connect()`, which reads YANG module directories | `@node-net/netconf/core`'s, which refuses them |
| `env`, `homeDir`, `username`, `loadProfiles` | `process.env`, the home directory, the login name, profile directories | `loadProfiles` absent: `profilesDir` can't be used |

- **Entries.** `@node-net/nnc/core` (`src/core.ts`) exports `runNnc` (one run: connect first, then the prompt, `-c` commands, a script, or commands read from the input), `Cli`, `createRegistry`, the host types and `simTransports`. `src/main.ts` parses the command line and runs `runNnc` on `createNodeHost()`.
- **Bytes.** Raw sessions and the trace work on `Uint8Array` (`src/bytes.ts`), never `Buffer`.
- **Guardrails.** Only `src/main.ts` and `src/node/` are Node-only. The layer check (`.dependency-cruiser.cjs`) and ESLint refuse a Node built-in, a Node-only global, ssh2, or the Node entries of @node-net/netconf and @node-net/yang anywhere else, and `npm run portable:check` bundles `@node-net/nnc/core` for the browser and runs `trace frames`, `connect`, `status`, `capabilities` and `get-config` against a simulated device with only web-platform globals.
- **Simulated devices.** `simTransports(devices, fallback?)` reaches `"transport": "sim"` targets (§8) through devices the host provides by name, each a function returning a library `ConnectionFactory` (a `FakeServer`'s `transport()`, or a simulator in the page). Other targets go to `fallback`, or fail saying only simulated devices can be reached here.

## 3. Library exports the CLI needs

These are added to the library's public API. Other consumers will want them too.

| Export | Why | Today |
|--------|-----|-------|
| `openChannel`, `MessageChannel`, `ChannelHandler`, `FramingMode` | Framed sessions (§4) | In the `transport/` barrel, but not in `src/index.ts` |
| Operation descriptors for the base operations (`BASE_OPERATIONS`) | Commands built from data (§7) | Not present |
| `OperationSpec.mutates` | Read-only guard for device operations (§9) | Not present |
| `FrameDecoder`, `DecoderOptions` | `trace frames` and `trace xml` decode a copy of each direction (§5) | In the `framing/` module, but not in `src/index.ts` |

## 4. Session kinds

You choose how deep you work when you connect, and the session keeps that kind until you disconnect. You can't switch kinds mid-session. Once a `Session` has done the hello, it owns the channel's state: the framing mode, the `message-id` counter and the table of requests waiting for replies. Bytes written underneath it would break those invariants, and the failures would look like library bugs.

| Kind | Connect with | The CLI handles | You handle | You see |
|------|--------------|-----------------|------------|---------|
| **Client** (default) | `connect <target>` | Everything: a full `NetconfClient` with its device profile | Operations | Replies, errors, warnings, notifications |
| **Framed** | `connect <target> --framed` | SSH or TLS, and framing (`openChannel`) | The hello, `message-id`s, `<rpc>` wrappers, switching to chunked framing | Each whole received message |
| **Raw** | `connect <target> --raw` | SSH and the `netconf` subsystem, or TLS (`Connection`) | Everything, framing included | The bytes received |

Typical uses:

- **Client:** everyday use, and checking a device profile.
- **Framed:** testing the hello and capability negotiation, sending a `message-id` of your choice, sending messages out of order, pipelining by hand.
- **Raw:** framing defects, malformed chunks, oversized messages, messages that aren't well-formed XML, and reproducing defects such as the 7210's invalid XML characters (`invalidXmlChars`, design §7).

The kind is always visible, because some commands (`hello`, `send`, `output`) do different things in different kinds. The connect message says which kind was opened and what you drive; the prompt shows the kind and its state; commands that act differently by kind say which way they acted (`sent 312 bytes (framed, eom)`), and `help` describes the current kind's behaviour:

```
nnc> connect router1
connected to router1 (10.1.2.3:830) · session-id 57 · base:1.0 · profile nokia-7210-sas · read-only
nnc router1> disconnect
nnc> connect lab1 --framed
opened a framed session to lab1 (10.1.2.9:830) · end-of-message framing · nothing sent: you send the hello (hello, send, framing, show; help lists them)
nnc lab1 [framed eom]> framing chunked
nnc lab1 [framed chunked]> disconnect
nnc> connect lab1 --raw
nnc lab1 [raw]> eof
nnc lab1 [raw eof]>
```

The kind mark is cyan for framed and magenta for raw on a colour terminal. Only one session of any kind is open at a time. Host keys, certificates, jump hosts and passwords work the same way in every kind.

**Call home.** A device behind NAT or a firewall that only allows outbound connections can call us instead (RFC 8071). `listen <target>` listens on port 4334 for an SSH target or 4335 for a TLS target (all interfaces; `--port` and `--address` change that) and waits. Only the TCP connection is reversed: nnc is still the SSH or TLS client and the NETCONF client, and the call becomes a client session exactly as `connect <target>` would make it, with the same profile choice, read-only rule, trace, hello capture and commands.

A caller is taken only if it proves it is the target, with the checks `connect` makes: over SSH, its host key must match the target's pinned `hostKey`, or else be the one the target's known_hosts file lists for the target's host and port (or the target's `hostKey` is `insecure-accept-any`, with the usual warning); over TLS, its certificate must pass every check the target gives, as a server's must for `connect`: match its `fingerprint`, and with a `ca`, chain to it and name its host (or `serverName`); or the target is `insecure`. Its address is never trusted. nnc asks a calling SSH device for a host key of a type known_hosts (or a pin of key lines) holds for it, as `connect` does. A caller refused by a pin is reported with `; not the target's pinned hostKey`. Any other caller is refused before credentials are sent, and listening goes on:

```
nnc> listen router1
listening for router1 on 0.0.0.0:4334 (ssh); Ctrl-C stops waiting
refused a call from 192.0.2.9:50122: unknown device (SHA256:Qx…); not the host key /home/you/.ssh/known_hosts lists for router1:830
router1 called home from 192.0.2.7:41234 · session-id 12 · base:1.1 · profile nokia-7210-sas
nnc router1>
```

Credentials are gathered before listening, so a password prompt never holds up a call. A target with `hostKey: insecure-accept-any` (or TLS `insecure`) takes the first device that calls, and an SSH one gets the target's credentials, so nnc warns about that before it listens; anyone who can reach the port can call, so give `--address` to listen on one interface. Each call is watched on its own, so a call that fails leaves nothing in the hello, messages or trace of the session taken. A target with a jump host is refused, since a device calling home connects straight to us. Ctrl-C or `--timeout` stops waiting with nothing opened. `status` shows the session's host as the address it called from, marked `(called home)`.

## 5. Watching the layers

Tracing works in **every** session kind. It only watches; it never changes what is sent.

```
trace bytes     bytes on the channel, in both directions, ]]>]]> and #n chunk headers included
trace frames    whole messages as strings, after framing is removed
trace xml       each message as pretty-printed XML
trace off
```

Levels can be combined (`trace bytes xml`), and naming levels replaces the ones that were on. A bare `trace` shows the settings. Settings carry over from one session to the next, and can be set before connecting.

Each entry starts with the direction (`>>` sent, `<<` received), the time to the millisecond, the level and the size in bytes:

```
>> 10:42:07.311 bytes 174 B: \n#164\n<?xml version="1.0" encoding="UTF-8"?><rpc ... message-id="1"><get/></rpc>\n##\n
<< 10:42:07.315 frames 129 B chunked
<?xml version="1.0" encoding="UTF-8"?><rpc-reply ... message-id="1"><ok/></rpc-reply>
<< 10:42:07.315 xml 129 B rpc-reply message-id=1
<rpc-reply xmlns="urn:ietf:params:xml:ns:netconf:base:1.0" message-id="1">
  <ok/>
</rpc-reply>
```

A bytes entry is one line: `\n`, `\r`, `\t` and `\\` are escaped, and control bytes and bytes that aren't valid UTF-8 are shown as `\xHH`. A frames entry says whether the message was `eom` or `chunked` framed. A framing error becomes an entry with the bytes where it was found, and frames and xml stop for that direction. An xml entry that isn't well-formed shows the parse error (with line and column) and the text as received. On a colour terminal, xml entries are coloured (`NO_COLOR` turns this off, `FORCE_COLOR` turns it on).

Entries go to standard error, so they never mix with results. `trace --file <path>` also appends them to a file, without colour, starting each session with a `# nnc trace · <target> · <time>` line; `--quiet` writes them only to the file. `trace off`, `exit` and the end of a script close the file.

**How it works.** `connect()` and `openChannel()` take a `Connection`. The CLI wraps the SSH `Connection` in a **recording connection**: a `Connection` that passes every chunk through unchanged and shows it to the trace on the way. No library change is needed for this. The `frames` and `xml` levels feed a copy of each direction into their own `FrameDecoder` (the library's public decoder), so they show exactly what was on the wire, not what the library chose to log. The CLI follows the session's switch to chunked framing itself: once both hellos offer `base:1.1`. In a framed session it follows the `framing chunked` command instead; in a raw session it keeps guessing from the hellos.

**Secrets.** Traces hide secrets by default, using `redactXml`'s rule for which element names are secret: the text inside such an element becomes `***`. The bytes level can't wait for whole messages, so it redacts as the bytes arrive. Its scanner keeps its place between chunks and follows the framing itself, so a secret split across reads or by a chunk header is still hidden. A bytes entry that had something replaced is marked `(redacted)`, since its byte count is the count on the wire. If the bytes level can no longer follow the framing, it hides the rest of that direction rather than show what it can't check. Redaction applies only to the trace; what is sent is unchanged. `trace --no-redact` turns it off, and the prompt shows `[no-redact]` until `trace --redact`.

## 6. The command language

### 6.1 Syntax

A command is a name followed by arguments, separated by spaces, much like a shell:

```
get-config running --filter subtree @filters/system.xml
```

- **Positional arguments** come first, then **options** (`--name value`, or `--name` for a boolean).
- **Quoting:** `'...'` and `"..."` work as in a shell, and `\` escapes the next character. An unterminated quote is an error that says where the quote started. Inside `[...]` quotes are kept as typed, so a YANG path or XPath predicate needs no extra quoting: `read /ietf-interfaces:interfaces/interface[name="eth0"]`. A `(...)` that closes on the same line is kept as typed, quotes and spaces included, so a named path's arguments need none either: `read @route(10.0.0.0/8, "192.0.2.1")`. An unclosed `(` is an ordinary character.
- **Inline XML:** an argument that starts with `<` is XML and needs no quoting: quotes, `#` and `>` inside it are XML. It ends where its elements balance; elements separated only by spaces stay one argument (`--filter subtree <a/> <b/>`), and anything after it is read as usual, so `rpc <get/> --json > get.xml` works. If the XML isn't balanced at the end of a line, the prompt changes to `...>` and keeps reading until it is, so pasting multi-line XML runs the command once, after the closing tag. Ctrl-C at `...>` drops the whole command. Scripts follow the same rule; a script that ends inside XML fails with the parser's error.
- **Inline JSON:** an argument that starts with `{` is RFC 7951 JSON and needs no quoting: quotes, `#`, `[` and `>` inside it are JSON. It ends where its braces balance (braces inside JSON strings don't count) and may span lines, with the `...>` prompt as for XML. `edit-config` and `edit-data` take it (or `@file` whose text starts with `{`) as their configuration, and `get`, `get-config`, `get-data` and `compare` as `--filter subtree {…}`. nnc parses it and hands the object to the library, which converts it with the device's YANG schema; a mismatch prints the library's error with each data path.
- **Files:** `@path` in place of XML reads it from a file, in every command that takes XML (`rpc @get.xml`). `~` at the start of a path is the home directory.
- **Editor:** `--edit` opens `$EDITOR` (or `vi`) for the XML argument, starting from the last XML that command sent in this session, or an empty file. Leaving the editor without saving, with an empty file, or with an error cancels the command.
- **Output to a file:** `> path` at the end of a line writes the result there instead of to the screen, and `>> path` appends. A line names the file and the bytes written (a message: on standard error in scripts). If the file can't be written, the result is shown instead and the command fails; a failed command leaves the file alone.
- **Comments:** `#` to the end of the line, outside quotes and XML.

Commands that send a request take `--timeout <ms>`: `rpc`, every operation, `device` operations, and `connect` (connecting and the hello). A timeout names the command and the time, and the session stays open. `disconnect` waits for the target's close timeout. A device-profile operation can't be stopped inside the library, so on a timeout or Ctrl-C nnc stops waiting and says the operation may still complete.

**Ctrl-C** cancels the command in progress through its `AbortSignal`, prints `cancelled`, and leaves the session open; a reply that arrives later is discarded. In a script or `-c`, a cancelled command stops the run with exit code 130. At an empty prompt, Ctrl-C does nothing and Ctrl-D disconnects and exits. nnc treats `SIGINT` sent to the process (`kill -INT`) as Ctrl-C.

### 6.2 Commands in every session kind

| Command | What it does |
|---------|--------------|
| `connect <target> [--framed \| --raw]` | Open a session. Refused while one is open. `connect host[:port] --tls --cert … --key … --ca …` opens an ad hoc TLS session (§8). |
| `listen <target> [--port n] [--address a] [--read-only] [--timeout ms]` | Wait for the target's device to call home (RFC 8071) and open a client session on its call. See **Call home** in §4. |
| `disconnect` | Close the session. In a client session this sends `<close-session>` first. |
| `status` | Target, session kind, session-id, base version, framing mode, profile, read-only flag, time connected |
| `trace ...` | §5 |
| `output [xml \| json \| raw] [--page \| --no-page]` | The default output format and paging for the session (§6.6); with nothing, shows them |
| `show-last [--raw \| --json \| --xml]` | The last result or rpc-error again; `--raw` shows the reply exactly as received |
| `help [command \| layer]` | Commands available in this session kind, in sections by RFC 6241 layer, top-down: **Content layer · client.content** (path commands, then transaction commands in the order they're used), **Operations layer · client.ops** (base operations under `base · RFC 6241`, then each extension's under `<id> · <RFCs>`, taken from the extension's description, then those the device lacks capabilities for), **Messages layer · client.session** (hello, capabilities, rpc, notifications) and **Transport layer** (framed messages or bytes, in framed and raw sessions). Within Operations, after the extensions, the device profile's operations as `device <op>` under `device · profile <id>`. Then **Device profile** (`profile`), **Connection** and **nnc** (output, show-last, trace, `set on-error`, history, help, exit). `*` marks every command that changes state. `help content`, `help operations`, `help messages` and `help transport` show one section, or say which session kinds have it. With a command, its usage, options and an example |
| `history` | Commands from this and earlier sessions, numbered (the last 1000, in `~/.config/net-netconf/history`) |
| `targets` | Targets from the targets file (§8) |
| `set on-error continue \| stop` | Whether a script or `-c` commands go on after a failed command (§10) |
| `exit` | Disconnect and quit |

### 6.3 Client sessions

Commands are grouped by the layer they work at, as `help` lists them (§6.2).

**Messages layer**

| Command | What it does |
|---------|--------------|
| `hello` | The server's `<hello>`, as received |
| `capabilities` | The server's capability URIs, after the profile's corrections, marking those the profile added or removed. Its YANG modules and features are `modules`. |
| `rpc <xml>` | `Session.rpc()` with any operation body. The session adds the `<rpc>` wrapper and `message-id`. |
| `notifications [--follow] [--json]` | Notifications received so far, numbered, oldest first. One a dynamic subscription read is listed as that subscription's update (see Subscriptions below). `--follow` prints new ones, subscription updates and ends included, until Ctrl-C (and they are not also printed above the prompt). `--json` gives each as data, with RFC 6470 base notifications decoded, and a subscription's id and decoded update where one read it. |

**Operations layer**

| Command | Operation |
|---------|-----------|
| `get [--filter subtree <xml> \| --filter xpath <expr>]` | `<get>` |
| `get-config <datastore> [--filter ...]` | `<get-config>` |
| `edit-config <datastore> <xml> [--default-operation ...] [--test-option ...] [--error-option ...]` | `<edit-config>` |
| `copy-config <target> <source>` | `<copy-config>` |
| `delete-config <target>` | `<delete-config>` |
| `lock <datastore>` / `unlock <datastore>` | `<lock>` / `<unlock>` |
| `validate <source>` | `<validate>` |
| `commit [--confirmed] [--confirm-timeout <s>] [--persist <id>]` | `<commit>` |
| `cancel-commit [--persist-id <id>]` | `<cancel-commit>` |
| `discard-changes` | `<discard-changes>` |
| `kill-session <session-id>` | `<kill-session>` |

These come from the base operation descriptors (§7). Extensions add their own, such as `get-data` from `nmda`, when the device advertises the capabilities they need. Operations whose capabilities the device lacks don't appear in completion. If you type one anyway, it fails with the library's `CapabilityError`. Arguments that take a YANG path or an XPath (`--filter xpath`, `partial-lock` selects) resolve module names from the device's hello and, when a module isn't there, from its YANG library, which nnc reads once (a read-only `<get>`, so read-only targets allow it).

**Content layer**

| Command | What it does |
|---------|--------------|
| `read <path> [--datastore <ds>] [--state]` | `client.content.read()`: the elements at a path, from running by default; `--state` reads configuration and state with `<get>`. `(no data)` when nothing matches |
| `value <path>` | One leaf's value as plain text. `(not set)` (a message, so on standard error in scripts, exit 0) when absent; an error when the path matches several nodes |
| `set <path> <value>` | `client.content.set()`, following the profile's workflow. Each step is shown as it completes (`lock running: ok`, …), then `ok`. A failure names the step and shows its rpc-error, after the changes are discarded and the locks released. The same command name also takes `set on-error` (§10): a path starts with `/` or `@` |
| `remove <path>` | `client.content.remove()`, as `set` does; removing a node that doesn't exist succeeds |
| `resolve <path>` | How a path (including a named path such as `@systemName` or `@ifDescription(eth0)`) turns into steps, modules, namespaces and keys, and the filter a read would send (`client.content.readFilter()`), without sending anything. For a named path with parameters it also shows the template and its parameters, marking those a read may leave out `(optional)` |
| `diff [<path>] [--source <ds>] [--target <ds>]` | How two configuration datastores differ (running, candidate or startup; default running → candidate, what a commit would apply), from `client.content.compareDatastores()`: both read with get-config and compared in the client with the YANG schema, so it works without RFC 9144 compare. A path or `@name` limits both reads to the filter `read` sends for it. One line per change (`+ create`, `- delete`, `~ replace` with `old → new`, `> move` with `first` or `after <path>`), bigger values as indented JSON, then a count; `--json` prints the change array. Device text is escaped as in `compare`'s diff. Needs the device's YANG schema (the target's `yang.modules` when the device can't serve it). Read-only (CLI PATH-13) |
| `datastores` | The server's datastores, from `client.content.datastores()`: on a `:yang-library:1.1` (NMDA) server its `/yang-library/datastore` list, with each datastore's schema; otherwise, or when the library lists none, `running`, then `candidate` and `startup` when advertised. A table (DATASTORE, plus SCHEMA from the library), with an identity outside ietf-datastores as `module:name` (its namespace when no module is known), and a line saying which source it came from. `--json` prints `{ source, datastores }`. At most one `<get>` of the YANG library, shared with the session's other library reads. Read-only (CLI PATH-14) |
| `modules [<module>] [--datastore <ds>] [--schema <name>] [--all-features]` | The server's YANG modules and the features it supports, from `client.content.modules()`: with a YANG library (`:yang-library:1.1` or `:1.0`), the modules of the datastore's schema (default running) or of the `--schema` named; otherwise the hello's module capabilities. Never merged: on a server with a library the hello's module URIs are ignored. `--datastore` takes a standard name or `module:name` for another identity; with `--schema` it's a usage error. A table (MODULE, REVISION, CONFORMANCE implement/import, FEATURES, DEVIATIONS) headed by `Source:`, `Datastore:` (not with `--schema`) and `Schema:` lines. `--all-features` reads and compiles each implemented module's source (the target's `yang.modules`, the bundled IETF modules, `<get-schema>`) and lists one row per declared feature (MODULE, FEATURE, SUPPORTED yes/no), features the server reports that the source lacks as `yes (not in the module's source)`, and `(source not found)` for a module without source. `--json` prints `{ source, schema, modules }`. At most one `<get>` of the YANG library, shared; source reads only with `--all-features`. Read-only (CLI PATH-15) |
| `namespaces [<module>]` | The module namespaces paths resolve with, from `client.content.moduleNamespacesInfo()`: a table (MODULE, NAMESPACE, SOURCE) in lookup order, SOURCE being `given` (the target's `namespaces`), `profile`, `hello` or `library`. An OVERRIDES column, shown only when some module has one, lists the later sources that gave a module a different namespace, as `<source> <namespace>`. Reads the YANG library first (at most one `<get>`, shared, and none without one) so modules only it lists are included; a failed read still lists the rest, with a note, while Ctrl-C and `--timeout` stop the command. An unknown `<module>` is an error. `--json` prints `[{ module, namespace, source, overrides? }]`. Read-only (CLI PATH-16) |

A path can be a named path from the device profile, `@name`, with any parameters it takes as `@name(value, param=value)`: `value @ifDescription(eth0)`. A read may leave out a parameter that fills a whole predicate, to read every entry (`read @ifDescription`); `set` and `remove` need every parameter. The lexer keeps a `(…)` that closes on the same line as one word, quotes and spaces included (§6.1). Tab completes module names after `/` (from the hello), named paths after `@` (with no space after one that takes parameters, so `(` can follow), and inside `@name(` the parameters not yet given (by position or by name): a single one completes with its `=`, several are listed by name. A path error (bad syntax, with its position; a module the device doesn't advertise; an unknown `@name`; a missing, unknown or extra parameter) is reported before anything is sent. `set` and `remove` are refused on read-only targets (§9).

**Transactions (Content layer)**

| Command | What it does |
|---------|--------------|
| `begin` | Start a transaction: `set` and `remove` then queue their changes (each checked when queued: a path error, or a second change to the same node, fails at once), and nothing is sent. The prompt shows `[tx N]` |
| `changes` | The queued changes, in order |
| `abandon` | Drop the queued changes; nothing is sent |
| `apply [--confirmed [--confirm-timeout <s>] [--persist <id>]]` | Send every queued change in one `<edit-config>` through the profile's workflow, as `set` does. After a failed step the transaction stays open. `--confirmed` makes a confirmed commit (`[confirm m:ss]` in the prompt) that the device rolls back unless confirmed. `apply` is refused while a confirmed commit is pending, because a plain commit would confirm it |
| `confirm` / `revert` | Make the pending confirmed commit permanent, or roll it back now |

Disconnecting drops an open transaction and says how many changes were not applied, and warns about a pending confirmed commit. A script that ends with a transaction open fails. `begin`, `apply`, `confirm` and `revert` are refused on read-only targets. These names leave the base operations `commit`, `cancel-commit` and `discard-changes` as they are.

**Subscriptions (RFC 8639, 8641)**

The `subscriptions` extension's commands come from its descriptors like any extension's, but nnc runs four of them through the library's subscription reader rather than as bare RPCs (OPS-15):

| Command | What it does |
|---------|--------------|
| `establish-subscription --stream <name> \| --datastore <ds> (--period <cs> \| --on-change) [...]` | `client.ops.subscriptions.establish()`. Prints `subscription 7 · stream NETCONF` (`--xml`: the reply's contents; `--json`: id, kind, stream or datastore, trigger, replay). nnc then reads the subscription in the background for as long as it is open, so its bounded queue never overflows while you do other things |
| `modify-subscription <id> [...]` / `delete-subscription <id>` / `resync-subscription <id>` | The library's `client.ops.subscriptions.modify()` / `delete()` / `resync()`: for a subscription this session holds, its own `modify()`, `delete()`, `resync()` |
| `kill-subscription <id>` | A bare `<kill-subscription>`: for any session's subscription. When it ends one this session holds, the server's `subscription-terminated` ends it here too |
| `subscription-list`, `subscription-streams`, `subscription-support` | The extension's reads, as JSON |

Each update is shown above the prompt (or to `notifications --follow`) as `notification N · <event time> · subscription <id> · <what>`, where `<what>` is `event · <event name>`, `push-update · <top-level names>`, `push-change-update · <n> edits`, `suspended · <reason>`, `resumed`, `modified` or `replay-completed`, with `· incomplete` when the server marks an update so. When a subscription ends, `subscription <id> ended · deleted | terminated (<reason>) | completed | overflow` follows; a session closing ends its subscriptions without one. A notification a subscription reads is not also shown as a plain notification line, including those a server sends before the establish reply; if the establish fails, those are shown as plain notifications. `status` lists the open subscriptions. RFC 5277 `create-subscription` is unchanged: its notifications are plain notification lines.

**Device profile**

| Command | What it does |
|---------|--------------|
| `profile [--json]` | The profile in use: where it came from (built in, or its file), how it was chosen (named by the target, or auto-detected with its match rules), its quirks, configure workflow, named paths (with each one's parameters) and operation names (`*` changes state). With no profile, the profiles auto-detection considered. `--json` adds `definition`: the profile's effective definition (`client.profile.definition`, with `extends` merged), or null for a profile written in code. Sends nothing |
| `profile <operation> [--json]` | One operation's full definition: description, whether it changes state (an operation whose profile doesn't say counts as a change), parameters, the request template as written, how the reply is read (path and `as`), and the `device` command that runs it. A profile written in code shows `request (defined in code)`. Sends nothing, so it works on read-only targets for any operation |
| `device [--json]` | The operations this connection can run (`client.ops.device`), under the profile's name, each with its description, parameters and `*` when it changes state |
| `device <operation> [--param value ...]` | Run a profile operation on the device, such as `device cli --command "show version"`. The read-only guard applies (§9). Tab completes operation names after `device` and `profile` |

### 6.4 Framed sessions

| Command | What it does |
|---------|--------------|
| `send <xml> \| @file \| --edit` | Frame one message in the current framing and send it. The XML is sent as typed; it isn't checked, re-indented or given a `message-id`. In end-of-message framing a message containing `]]>]]>` is refused before anything is sent. |
| `hello [--base 1.0 \| 1.1]` | Send a standard client `<hello>` advertising base:1.0 and base:1.1, or only the one named. (In a client session `hello` shows the server's hello instead.) |
| `server-hello [--raw]` | The server's `<hello>`, once it has arrived |
| `framing [chunked]` | Show the framing, or switch both directions to chunked framing from the next message (`useChunkedFraming()`). It never switches on its own, and switching back to `eom` is refused. |
| `show [<n>] [--raw]` | List the messages received (number, time, size, root element), or show message `n` again; `--raw` exactly as received, and `show 3 --raw > reply.xml` saves it |

Received messages are printed above the prompt as they arrive, numbered from 1, as indented XML; one that isn't well-formed XML is printed as text with the parse error. A framing error, or the server closing the session, ends the session with a message, and the prompt returns to `nnc>`. Nothing is sent when you `disconnect`: no `<close-session>`.

### 6.5 Raw sessions

| Command | What it does |
|---------|--------------|
| `send <text>` | Write the rest of the line as UTF-8 bytes, no newline added. It is taken exactly as typed (no quoting, `#` comments, options or redirects). Escapes `\n`, `\r`, `\t`, `\\` and `\xHH` are understood, so `send <hello .../>]]>]]>` and `send \n#4\nabcd\n##\n` both work; any other escape is refused, showing where it is. |
| `send-hex <hex>` | Write bytes given in hex; spaces are optional |
| `send-file <path>` | Write a file's bytes unchanged |
| `received [> file]` | Everything received in the session; to a file, the bytes unchanged |
| `eof` | End our side of the stream; the prompt shows `[raw eof]`, and sending fails from then on |

Each send reports the bytes written (`sent 6 bytes (raw)`). Received bytes are printed above the prompt as they arrive, as text with control and non-UTF-8 bytes shown as `\xHH`; `output hex` shows a hex dump with offsets and a text column, and `output text` switches back (in a raw session `output` takes `text` or `hex`, not the reply formats). When the server closes the stream, the session ends and the prompt returns to `nnc>`.

### 6.6 Output

- **`xml`** (default): pretty-printed XML, with the `<rpc-reply>` wrapper removed when the reply is data. Colour on a terminal.
- **`json`**: `toObject()` of the result. Like `xml`, a data reply loses its wrapper (`{"configure": {...}}`). Text data becomes a JSON string, empty data `{}`, and `<ok/>` `{"ok": true}`. Keys are local names, values are strings, and an element becomes an array only when its name repeats.
- **`raw`**: the `<rpc-reply>` exactly as received, wrapper included.

`--xml`, `--json` and `--raw` on every command that shows a reply (`rpc`, the operations, `device` operations, `show-last`) override the session's `output` format for that command; an operation with a parameter of the same name keeps it. `--raw` shows the `<rpc-reply>` exactly as it arrived. XML is coloured on a terminal (element names, attribute names and values), never with `NO_COLOR`, in a file or through a pipe; `FORCE_COLOR` colours it anyway.

**A result's own view.** Some results have a view of their own, shown when the format is the `xml` default and no `--xml`, `--json` or `--raw` is given; `--xml` then shows the XML. `compare` (RFC 9144) is one: it prints the differences as a compact diff, one line per edit with its sign (`+` create or insert, `-` delete or remove, `~` replace or merge, `>` move), operation and target, a single leaf's value inline, and anything bigger as indented XML underneath (`was:` and `now:` for a replace). Inline, a replace or merge shows `old → new` (`(not sent)` when the server leaves out the old value), a delete or remove the old value, and a create or insert the new one; an insert or move adds its place (`after /a:list=x`). A value that is empty, starts or ends with a space, or holds a line break or tab is quoted with its whitespace escaped (`""`, `"a\nb"`), so device text can't make up diff lines; a leaf with attributes (an `or:origin` annotation from `report-origin`) is shown as XML so they stay visible. The last line counts the differences between the two datastores, `3 differences (running → candidate)`; an empty patch says `no differences`, and `<no-matches/>` says `no matches` (Clixon sends it for identical datastores too). `compare --json` gives the decoded differences: `noMatches`, `patchId` and `comment` when sent, and each edit's `editId`, `operation`, `target`, `point` and `where` (when sent), `value` and `sourceValue`. The view also goes to `>` files and `show-last`.

`get-data --with-origin` (RFC 8526) is another: it prints one line per leaf, in document order, with its path, its value and its origin, in aligned columns (a path or value wider than the column just pushes the next one along):

```
/ietf-interfaces:interfaces/interface[name=eth0]/name          eth0   intended
/ietf-interfaces:interfaces/interface[name=eth0]/oper-status   up     learned
/oven:oven/temperature                                         0      default
3 leaves: 1 intended, 1 learned, 1 default
```

The origin is the leaf's own `or:origin`, or else its nearest annotated ancestor's, so inherited origins show on every leaf; `-` means none is in its ancestry, and an origin from another module than ietf-origin shows as `module:name`. Paths name modules by YANG module name, from the hello or the session's YANG library (a read-only `<get>`, made only when a namespace isn't in the hello, at most once per session, and not tried again if it fails; Ctrl-C and `--timeout` stop it); a namespace with no known module shows as `{namespace}`. nnc has no schema, so list keys are inferred: elements that repeat among their siblings are a list's entries, keyed by their first leaf, or by as many leading leaves as it takes to tell all the entries apart, the same for every entry of the list (NETCONF puts a list's keys first, in order). A list with one entry shows no key, identical entries share a path, and a leaf-list's values each get a line with the same path. Device text can't fake the view's structure: a key value that isn't a plain word is quoted (`[name="two words"]`), as is an origin name that isn't a YANG identifier; values are quoted and escaped as in compare's view, and also when they hold a run of spaces; and the count is by resolved origin. The last line counts the leaves by origin; empty data says `no data`. `--json` gives `[{ "path", "value", "origin" }]` (`origin` null when none), and `--xml` the reply with its annotations. Without `--with-origin`, `get-data` shows XML as before.

At the prompt on a terminal, a result taller than the screen goes through `$PAGER` (or `less -R`). `--no-page` turns that off for one command, and `output --no-page` for the session (`output --page` turns it back on). Scripts, `-c` and output that isn't a terminal are never paged.

**Errors and warnings.** Each `<rpc-error>` prints as a block on standard error, with only the fields the device sent:

```
rpc-error 1 of 2: lock-denied
  type      protocol
  severity  error
  message   Lock failed, lock is already held
  info      session-id 7
```

A single error has no number. Control characters a message carries (tab, DEL, C1 such as `\x9b`) show as escapes. `show-last --raw` shows the full reply. Warnings from a reply that succeeded print the same way, marked `warning`, after the result.

**Control characters in device data.** XML can carry DEL, C1 control characters (such as `\x9b`, which many terminals treat as the start of an escape sequence) and bidirectional-text controls that make text read differently from what it is. In XML results they are shown as character references (`&#x9b;`) and in JSON as `\u` escapes (`\u009b`), so what you see or save is still valid and keeps the device's values. The exact forms (`--raw`, `show-last --raw`, `show N --raw`, `server-hello --raw`) and trace bodies show them as escapes such as `\x9b` on a terminal, and unchanged in files and pipes. As a last check, nothing nnc writes to a terminal carries a control sequence other than its own colours. Backslashes, tabs and other Unicode are left alone.

**Messages that arrive on their own.** Notifications, session warnings and a server closing the session print above the prompt, and the prompt and what you've typed are redrawn. While a command runs or its result is paged they wait, and print when it finishes. In scripts they go to standard error as they arrive.

**The prompt.** `nnc>` with no session, `nnc router1>` in one. Marks follow the name: the kind and its state for low-level sessions (`[framed eom]`, `[framed chunked]`, `[raw]`, `[raw eof]`, §4), `[ro]` on a read-only session, `[insecure]` when the host key or certificate wasn't verified, `[no-redact]` while traces show secrets. They're coloured on a terminal.

**Completion.** Tab completes commands, options and the values each command's spec declares (`trace` levels, `output` formats, target names after `connect` and `listen`, command names and layers after `help`), file paths after `@`, `>`, `>>` and for `<path>` options. A word you've typed narrows the choices; a second Tab lists them. A single match is completed with a space after it when another word can follow, so you can Tab straight on to the next word; a directory, a module prefix (`/module:`), a redirect's file and the last word a command takes are left without one.

**History search.** Ctrl-R searches the history (this run's and earlier runs') backwards as you type, as in bash: ``(reverse-i-search)`get': get-config --source running``. Ctrl-R again finds the next older match, Ctrl-R on an empty search reuses the last query, and Backspace shortens the query. When nothing matches, the line says `failed` and keeps the last match. Enter runs the match. Esc, the arrow keys, Home, End, Ctrl-A, Ctrl-E and Tab leave it on the line to edit. Ctrl-G or Ctrl-C leaves the search and puts back what you'd typed. There is no Ctrl-S forward search, because terminals use Ctrl-S to pause output.

## 7. Commands built from descriptors

Following the config-over-code principle (design §6.4), the CLI has no code for each operation. It reads **operation descriptors** and builds the parser, argument checks, help, completion and read-only guard from them.

- **Device operations** already have descriptors: `OperationSpec`, with `description`, `params` and `ProfileParamType` (`src/devices/profile-spec.ts`). The library adds an optional **`mutates`** field (§9).
- **Base operations** get descriptors in the operations layer, exported as `BASE_OPERATIONS`. Each gives the operation's name, its arguments (positional and options, with types and allowed values, such as datastore names), whether it changes state, the capabilities it needs, and which `NetconfClient` method runs it.
- **Extensions** export descriptors in the same form, alongside their operations. An extension's reads (`kind: 'read'`, such as `monitoring-sessions`, `monitoring-schemas`, `notification-streams`, `subscription-list` and `yang-library`) are commands too. They print the library's decoded result as JSON (`--json` gives the same; there is no `--xml` or `--raw`, because a read has no reply of its own to show), and never change anything, so read-only targets allow them. A raw `rpc` whose element is named like a read is still refused on a read-only target: a read isn't an RPC.

So adding an extension or a device profile adds its commands to the CLI with no change to nnc.

## 8. Targets

Targets are data, in `~/.config/net-netconf/targets.json` (or `$NNC_TARGETS`, or `--targets <path>`, also spelled `-t`, `--config` or `-C`):

```json
{
  "router1": {
    "host": "router1",
    "port": 830,
    "username": "netconf",
    "password": { "file": "~/.config/net-netconf/router1.pass" },
    "jumpHost": { "host": "jump1", "username": "ops", "agent": true },
    "profile": "nokia-7210-sas",
    "readOnly": true
  }
}
```

- The fields match the library's `SshOptions` and `SshJumpHost`, so the CLI passes them straight to `ssh()`.
- **Jump host chains:** `jumpHost` is one jump host, or a list of them connected in order: `"jumpHost": [{ "host": "jump1", … }, { "host": "jump2", … }]`. Each hop has its own username, authentication and host-key check. The connect line and `status` show every hop (`via jump1:22 → jump2:22`). A failure names the hop, and for an unknown host key the scan command runs through the hops before it (`ssh -J`).
- `profile` names a built-in or loaded profile. If it's missing, the CLI uses `autoDetect(await builtinDeviceProfiles())`. `profilesDir` adds a directory of profile files.
- **Passwords** come from `{ "file": ... }`, `{ "env": ... }` or `{ "prompt": true }` (the default when no key or agent is set). They never come from the command line, and never from the targets file itself.
- **Key passphrases** (`passphrase`, beside `privateKey`, or beside `key` on a TLS target) come from the same sources. The prompt names the key as the target writes it: `Passphrase for key ~/.config/net-netconf/lab-key:`. The key is decrypted before anything is sent, so a wrong or missing passphrase fails at once, naming the key (`the private key ~/.config/net-netconf/lab-key could not be decrypted (wrong passphrase?)`), exits 3, and never leads to a password prompt.
- **Connection failures** say `cannot reach <host>:<port>: …` only when the network failed (connection refused, unreachable, name lookup, timed out). A server that answered but couldn't be used is `connection to <host>:<port> failed: …`, and a failure at a jump host names it (`failed at jump host …`).
- **SSH agent** (`agent`, on a target or a jump host): with no `agent` field, the agent at `$SSH_AUTH_SOCK` is used only when the endpoint has no `password` and no `privateKey`. `"agent": true` uses it alongside any password or key, and is an error when `SSH_AUTH_SOCK` isn't set. `"agent": false` never uses it. This departs from OpenSSH, which offers agent keys whatever else is configured, because every refused key counts against a device's failed-login limit (MaxAuthTries, fail2ban, router lockouts). A server that drops the connection during authentication is reported as an authentication failure.
- **Host keys** are checked against `~/.ssh/known_hosts` by default (`knownHostsFile`). A target can name another file (`knownHosts`). `"hostKey": "insecure-accept-any"` uses `INSECURE_ACCEPT_ANY`, and the prompt then shows `[insecure]` for as long as that session is open.
- **Pinned host keys:** `hostKey` (on a target or a jump host) may instead pin the key, as the library's `hostKey` does: a `SHA256:` fingerprint as `ssh-keygen -lf` prints it (`"hostKey": "SHA256:5jz6…"`), a public key line (`"ssh-ed25519 AAAA…"`), or a non-empty list of either, any one of which is accepted. Only the pin is checked: known_hosts isn't read, and `knownHosts` beside a pin is an error. A malformed pin fails when the targets file is read. A key that doesn't match fails before any credentials are sent (exit 3): `not connected: host key for 127.0.0.1:830 does not match the target's pinned hostKey`, with the received fingerprint and the targets file to update. When every entry is a key line, nnc asks the device for those key types first. `status` shows the fingerprint followed by `(pinned)`; a pinned session is not `[insecure]`. The fingerprint of a device's key is in `status` after any connect, or from `ssh-keyscan -p 830 host | ssh-keygen -lf -`.
- **Session options** (SSH and TLS targets) are passed to the library's `connect()` under the same names:
  - `maxInFlight`: RPCs awaiting a reply at once;
  - `maxMessageBytes`: the largest message accepted;
  - `parseLimits`: `{ "maxDepth", "maxNodes" }` for received XML;
  - `capabilityCheck`: `"strict"` (the default) refuses an operation the device doesn't advertise, `"warn"` sends it with a warning on standard error, and `"off"` sends it silently;
  - `namespaces`: YANG module name to namespace, for paths through modules the device doesn't advertise.

  A reply over a limit closes the session, naming the limit. `status` lists the options a target sets. `extensionCheck` isn't a field: nnc enables every extension so their commands are always listed, and checks each operation under `capabilityCheck` instead.
- **Ad hoc connections:** `connect user@host[:port]` works without a targets entry. It prompts for a password unless an SSH agent has a key, and it isn't read-only unless `--read-only` is given.
- **TLS (RFC 7589).** A target with `"transport": "tls"` connects with the library's `tls()`, on port 6513 unless `port` says otherwise. Its fields match `TlsOptions`: `cert` and `key` are file paths, `passphrase` is a password source for the key, `ca` is a path or a list of paths, `fingerprint` one SHA-256 pin or a list, `serverName` the name the server certificate must carry if not `host`, and `"insecure": "insecure-accept-any"` skips verifying the server (warned about, and shown as `[insecure]`, as for SSH). `cert`, `key` and one of `ca`, `fingerprint` or `insecure` are required. The client certificate is the credential, so `username`, `password`, `privateKey`, `agent`, `hostKey`, `knownHosts` and `jumpHost` are refused on a TLS target, and the TLS fields on an SSH one:

  ```json
  { "router2": { "transport": "tls", "host": "router2", "cert": "~/.config/net-netconf/me.pem",
                 "key": "~/.config/net-netconf/me.key", "ca": "~/.config/net-netconf/lab-ca.pem" } }
  ```

  Ad hoc: `connect host[:port] --tls --cert <path> --key <path> (--ca <path> | --fingerprint <sha256>) [--server-name <name>]`; `--ca` and `--fingerprint` may be repeated. There is no ad hoc way to skip verification. A server that refuses the client certificate, or closes before its hello because cert-to-name found no user, is reported with the certificate's path, and never leads to a password prompt. `status` shows the transport and the server certificate's fingerprint.
- **Simulated devices.** A target with `"transport": "sim"` reaches a device the host provides in-process (§2.6) instead of an SSH or TLS endpoint. `device` names it, and defaults to the target's name. It has no `host` or `port`, and the SSH and TLS fields are refused on it. `profile`, `profilesDir`, `readOnly`, `allowRpcs`, `timeouts` and the session options work as on any target. Everything above the connection is the same as over SSH: hello, profile choice, the read-only guard, hello capture, notifications, the trace, framed and raw sessions. The connect line, `status` and `targets` show it as `sim:<device>`; `status` has no host-key row. A device the host doesn't provide fails, naming it and the devices there are (exit 3), and nothing is tried over SSH. `listen` refuses a sim target: a simulated device never calls home. The `nnc` command provides no devices; a browser page, or a test, does.

  ```json
  { "lab": { "transport": "sim", "device": "router", "readOnly": true } }
  ```

## 9. Safety

**Read-only targets.** When a target has `"readOnly": true`, or `connect` is given `--read-only`:

- Commands whose descriptor says `mutates: true` are refused before anything is sent. This covers `edit-config`, `copy-config`, `delete-config`, `lock`, `unlock`, `commit`, `cancel-commit`, `discard-changes`, `kill-session`, `set` and `remove`.
- **Device operations count as changing state unless their descriptor says `"mutates": false`.** An operation that nobody has classified is treated as a write. Each read-only profile operation (for example the 7210's `show` commands) needs that flag set.
- **`rpc <xml>`** looks up the body's root element in the descriptors. A known operation that doesn't change state is allowed. An unknown root element is refused, unless the target lists it in `"allowRpcs": [...]`.
- **Framed and raw sessions are refused**, because the CLI can't tell what you type in them.

**Credentials** never appear in commands, history, traces or error messages. History records the command line, and no command takes a secret as an argument.

**Read-only flags are never turned off mid-session.** To write to a device, connect to a target that isn't read-only.

## 10. Without a prompt

The same command language runs without a prompt:

```
nnc router1 -c 'get-config running' > running.xml
nnc router1 -c 'modules' -c 'device cli --command "show version"'
nnc router1 --script checks.nnc
nnc --script session.nnc            # the script does its own connect
```

- Given a target, `nnc` connects first. `--read-only`, `--framed` and `--raw` after the target apply to that connection, as on `connect`. `-c` may be repeated. `--script` (or `-s`) reads commands from a file, or from standard input when the path is `-`. A script file that can't be read fails before anything connects.
- With no `-c` or `--script`, `nnc` starts the prompt when standard input is a terminal, or with `-i`. It connects first if a target was given; if that fails, the prompt starts with no session open. When standard input isn't a terminal and there's no `-i`, `nnc` reads a script from it, as `--script -` does. A password prompt then takes the next line of standard input.
- Results go to standard output. Errors, warnings (including rpc-error warnings), notifications, connect and disconnect messages, and traces go to standard error. At the prompt, connect and disconnect messages are shown like results. Errors from a script name the script and line: `checks.nnc:3: …` (`<stdin>:3: …` for standard input). Colour and paging are off when output isn't a terminal.
- A script, or a run of `-c` commands, stops at its first failed command, disconnects and exits with that failure's code. `set on-error continue` runs the remaining commands after a failure, and the exit code is then that of the first failure. `set on-error stop` restores the default. The prompt never stops on a failure. `set on-error` shares its name with the content command `set <path> <value>`; a path always starts with `/` or `@`, so the two never clash.

**Exit codes**

| Code | Meaning |
|------|---------|
| 0 | Every command succeeded |
| 1 | The device returned an `<rpc-error>` |
| 2 | A command couldn't be parsed or was used wrongly |
| 3 | Connection, authentication or host-key failure |
| 4 | Refused by the read-only guard |
| 5 | A timeout, a protocol error, or the session closed unexpectedly |
| 130 | Cancelled with Ctrl-C |

## 11. Inside the CLI

```
src/
├── main.ts            the nnc command: arguments, --version, --help, reading a script; runs on the Node host
├── core.ts            @node-net/nnc/core: what a host needs to run nnc (§2.6)
├── host.ts            the host interface (§2.6)
├── run.ts             one run: connect first, then the prompt, -c, or a script; exit codes
├── sim.ts             sim targets reach the host's simulated devices (§8)
├── bytes.ts           Uint8Array helpers for raw sessions and the trace
├── node/              the Node host: terminal and readline, files, history, $EDITOR and $PAGER, SSH, TLS, call home
├── repl.ts            prompt loop, multi-line input, completion, history, Ctrl-C
├── lexer.ts           words, quotes, inline XML and JSON, @file, > redirection
├── commands/
│   ├── registry.ts    builds commands from descriptors (§7)
│   ├── common.ts      connect, status, trace, output, help, ...
│   ├── client.ts      commands for client sessions
│   └── low.ts         commands for framed and raw sessions
├── sessions/
│   ├── active.ts      the open client session
│   ├── low.ts         framed and raw sessions
│   ├── connect.ts     opens every kind through the host's transports
│   └── recording.ts   the recording Connection (§5)
├── targets.ts         the targets file (§8)
├── guard.ts           the read-only guard (§9)
└── render/            xml, json, raw, hex, errors, trace lines, pager
```

- **One open session.** `sessions/active.ts` holds the open session, if any. Every command reaches it through that module, so adding named sessions later changes one module and the prompt, not the commands.
- **Commands don't print.** A command returns a result (`XmlElement`, `RpcReply`, text, or bytes), and `render/` turns it into output. That keeps prompt mode, script mode and tests alike.
- **Commands don't know which mode they're in.** The prompt and script runner both feed lines to the same dispatcher.

## 12. Testing

- **Unit tests:** the lexer (quoting, balanced XML across lines, escapes), the registry (descriptors to commands), the guard, and the renderers.
- **Session tests** against the library's fake server (`@node-net/netconf/testing`): each session kind, tracing, notifications printed during input, and Ctrl-C cancelling a request.
- **Host tests:** run nnc in-process on an in-memory host with simulated devices (`test/support/memory-host.ts`), with no Node.js in the host.
- **Subprocess tests:** run the built `nnc` with `-c` and `--script` against the fake server, and check standard output, standard error and the exit code. These are the CLI stories' acceptance tests.
- **Integration:** the same scripts against the netopeer2 container used by the library's integration tests.
- **Live:** read-only scripts against router1, run by hand.

## 13. Delivery phases

1. **Client sessions.** Workspace setup and the library exports from §3. Targets file, `connect`/`disconnect`/`status`, `hello`, `capabilities`, `rpc`, the base operations from descriptors, `xml`/`json`/`raw` output with paging, `trace` at all three levels, notifications, the read-only guard, `-c`/`--script` and exit codes.
2. **Low-level sessions.** Framed and raw sessions, with their commands.
3. **Content and devices.** `read`, `value`, `set`, `remove`, `resolve`, path completion from module names in the hello, `profile`, and `device` operations.
4. **Later.** Path completion from the YANG schema index once it exists (design §3.5), and named sessions (§14).

## 14. Decisions and open questions

**Decided (2026-11-07)**

- **Packaging:** the `@node-net/nnc` package, in its own repository since 2026-11-16 (§2).
- **Session depth:** chosen at connect time, either a full client session or a low-level (framed or raw) one, and fixed for the life of the session (§4). Tracing works in every kind (§5).
- **Interface:** our own command language. No JavaScript REPL and no JavaScript escape (§6).
- **Sessions:** one at a time to start with (§11).
- **Binary name:** `nnc`. A short name that belongs to this project is easier to type and to search for, and less likely to clash on a crowded PATH. `netconf` is avoided: it reads as the protocol's standard tool, the name is taken on npm and PyPI, and in-house wrappers are likely to use it. A long alias, `net-netconf`, was dropped when the package was named after the command.

**Open**

1. **`allowRpcs`:** whether a per-target list is the right way to allow unknown RPCs on read-only targets, or whether those RPCs should be described in the device profile with `mutates: false`.
2. **Named sessions:** when to support several sessions at once (`connect ... as <name>`, `use <name>`). They make it possible to test lock contention and `kill-session` and to check RFC 6022's session list from inside the CLI.
3. **Adopting a framed session:** whether a framed session, after a hand-made hello, could be handed to a full `Session`. That needs `openSession` to accept a hello that has already been exchanged.
