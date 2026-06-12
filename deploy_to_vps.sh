#!/usr/bin/env bash
# =====================================================================
# Deploy local → VPS Hostinger (mismo patrón que el portfolio)
#
#   1. Empaqueta el proyecto con tar (excluye node_modules, .git, data)
#   2. Lo sube por SSH al VPS
#   3. Levanta el container con docker compose
#   4. Healthcheck
#
# Uso:   bash deploy_to_vps.sh
# =====================================================================

set -euo pipefail

VPS_IP="177.7.53.193"
VPS_USER="root"
VPS_PATH="/var/www/presupuestos"

echo "━━ Presupuestos · Deploy a ${VPS_IP} ━━"

if [ ! -f ".env" ]; then
    echo "❌ Falta .env en la raíz."
    exit 1
fi

echo "→ Probando SSH..."
ssh -o ConnectTimeout=10 -o BatchMode=yes "${VPS_USER}@${VPS_IP}" "echo '  ✓ SSH OK'"

echo "→ Empaquetando y subiendo..."
tar czf - \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.claude' \
    --exclude='data' \
    --exclude='*.log' \
    --exclude='deploy_to_vps.sh' \
    -C . . | \
ssh "${VPS_USER}@${VPS_IP}" "mkdir -p ${VPS_PATH} && tar xzf - -C ${VPS_PATH} && echo '  ✓ Archivos copiados'"

echo "→ Levantando container (la primera vez tarda unos minutos)..."
ssh "${VPS_USER}@${VPS_IP}" "cd ${VPS_PATH} && docker compose up -d --build 2>&1 | tail -20"

echo "→ Healthcheck..."
sleep 8
ssh "${VPS_USER}@${VPS_IP}" '
docker ps --filter name=presupuestos-app --format "  {{.Names}}: {{.Status}}"
if curl -sf -o /dev/null --max-time 5 http://localhost:3002/health; then
    echo "  ✓ App respondiendo"
else
    echo "  ✗ La app no responde en :3002 — revisar: docker logs presupuestos-app"
    exit 1
fi
'

echo ""
echo "✓ Deploy completado → http://${VPS_IP}:3002"
