#!/usr/bin/env bash
# deploy.sh — Deploy walichat-extended to the cloud server (docean_ubuntu)
# Run from the repo root or from within mcps/walichat-extended/.
#
# Prerequisites on server:
#   /opt/walichat-extended/ — git repo cloned from amirandap/walichat-extended
#   PM2 process running servers/index.js  (ecosystem.config.cjs)
#   /root/.walichat-extended/ for SQLite DB (auto-created)

set -euo pipefail

echo "→ Pulling latest code on server..."
ssh docean_ubuntu "cd /opt/walichat-extended && git pull origin main"

echo "→ Installing dependencies on server..."
ssh docean_ubuntu "cd /opt/walichat-extended/servers && npm install --omit=dev"

echo "→ Reloading PM2..."
ssh docean_ubuntu "pm2 reload walichat-extended"

echo "→ Verifying health..."
sleep 2
ssh docean_ubuntu "curl -s http://localhost:8003/health"
echo ""
echo "✅ Deploy complete"
