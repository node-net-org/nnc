# @node-net/nnc

`nnc` is an interactive NETCONF client for watching the protocol. It sends operations, traces bytes, frames or XML, connects to production devices read-only, and runs scripts with exit codes. It's built on [@node-net/netconf](https://github.com/node-net-org/netconf), through its public API only.

**📖 Documentation: [net-netconf.abrahams.nz/cli](https://net-netconf.abrahams.nz/cli/)**

> **Status: early development (0.x).** The commands and their output may still change before 1.0.

## Install

```sh
npm install --global @node-net/nnc
```

Node.js 22.12 or later.

## Usage

```
usage: nnc [<target> [--read-only] [--framed | --raw]] [-t <path>]
           [-c <command>]... | -s <file|-> | -i

  <target>             connect to this target (a name from the targets file, or user@host[:port]) first
  --read-only          open that session read-only
  --framed, --raw      open a framed or raw session instead of a client session
  -c, --command <cmd>  run a command and exit; may be repeated
  -s, --script <file|->
                       run the commands in a file and exit; - reads them from standard input
  -i, --interactive    start the prompt even when standard input isn't a terminal
  -t, --targets <path> the targets file (default $NNC_TARGETS, else ~/.config/net-netconf/targets.json)
  -C, --config <path>  the same as --targets
  -V, --version        print the version
  -h, --help           print this help
```

With no `-c` or `--script`, nnc starts the prompt when standard input is a terminal, and otherwise reads a script from standard input. Type `help` at the prompt for the commands. Scripts and `-c` stop at the first failed command unless they say `set on-error continue`; the exit code is then that of the first failure:

| Exit code | Meaning |
|---|---|
| 0 | every command succeeded |
| 1 | the device returned an `<rpc-error>` |
| 2 | a command couldn't be parsed or was used wrongly |
| 3 | a connection, authentication or host-key failure |
| 4 | refused by the read-only guard |
| 5 | a timeout, a protocol or framing error, or the session closed unexpectedly |
| 130 | cancelled with Ctrl-C |

## Running nnc in a web page

`@node-net/nnc/core` is everything nnc needs except the Node host: its files, transports, environment and terminal come from a host object you supply, so nnc can run in a browser against a simulated device ([design §2.6](docs/cli.md)).

## Development

```sh
npm install
npm run check
```

There is no CI for changes: what gates a change is these checks, run locally before it lands. Only releases run on GitHub (below).

- **`npm run check` runs before every landing:** build, lint, typecheck, layer rules (nnc uses @node-net/netconf only through its public API), `nnc --version`, the portability check, tests, and last the runtime audit. `npm audit --omit=dev` fails the check on any known vulnerability in the runtime dependencies. If the registry can't be reached, the audit is skipped with a loud warning and the check still passes, so it works offline. `NN_REQUIRE_AUDIT=1` makes that skip a failure.
- **`npm run check:full`** (`scripts/check-full.sh`) runs `check` with the audit required, then `scripts/check-node.sh 22 24 26` (Docker required), and the full `npm audit`, which is reported but never fails. `--quick` skips the Node.js lines. Run it before landing any change to dependencies or these scripts, and whenever unsure.
- **Every Node.js LTS line that `engines` allows must pass the whole check.** `scripts/check-node.sh` runs `npm install` and `npm run check` for each line in a clean `node:<line>` container, with a copy of the working tree. When a new line is promoted to LTS, add it to the script's default lines; when one reaches end of life, drop it and raise `engines`.
- **Updates:** `npm run deps:report` lists outdated dependencies, with in-range updates apart from those needing a range change, and summarises the runtime and full audits.
- `scripts/install-hooks.sh` installs an opt-in git pre-push hook that runs `npm run check` (`--uninstall` removes it).
- **Test fixtures:** `test/fixtures/tls` holds test-only certificates (`scripts/tls-fixtures.sh` regenerates them), and `test/fixtures/yang/json` small YANG modules for the JSON tests. Both are copies of @node-net/netconf's.
- **Releases:** `npm version patch` (or `minor`, `major`), then `git push --follow-tags`. The tag starts `.github/workflows/release.yml`, which runs `check` and publishes to npm through trusted publishing, so no npm token exists anywhere. Each version carries a provenance statement linking it to its commit. `prepublishOnly` refuses to publish while the `@node-net/netconf` version this depends on isn't on npm yet.
- [docs/cli.md](docs/cli.md) is the design.

## Licence

MIT
