#!/bin/sh
set -e

SSL_DIR=/etc/nginx/ssl
CERT="${SSL_DIR}/fullchain.pem"
KEY="${SSL_DIR}/privkey.pem"

mkdir -p "${SSL_DIR}"

if [ ! -f "${CERT}" ] || [ ! -f "${KEY}" ]; then
  echo "[oblihub-client] No SSL cert found — generating self-signed certificate (valid 10 years)..."
  openssl req -x509 -nodes -newkey rsa:2048 \
    -keyout "${KEY}" \
    -out "${CERT}" \
    -days 3650 \
    -subj "/CN=oblihub/O=Oblihub Self-Signed" \
    -addext "subjectAltName=DNS:localhost,DNS:oblihub,IP:127.0.0.1" \
    >/dev/null 2>&1
  chmod 600 "${KEY}"
  echo "[oblihub-client] Self-signed certificate generated at ${SSL_DIR}"
fi

exec nginx -g 'daemon off;'
