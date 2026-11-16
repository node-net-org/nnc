#!/usr/bin/env bash
# Generate the TEST-ONLY TLS certificates in test/fixtures/tls (RFC 7589 tests).
# These keys are public and must never be trusted outside tests.
#
#   ca            the trusted test CA
#   server        CN router1, SAN localhost and 127.0.0.1, signed by ca
#   client        CN netconf, signed by ca (netopeer2 maps the CN to the user)
#   guest         CN nn-guest, signed by ca: a user in no NACM group (access-denied test)
#   other-ca      an untrusted CA
#   other-client  CN netconf, signed by other-ca
#   other-server  CN router1, SAN localhost and 127.0.0.1, signed by other-ca
#
# Regenerating changes every fingerprint; the tests read them from the files.
set -euo pipefail
cd "$(dirname "$0")/../test/fixtures/tls"
rm -f ./*.pem ./*.key ./*.srl
DAYS=36500

ca() {
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.pem" -days $DAYS -subj "/CN=$2" \
    -addext "basicConstraints=critical,CA:TRUE" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
}
leaf() { # name cn issuer san eku
  openssl req -newkey rsa:2048 -nodes -keyout "$1.key" -out "$1.csr" -subj "/CN=$2" 2>/dev/null
  printf 'subjectAltName=%s\nextendedKeyUsage=%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\n' "$4" "$5" > "$1.ext"
  openssl x509 -req -in "$1.csr" -CA "$3.pem" -CAkey "$3.key" -CAcreateserial -out "$1.pem" -days $DAYS -extfile "$1.ext" 2>/dev/null
  rm -f "$1.csr" "$1.ext"
}

ca ca '@node-net/netconf test CA (TEST ONLY)'
ca other-ca '@node-net/netconf untrusted test CA (TEST ONLY)'
leaf server router1 ca 'DNS:localhost,IP:127.0.0.1' serverAuth
leaf client netconf ca 'DNS:netconf-client' clientAuth
leaf guest nn-guest ca 'DNS:netconf-client' clientAuth
leaf other-server router1 other-ca 'DNS:localhost,IP:127.0.0.1' serverAuth
leaf other-client netconf other-ca 'DNS:netconf-client' clientAuth
rm -f ./*.srl
echo "TLS test fixtures written to $(pwd)"
