#!/usr/bin/env bash
# =====================================================================
# Deploy local → VPS Hostinger (mismo patrón que el portfolio)
#
#   1. Empaqueta el proyecto con tar (excluye node_modules, .git, data, .env)
#   2. Lo sube por SSH al VPS. El .env del VPS NO se pisa: tiene las contraseñas
#      y claves reales. Solo se sube el .env local si en el VPS todavía no hay uno.
#      Para agregar un acceso nuevo se edita el .env del VPS (APP_PASSWORD_<NOMBRE>).
#   3. Levanta el container con docker compose
#   4. Healthcheck
#
# Uso:   bash deploy_to_vps.sh
# =====================================================================

set -euo pipefail

# Datos del servidor: van en deploy.local.env (no se sube al repositorio).
#   VPS_IP=1.2.3.4
#   VPS_USER=root
#   VPS_PATH=/var/www/presupuestos
[ -f deploy.local.env ] && . ./deploy.local.env
: "${VPS_IP:?Falta VPS_IP: crealo en deploy.local.env (ver el comentario arriba)}"
VPS_USER="${VPS_USER:-root}"
VPS_PATH="${VPS_PATH:-/var/www/presupuestos}"

echo "━━ Presupuestos · Deploy a ${VPS_IP} ━━"

echo "→ Probando SSH..."
ssh -o ConnectTimeout=10 -o BatchMode=yes "${VPS_USER}@${VPS_IP}" "echo '  ✓ SSH OK'"

# ¿El VPS ya tiene su .env? Si lo tiene, no se toca.
if ssh "${VPS_USER}@${VPS_IP}" "test -f ${VPS_PATH}/.env"; then
    echo "  ✓ El VPS ya tiene .env: se conserva"
elif [ -f ".env" ]; then
    echo "  ⚠ El VPS no tiene .env: se sube el local"
    SUBIR_ENV=1
else
    echo "❌ No hay .env ni en el VPS ni acá. Copiá .env.example a .env y completalo."
    exit 1
fi

echo "→ Empaquetando y subiendo..."
tar czf - \
    --exclude='node_modules' \
    --exclude='.git' \
    --exclude='.claude' \
    --exclude='data' \
    --exclude='.env' \
    --exclude='*.log' \
    --exclude='deploy_to_vps.sh' \
    --exclude='deploy.local.env' \
    -C . . | \
ssh "${VPS_USER}@${VPS_IP}" "mkdir -p ${VPS_PATH} && tar xzf - -C ${VPS_PATH} && echo '  ✓ Archivos copiados'"

if [ "${SUBIR_ENV:-0}" = "1" ]; then
    scp -q .env "${VPS_USER}@${VPS_IP}:${VPS_PATH}/.env"
    echo "  ✓ .env subido"
fi

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
echo "✓ Deploy completado (se entra por el dominio del Nginx Proxy Manager, con HTTPS)"
