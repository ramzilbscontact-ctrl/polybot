#!/usr/bin/env bash
# start-gateway.sh — Lance le Client Portal Gateway IBKR
set -euo pipefail

GATEWAY_DIR="${IBKR_GATEWAY_DIR:-$HOME/ibclientportal}"
RUN_SH="$GATEWAY_DIR/bin/run.sh"
CONF="root/conf.yaml"

echo "════════════════════════════════════════════════════"
echo "  IBKR Client Portal Gateway — Démarrage"
echo "  Port : 5000  (https)"
echo "════════════════════════════════════════════════════"
echo ""

if ! command -v java &>/dev/null; then
  echo "❌ Java non installé : apt install -y openjdk-17-jre"
  exit 1
fi

if [ ! -f "$RUN_SH" ]; then
  echo "❌ run.sh introuvable : $RUN_SH"
  exit 1
fi

echo "✅ Java : $(java -version 2>&1 | head -1)"
echo ""
echo "  Pour vous authentifier, ouvrez un tunnel SSH depuis votre PC :"
echo "  ssh -L 5000:localhost:5000 root@<IP_SERVEUR>"
echo "  Puis : https://localhost:5000"
echo ""

cd "$GATEWAY_DIR"
exec bash bin/run.sh "$CONF"
