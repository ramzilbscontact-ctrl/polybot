#!/bin/bash
# ibkr-session-manager.sh — Maintient la session IBKR gateway active
# Lance le gateway + login, redémarre automatiquement si la session expire
# Usage: bash scripts/ibkr-session-manager.sh
set -euo pipefail

GATEWAY_DIR="${IBKR_GATEWAY_DIR:-$HOME/ibclientportal}"
LOG_GW="/tmp/ibkr-gateway.log"
LOG_LOGIN="/tmp/ibkr-login-out.log"
STATE_FILE="/tmp/ibkr-login-state"

start_gateway() {
  echo "[mgr] Démarrage gateway..."
  pkill -9 java 2>/dev/null || true
  sleep 2
  cd "$GATEWAY_DIR" && bash bin/run.sh root/conf.yaml > "$LOG_GW" 2>&1 &
  local attempts=0
  while ! nc -z -w2 localhost 5000 2>/dev/null; do
    sleep 2; attempts=$((attempts+1))
    if [ $attempts -ge 15 ]; then echo "[mgr] ❌ Gateway timeout"; exit 1; fi
  done
  echo "[mgr] ✅ Gateway UP"
  sleep 3
}

start_login() {
  echo "[mgr] Lancement login..."
  rm -f /tmp/ibkr-2fa-code "$STATE_FILE"
  node /home/user/polybot/scripts/ibkr-login-wait.js > "$LOG_LOGIN" 2>&1 &
  LOGIN_PID=$!
  echo "[mgr] Login PID: $LOGIN_PID"

  # Wait for waiting-push, waiting-2fa, authenticated, failed, or error
  local timeout=180
  local elapsed=0
  while [ $elapsed -lt $timeout ]; do
    if [ -f "$STATE_FILE" ]; then
      local state
      state=$(cat "$STATE_FILE")
      case "$state" in
        waiting-push)
          echo "[mgr] 📲 Approuvez la notification push IBKR sur votre téléphone"
          # Wait up to 90s for push approval
          local push_wait=0
          while [ $push_wait -lt 90 ] && grep -q "waiting-push" "$STATE_FILE" 2>/dev/null; do
            sleep 3; push_wait=$((push_wait+3))
          done
          ;;
        waiting-2fa)
          echo "[mgr] 📱 CODE SMS REQUIS"
          echo "[mgr]    Dans un autre terminal : echo \"CODE\" > /tmp/ibkr-2fa-code"
          # Wait up to 120s for code
          local fa_wait=0
          while [ $fa_wait -lt 120 ] && grep -q "waiting-2fa" "$STATE_FILE" 2>/dev/null; do
            sleep 3; fa_wait=$((fa_wait+3))
          done
          ;;
        authenticated)
          echo "[mgr] ✅ Session active — bot peut démarrer"
          return 0
          ;;
        failed|error*)
          echo "[mgr] ❌ Login échoué: $state"
          return 1
          ;;
      esac
    fi
    sleep 2; elapsed=$((elapsed+2))
  done
  echo "[mgr] ❌ Timeout login"
  return 1
}

# Main loop
start_gateway

while true; do
  if start_login; then
    echo "[mgr] Session active — surveillance..."
    # Wait for session to expire
    while true; do
      sleep 10
      if [ -f "$STATE_FILE" ]; then
        state=$(cat "$STATE_FILE")
        if [[ "$state" == "expired" ]] || [[ "$state" == error* ]]; then
          echo "[mgr] Session expirée ($state) — relance dans 10s..."
          sleep 10
          # Check if gateway is still running
          if ! nc -z -w2 localhost 5000 2>/dev/null; then
            start_gateway
          fi
          break
        fi
      fi
    done
  else
    echo "[mgr] Retry dans 30s..."
    sleep 30
    if ! nc -z -w2 localhost 5000 2>/dev/null; then
      start_gateway
    fi
  fi
done
