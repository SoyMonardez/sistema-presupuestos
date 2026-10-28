# Referencia de la API

API REST en JSON servida por Express. Todas las rutas salvo `/health` y `/api/login` piden un token:

```
Authorization: Bearer <token>
```

El token sale de `/api/login`, vence a los días configurados y lleva el **acceso** (cada acceso tiene su propia base de datos). Los errores siempre tienen la forma `{ "error": "mensaje para mostrar" }`.

| Código | Cuándo |
|---|---|
| `400` | Faltan datos o vienen mal |
| `401` | Sin token, token vencido o contraseña incorrecta |
| `404` | El presupuesto o la conversación no existen |
| `422` | La IA no encontró nada útil (audio sin voz, archivo sin items) |
| `429` | Demasiados intentos de login (10 cada 15 minutos por IP) |
| `502` | Falló el proveedor de IA |
| `503` | La función necesita una clave que no está configurada |

## Sesión

### `POST /api/login`

```json
{ "password": "..." }
```
→ `200 { "token": "..." }`. La contraseña elige el acceso (`APP_PASSWORD` o `APP_PASSWORD_<NOMBRE>`).

### `GET /health`
→ `200 { "ok": true }`. Lo usa el healthcheck del deploy.

## Presupuestos — `/api/budgets`

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/` | Lista con `total` e `item_count` |
| `POST` | `/` | Crea: `{ name, client }` |
| `GET` | `/:id` | Presupuesto con sus `items` y `total`. Prepara el historial si es la primera vez |
| `PUT` | `/:id` | Actualiza el encabezado (nombre, cliente, ubicación, validez, anticipo, formato del PDF, datos municipales) |
| `DELETE` | `/:id` | Borra el presupuesto, sus items y su historial |
| `PUT` | `/:id/items` | Reemplaza la lista completa de items y registra una versión en el historial |

`PUT /:id/items`:

```json
{
  "items": [
    { "uid": "3f1c…", "name": "Contrapiso", "detail": "", "quantity": 20, "unit": "m²", "unit_price": 15000 }
  ]
}
```

- `uid` identifica al item a lo largo del historial; si falta, se genera.
- La unidad se normaliza contra el catálogo ("m2" → "m²").
- Header opcional `X-Origen: voz | chat | ia | deshacer | manual` para saber quién hizo el cambio.

## IA — `/api/ai`

| Método | Ruta | Qué hace |
|---|---|---|
| `POST` | `/transcribe` | Audio crudo (body binario) → `{ text }`. Con `?voz=1&budget=ID` usa el vocabulario del presupuesto y filtra lo que no es voz |
| `POST` | `/speak` | `{ text, rapida? }` → `audio/mpeg`. `rapida` usa la voz de baja latencia |
| `POST` | `/command` | `{ text, items }` → `{ ops, summary }`: editar items con lenguaje natural |
| `POST` | `/parse` | `{ text }` → `{ items }`: texto libre a items |
| `POST` | `/vision` | Foto (body binario), `?ext=jpg&mode=import\|changes&budget=ID` → items nuevos o cambios contra el presupuesto |
| `POST` | `/suggest` | `{ query, items }` → sugerencias mientras se escribe un item |
| `POST` | `/spellcheck` | `{ texts }` → los mismos textos corregidos |
| `POST` | `/client-data` | `{ name }` → datos del cliente para la cabecera |

### Operaciones

Lo que propone la IA llega como operaciones ya validadas por el servidor:

```json
[
  { "action": "add",    "item": { "name": "Demolición", "quantity": 1, "unit": "m²", "unit_price": 320000 } },
  { "action": "update", "num": 2, "fields": { "unit_price": 18000 } },
  { "action": "remove", "num": 3 }
]
```

`num` es el número de item como lo ve el usuario (empieza en 1). Las conversiones de unidad (`convert`) llegan ya traducidas a `update`, con la cuenta hecha por el servidor.

## Conversación por voz — `/api/voz`

### `POST /token`
`{ budget }` → `{ token, keyterms }`. Token de un solo uso para abrir el WebSocket de ElevenLabs Scribe desde el navegador, y los términos que el reconocedor tiene que preferir.

### `POST /cortar`
```json
{ "resto": "", "nuevo": "agregá demolición a 300 mil y un contrapiso de", "final": false }
```
→
```json
{
  "instrucciones": [{ "texto": "agregá demolición a 300 mil", "tipo": "pedido" }],
  "resto": "y un contrapiso de",
  "acuse": "Dale, anoto la demolición"
}
```
`tipo` puede ser `pedido`, `confirmar`, `confirmar_todo`, `rechazar`, `deshacer` o `salir`.

### `POST /turno` — Server-Sent Events
```json
{
  "instrucciones": ["agregá demolición, uno, metro cuadrado, 320 mil"],
  "presupuesto": 12,
  "items": [ ... ],
  "encabezado": { "name": "Casa Pérez" },
  "historial": [ { "rol": "usuario", "texto": "..." }, { "rol": "asistente", "texto": "..." } ],
  "auto": true
}
```

Eventos, en este orden:

| Evento | Datos |
|---|---|
| `pensamiento` | `{ text }` — pedazo de lo que va a hacer |
| `ops` | `{ ops, warnings, encabezado }` — validado; llega antes de que termine la respuesta |
| `respuesta` | `{ text }` — pedazo de lo que va a decir |
| `done` | `{ pensamiento, respuesta }` |
| `error` | `{ error }` |

## Chat del asistente — `/api`

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/budgets/:id/chats` | Conversaciones de un presupuesto |
| `POST` | `/budgets/:id/chats` | Nueva conversación: `{ mode: asistente \| investigador \| presupuestador }` |
| `PATCH` | `/chats/:id` | Cambiar el modo |
| `GET` | `/chats/:id/messages` | Mensajes |
| `POST` | `/chats/:id/messages` | Mandar un mensaje (respuesta entera) |
| `POST` | `/chats/:id/messages/stream` | Mandar un mensaje con respuesta por SSE: `delta`, `status`, `done`, `error` |
| `DELETE` | `/chats/:id` | Borrar la conversación |

Solo el modo `presupuestador` devuelve operaciones sobre el presupuesto. El modo `investigador` puede buscar precios en internet (evento `status` con `fase: "buscando"`).

## Catálogos y ajustes

| Ruta | Qué hace |
|---|---|
| `GET` / `PUT /api/prices` | Tarifario propio: `{ prices: [{ name, price, unit }] }` |
| `GET` / `PUT /api/units` | Catálogo de unidades, incluidas las propias |
| `POST /api/units/plan` | `{ from }` → a qué unidades se puede convertir y qué medida hace falta |
| `POST /api/units/convert` | `{ items, target_unit, medidas }` → operaciones con la cuenta hecha |
| `GET` / `PUT /api/settings` | Estructura de costos: gastos generales, utilidad, ingresos brutos, IVA |
| `POST /api/import?ext=pdf\|xlsx\|csv` | Archivo crudo → `{ items }` |
