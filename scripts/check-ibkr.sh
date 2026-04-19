#!/usr/bin/env bash
# check-ibkr.sh — Diagnostic de connexion IBKR Client Portal Gateway
set -euo pipefail

GATEWAY_URL="${IBKR_GATEWAY_URL:-https://localhost:5000}"
TIMEOUT=5

echo "════════════════════════════════════════════════════"
echo "  IBKR Gateway Diagnostic"
echo "  Gateway URL : $GATEWAY_URL"
echo "════════════════════════════════════════════════════"
echo ""

# 1. Test réseau
HOST=$(echo "$GATEWAY_URL" | sed 's|https\?://||' | cut -d: -f1)
PORT=$(echo "$GATEWAY_URL" | sed 's|.*:||')

echo "▶ Test réseau $HOST:$PORT ..."
if nc -z -w"$TIMEOUT" "$HOST" "$PORT" 2>/dev/null; then
  echo "  ✅ Port $PORT accessible"
else
  echo "  ❌ Port $PORT inaccessible"
  echo ""
  echo "  → Le Client Portal Gateway n'est pas démarré ou pas accessible."
  echo "  → Lancez-le avec : bash scripts/start-gateway.sh"
  exit 1
fi

# 2. Test auth status
echo ""
echo "▶ Test auth/status ..."
RESP=$(curl -sk --max-time "$TIMEOUT" "$GATEWAY_URL/v1/api/iserver/auth/status" 2>&1)
echo "  Réponse : $RESP"

AUTHENTICATED=$(echo "$RESP" | grep -o '"authenticated":[a-z]*' | cut -d: -f2 || true)
if [ "$AUTHENTICATED" = "true" ]; then
  echo "  ✅ Session authentifiée"
else
  echo "  ⚠️  Session non authentifiée — vous devez vous connecter"
  echo "  → Ouvrez : $GATEWAY_URL dans votre navigateur"
fi

# 3. Infos compte
echo ""
echo "▶ Informations compte ..."
ACCOUNTS=$(curl -sk --max-time "$TIMEOUT" "$GATEWAY_URL/v1/api/iserver/accounts" 2>&1)
echo "  Comptes : $ACCOUNTS"

# 4. Solde paper
ACCOUNT_ID="${IBKR_ACCOUNT_ID:-}"
if [ -n "$ACCOUNT_ID" ]; then
  echo ""
  echo "▶ Solde compte $ACCOUNT_ID ..."
  LEDGER=$(curl -sk --max-time "$TIMEOUT" "$GATEWAY_URL/v1/api/account/$ACCOUNT_ID/ledger" 2>&1)
  echo "  Ledger : $(echo "$LEDGER" | head -c 300)"
fi

echo ""
echo "════════════════════════════════════════════════════"
echo "  Diagnostic terminé"
echo "════════════════════════════════════════════════════"
