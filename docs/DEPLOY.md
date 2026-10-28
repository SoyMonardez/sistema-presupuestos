# Deploy y operación

La app corre en un solo contenedor Docker en un VPS, detrás de **Nginx Proxy Manager**, que pone el HTTPS (el micrófono del navegador lo exige).

## Antes de la primera vez

1. En el VPS, crear la carpeta y el `.env` de producción a partir de [`.env.example`](../.env.example).
2. En la compu de desarrollo, crear `deploy.local.env` (no se sube al repositorio):

   ```bash
   VPS_IP=1.2.3.4
   VPS_USER=root
   VPS_PATH=/var/www/presupuestos
   ```

3. Tener acceso por SSH con clave al VPS.
4. En Nginx Proxy Manager: Proxy Host → `presupuestos.tudominio.com` → `presupuestos-app:3002`, con certificado de Let's Encrypt y *Force SSL*. El contenedor y el proxy comparten la red externa `nginx_network`.

## Deploy

```bash
bash deploy_to_vps.sh
```

Qué hace:
1. Prueba el SSH.
2. Empaqueta el proyecto con `tar`, sin `node_modules`, `.git`, `data`, `.env` ni archivos locales de deploy, y lo sube por SSH.
3. Si el VPS ya tiene `.env`, **no lo toca**. Solo sube el local si el servidor no tiene ninguno.
4. Reconstruye y levanta el contenedor con `docker compose up -d --build`.
5. Hace un healthcheck contra `/health`.

Los datos viven en el volumen `presupuestos_data` y sobreviven a los rebuilds.

## Después de un deploy

- Subir la versión de `CACHE` en `public/sw.js` cuando cambia un archivo del frontend, o el celular sigue mostrando la copia guardada.
- Los `<script>` llevan `?v=N`: subir el número del archivo que cambió.
- En el celular, recargar la página una vez.

## Comprobar que quedó bien

```bash
ssh <usuario>@<ip> "docker logs --tail 5 presupuestos-app"
```

Al arrancar, el log muestra los accesos y qué proveedor de IA atiende cada tarea:

```
[presupuestos] Escuchando en http://localhost:3002  (accesos: principal, ...)
[presupuestos] IA: suggest→groq  ...  voz_cortar→groq  voz_turno→claude
```

Si una tarea dice `sin configurar`, falta la clave de ese proveedor en el `.env` del servidor.

## Volver a la versión anterior

El VPS no es un checkout de git: es una copia de archivos. Para volver atrás:

```bash
git checkout <commit-anterior>
bash deploy_to_vps.sh
git checkout -
```

La base de datos no se toca en el deploy. Las migraciones solo agregan tablas y columnas, así que una versión anterior sigue funcionando con una base más nueva.

## Cambiar una variable en producción

```bash
ssh <usuario>@<ip> "cd /var/www/presupuestos && nano .env && docker compose up -d --force-recreate"
```

`--force-recreate` hace falta para que el contenedor tome el `.env` nuevo.

## Problemas conocidos

| Síntoma | Causa | Qué hacer |
|---|---|---|
| El modo voz no muestra subtítulos en vivo | La clave de ElevenLabs no tiene el permiso *Speech to Text* | Habilitarlo en ElevenLabs → API Keys. Mientras tanto anda con Whisper |
| En el celular la app se ve vieja | Service worker con la versión anterior | Subir `CACHE` en `sw.js` y recargar |
| "Se alcanzó el límite de IA" | Cuota del proveedor | Revisar el saldo en la consola del proveedor |
