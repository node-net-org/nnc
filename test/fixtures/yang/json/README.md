# JSON output fixtures

Modules for the RFC 7951 JSON output tests (test/yang/json-output.test.ts, and nnc's
test/json-output.test.ts): `ex-json` covers the types the conversion rules care about,
and `ex-aug` augments its list entries from a second module. `ex-ident` derives an identity from `ex-json`'s base in a module `ex-json` doesn't import,
as iana-if-type does for ietf-interfaces: data names it only in a value's prefix.

`top.yanglint.json` is yanglint's (libyang 2.1.30) conversion of `top.xml` with both
modules, the oracle the tests compare net-netconf's output with. To regenerate it, using
the image net-yang's scripts/yanglint-oracle.sh builds:

    docker run --rm -v "$PWD":/w -w /w net-yang-yanglint:bookworm \
      yanglint -f json -t config ex-json@2026-11-09.yang ex-aug@2026-11-09.yang top.xml > top.yanglint.json
