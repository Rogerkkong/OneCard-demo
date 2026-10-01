#!/usr/bin/env bash
# Make a throwaway certificate authority and a broker certificate for the lab's
# optional MQTT TLS listener, so you can practise what a real device must do:
# trust a CA, then check that the broker's name matches the certificate (SAN).
#
# Usage: scripts/make-lab-certs.sh [extra-name ...]
#   extra names are added to the broker certificate, e.g. a LAN IP or a hostname:
#   scripts/make-lab-certs.sh 192.168.1.20 lab.local
#
# Output goes to ./lab-certs (ignored by git). These files are for the lab only:
# never use them, or a CA made this way, for a real system.
set -euo pipefail

OUT="${LAB_CERTS_DIR:-lab-certs}"
mkdir -p "$OUT"
cd "$OUT"

if ! command -v openssl >/dev/null 2>&1; then
  echo "openssl is needed (macOS and Linux have it; on Windows use Git Bash or WSL)." >&2
  exit 1
fi

# Names the broker certificate is valid for. Devices must connect using one of these.
SAN="DNS:localhost,IP:127.0.0.1"
for name in "$@"; do
  if [[ "$name" =~ ^[0-9]+(\.[0-9]+){3}$ ]]; then SAN="$SAN,IP:$name"; else SAN="$SAN,DNS:$name"; fi
done

cat > ca.cnf <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
C = MY
O = OneCard Lab
CN = OneCard LAB Root CA (not for production)
[v3_ca]
basicConstraints = critical, CA:TRUE, pathlen:0
keyUsage = critical, keyCertSign, cRLSign
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid:always
CNF

cat > server.cnf <<CNF
[req]
distinguished_name = dn
prompt = no
[dn]
C = MY
O = OneCard Lab
CN = onecard-lab-broker
[v3_server]
basicConstraints = critical, CA:FALSE
keyUsage = critical, digitalSignature, keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = $SAN
subjectKeyIdentifier = hash
authorityKeyIdentifier = keyid,issuer
CNF

# The CA lives two years, the broker certificate one: short lives limit the damage if a lab key leaks.
openssl req -x509 -new -newkey rsa:2048 -nodes -sha256 -days 730 \
  -keyout ca.key -out ca.crt -config ca.cnf -extensions v3_ca 2>/dev/null
openssl req -new -newkey rsa:2048 -nodes -sha256 \
  -keyout server.key -out server.csr -config server.cnf 2>/dev/null
openssl x509 -req -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial -sha256 -days 365 \
  -out server.crt -extfile server.cnf -extensions v3_server 2>/dev/null
rm -f server.csr ca.srl
chmod 600 ca.key server.key

openssl verify -CAfile ca.crt server.crt >/dev/null
echo "Lab certificates written to $(pwd)"
echo "  ca.crt      give this to devices (they trust it)"
echo "  ca.key      keep private; only needed to issue more certificates"
echo "  server.crt  + server.key  the broker's certificate, valid for: $SAN"
echo
echo "CA fingerprint (check it with whoever installs ca.crt, over a second channel):"
openssl x509 -in ca.crt -noout -fingerprint -sha256 | sed 's/^/  /'
echo
echo "Start the lab with TLS:"
echo "  LAB_MQTT_TLS_CERT=$OUT/server.crt LAB_MQTT_TLS_KEY=$OUT/server.key npm start"
