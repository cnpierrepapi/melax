#!/usr/bin/env bash
# Copies the regtest nodes' TLS certificates and macaroons out of their Docker volumes into .keys/
# so tests and a gateway running on the host (outside Docker) can reach them on localhost.
# Regtest only. .keys/ is git-ignored.
set -euo pipefail
cd "$(dirname "$0")/.."
for n in gw world mint; do
  mkdir -p ".keys/lnd-$n"
  docker compose cp "lnd-$n:/root/.lnd/tls.cert" ".keys/lnd-$n/tls.cert" >/dev/null
  docker compose cp "lnd-$n:/root/.lnd/data/chain/bitcoin/regtest/admin.macaroon" ".keys/lnd-$n/admin.macaroon" >/dev/null
done
echo "credentials copied to .keys/"
