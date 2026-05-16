#!/usr/bin/env bash
# deploy.sh — Deploy walichat-extended to the cloud server (docean_ubuntu)
# Run from the repo root.
#
# Prerequisites on server:
#   /opt/walichat-extended/.env  with WALICHAT_API_KEY, WALICHAT_DEVICE_ID, MCP_TRANSPORT=http, PORT=8003

set -euo pipefail

DEST="docean_ubuntu:/opt/walichat-extended"
LOCAL="servers"

echo "→ Uploading sources to ${DEST}..."
scp "${LOCAL}/index.js"      "${DEST}/index.js"
scp "${LOCAL}/package.json"  "${DEST}/package.json"
scp ecosystem.config.cjs     "${DEST}/ecosystem.config.cjs"

echo "→ Installing dependencies on server..."
ssh docean_ubuntu "cd /opt/walichat-extended && npm install --omit=dev"

echo "→ Reloading PM2..."
ssh docean_ubuntu "pm2 reload walichat-extended"

echo "→ Verifying health..."
sleep 2
ssh docean_ubuntu "curl -s http://localhost:8003/health"
echo ""
echo "✅ Deploy complete"
