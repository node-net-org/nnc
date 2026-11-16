# TLS test fixtures (TEST ONLY)

Certificates and private keys for the RFC 7589 TLS tests, made by `scripts/tls-fixtures.sh`.
The private keys are public: never trust these certificates anywhere but tests.

| File | What |
|------|------|
| `ca` | The trusted test CA |
| `server` | CN `router1`, SAN `localhost` and `127.0.0.1`, signed by `ca` |
| `client` | CN `netconf`, signed by `ca`; netopeer2 maps the CN to the user `netconf` |
| `guest` | CN `nn-guest`, signed by `ca`: a user in no NACM group, for the access-denied test |
| `other-ca` | An untrusted CA |
| `other-server`, `other-client` | Signed by `other-ca` |
