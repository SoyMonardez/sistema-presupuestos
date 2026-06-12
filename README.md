# Sistema de Presupuestos

App simple para crear presupuestos desglosados por items (nombre, cantidad, unidad, precio unitario), con total automático, **export a PDF**, **dictado por voz** y **IA** que convierte texto libre en items.

- **Backend:** Node.js + Express + SQLite (`better-sqlite3`)
- **Frontend:** HTML/CSS/JS vanilla, mobile-first, sin build
- **IA:** Groq (`llama-3.3-70b-versatile`) — entiende jerga argentina ("15 lucas el metro")
- **Voz:** Web Speech API (Chrome/Edge/Android; necesita HTTPS o localhost)
- **PDF:** jsPDF client-side
- **Auth:** password única (`APP_PASSWORD`) + token firmado

## Correr local

```bash
cp .env.example .env   # completar APP_PASSWORD, APP_SECRET y GROQ_API_KEY
npm install
npm run dev
# → http://localhost:3002
```

Generar `APP_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Deploy en el VPS (Hostinger)

Mismo patrón que el portfolio: container detrás del Nginx Proxy Manager.

```bash
ssh root@TU_IP
mkdir -p /var/www && cd /var/www
git clone <repo> presupuestos && cd presupuestos
cp .env.example .env && nano .env     # completar valores reales
docker compose up -d --build
```

Después, en **Nginx Proxy Manager**:

1. Proxy Hosts → Add Proxy Host
2. Domain: `presupuestos.tudominio.com` (crear el registro A en DNS antes)
3. Forward Hostname: `presupuestos-app` — Forward Port: `3002`
4. SSL → Request a new certificate (Let's Encrypt) + Force SSL

> El dictado por voz **requiere HTTPS**, así que no te saltees el certificado.

### Actualizar

```bash
cd /var/www/presupuestos
git pull && docker compose up -d --build
```

La base de datos vive en el volumen `presupuestos_data` y sobrevive rebuilds.

## Cómo se usa la IA

- **Dictar items**: botón micrófono → hablás ("20 metros cuadrados de cerámica a 15 lucas el metro y un día de mano de obra 80 mil") → la IA arma los items → los revisás y confirmás.
- **Escribir y convertir**: lo mismo pero tipeando texto libre.
- **Sugerencias**: al escribir el nombre de un item, la IA sugiere el nombre completo, la unidad típica y un precio estimado de mercado (siempre editable).

## Personalizar el PDF

Editar el bloque `PDF_EMISOR` al inicio de [public/js/pdf.js](public/js/pdf.js) con nombre, rubro, teléfono y email que tienen que salir en el encabezado.

## Roadmap (fase SaaS)

- Usuarios reales (registro/login) en vez de password única
- Multi-tenant + planes
- Plantillas de presupuesto por rubro
- Estados (enviado / aprobado / rechazado) y envío por WhatsApp/email
