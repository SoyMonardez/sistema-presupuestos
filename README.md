# Sistema de Presupuestos

App para armar presupuestos de obra por items (nombre, cantidad, unidad, precio unitario), pensada para usarse desde el celular en la obra. Dicta por voz, lee la hoja de cambios que devuelve el municipio, convierte unidades sin sacar cuentas a mano, y exporta el PDF.

- **Backend:** Node.js + Express + SQLite (`better-sqlite3`)
- **Frontend:** HTML/CSS/JS vanilla, mobile-first, sin build
- **IA:** Groq y Claude, ruteados por tarea (ver abajo). Entiende jerga argentina ("15 lucas el metro")
- **Voz:** grabación en el navegador → Whisper por servidor (funciona en cualquier navegador; necesita HTTPS o localhost para poder usar el micrófono)
- **Imágenes:** Pillow para achicar las fotos antes de mandarlas al modelo de visión
- **PDF:** jsPDF client-side, con formato para cliente particular y para municipio
- **Auth:** password única (`APP_PASSWORD`) + token firmado

## Correr local

```bash
cp .env.example .env   # completar APP_PASSWORD, APP_SECRET y al menos una API key
docker compose -f docker-compose.local.yml up --build
# → http://localhost:3002
```

`docker-compose.yml` (el de producción) declara la red externa `nginx_network`, que solo existe en el VPS. Por eso en la compu se usa `docker-compose.local.yml`, que además tiene su propio volumen: lo que pruebes acá no se mezcla con nada.

Para empezar de cero: `docker compose -f docker-compose.local.yml down -v`

Sin Docker:

```bash
npm install
npm run dev
```

Generar `APP_SECRET`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

> **Al probar en el celular**, desregistrá el service worker o hacé hard-reload. Si el `CACHE` de `public/sw.js` no subió de versión vas a estar mirando archivos viejos y volviéndote loco.

## Qué hace la IA

**Alcanza con una sola API key para que arranque.** Si falta la del proveedor que le toca a una tarea, se usa el otro y queda avisado en el log de arranque.

| Tarea | Proveedor por defecto | Por qué |
|---|---|---|
| `suggest`, `spellcheck`, `parse`, `client_data` | Groq | Latencia crítica o trabajo mecánico |
| `command`, `chat`, `vision` | Claude | Equivocarse acá sale caro: es un presupuesto frente a un cliente |
| Transcripción de voz | Groq (Whisper) | Anda muy bien y sale centavos |
| Búsqueda web | Groq (`compound-mini`) | Trae la búsqueda integrada |

Se puede mover cualquier tarea de proveedor sin tocar código, con las variables `AI_ROUTE_*` del `.env`.

### Lo que se puede pedir

- **Dictar items** — botón de micrófono, hablás ("20 metros cuadrados de cerámica a 15 lucas el metro y un día de mano de obra 80 mil") y la IA arma los items. Los revisás y confirmás.
- **Escribir** — lo mismo pero tipeando, y además edita lo que ya está cargado: "sacá el item 5", "el item 2 ahora sale 300 mil", "pasá todo a metros cúbicos".
- **La hoja de cambios** — foto de la propuesta que devuelve el municipio. La compara contra el presupuesto y te dice qué piden cambiar, sacando de la hoja la medida que hace falta para convertir. Lo que no matchea lo reporta en vez de adivinar.
- **Importar** — items desde PDF, Excel, CSV o una foto.
- **Sugerencias** — al escribir el nombre de un item propone el nombre completo, la unidad típica y un precio estimado.
- **El asistente** (pestaña del editor) — conoce los items, tu tarifario y lo que cobraste antes por trabajos parecidos. Simula descuentos sin aplicarlos, convierte, y busca precios de mercado citando la fuente.

### Las dos reglas que no se rompen

1. **La IA no calcula plata.** Extrae datos y dice qué hacer; la aritmética (conversiones, descuentos, totales) la hace el servidor, exacta. Un modelo haciendo cuentas de precisión en un solo paso se equivoca, y acá eso se factura.
2. **La IA no escribe en la base.** Propone, y los cambios se muestran para confirmar antes de aplicarse.

## Unidades

Las unidades salen de un catálogo (`m`, `m²`, `m³`, `un.`, `kg`, `tn`, `lt`, `hs`, `día`, `saco`, `global`) y se eligen de una lista, no se tipean: si conviven "m2", "M²" y "metros cuadrados" ninguna conversión es confiable. Se pueden agregar unidades propias desde **Precios base**.

**Convertir preserva el total del item**: se recalculan cantidad y precio unitario para que el trabajo siga costando lo mismo, expresado de otra forma. Lo que cambia para el cliente es la presentación, no la plata.

Para pasar de m² a m³ alcanza con el espesor — que es justo el número que viene en la hoja del municipio. Entre familias incompatibles (horas a m², kg a m³) la conversión se rechaza en vez de inventar un factor.

## Precios base

Tu tarifario real. La IA lo usa con prioridad absoluta: si un item coincide usa ese precio exacto, si es derivado extrapola desde ahí, y solo estima de mercado cuando no hay ninguna relación.

## Deploy en el VPS (Hostinger)

**`/var/www/presupuestos` en el VPS no es un checkout de git**, es una copia de archivos. Se despliega desde la máquina de desarrollo:

```bash
bash deploy_to_vps.sh
```

Empaqueta el proyecto con tar (excluyendo `node_modules`, `.git` y `data`), lo sube por SSH y levanta el container. El `.env` del servidor no se pisa.

La primera vez, en **Nginx Proxy Manager**:

1. Proxy Hosts → Add Proxy Host
2. Domain: `presupuestos.tudominio.com` (crear el registro A en DNS antes)
3. Forward Hostname: `presupuestos-app` — Forward Port: `3002`
4. SSL → Request a new certificate (Let's Encrypt) + Force SSL

> El micrófono **requiere HTTPS**, así que no te saltees el certificado.

La base vive en el volumen `presupuestos_data` y sobrevive los rebuilds.

## Personalizar el PDF

Editar el bloque `PDF_EMISOR` al inicio de [public/js/pdf.js](public/js/pdf.js) con nombre, rubro, teléfono y email que salen en el encabezado.

## Documentación

- [docs/plan-v2.md](docs/plan-v2.md) — el plan de la versión actual: qué problema resuelve cada fase y por qué se decidió así.

## Roadmap

- Chat global (desde la lista) para estimar un trabajo nuevo desde cero
- Usuarios reales (registro/login) en vez de password única
- Multi-tenant + planes
- Plantillas de presupuesto por rubro
- Estados (enviado / aprobado / rechazado) y envío por WhatsApp/email
