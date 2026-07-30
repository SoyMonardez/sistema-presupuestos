# Plan: Sistema de Presupuestos v2 — asistente IA + app móvil

## Contexto

La app hoy funciona: crea presupuestos por ítems, dicta por voz, importa PDF/Excel/CSV, corrige ortografía y exporta PDF. Pero tiene cuatro problemas que se acumulan:

1. **El usuario real (el papá) se frustra.** El autocompletado hace saltar la pantalla en cada letra, y el gesto de "volver" del celular lo saca de la app en vez de cerrar la modal. Son dos bugs con causa identificada.
2. **Las unidades son texto libre.** El campo unidad es un `<input type="text">` (`app.js:405`), así que conviven "m2", "m²" y "metros cuadrados". Eso hace imposible cualquier conversión automática confiable, y es la raíz del trabajo manual que hace hoy.
3. **La IA está limitada por diseño.** Todo pasa por `callGroq` con `response_format: json_object` forzado: no hay conversación, no hay imágenes, no hay historial, no hay forma de que la IA consulte los datos guardados. Además el modelo por defecto (`llama-3.3-70b-versatile`) fue deprecado por Groq el 17/06/2026.
4. **La UI es una SPA de tres vistas planas**, sin navegación, gestos ni feedback de carga de app de celular.

### El flujo real que hay que resolver

Esto es lo que define el plan, y vale la pena escribirlo explícito:

> Él pasa el presupuesto en **m²**. El cliente o el municipio le devuelve **una hoja con la propuesta de cambios, con las cosas en m³**. Hoy tiene que sacar las cuentas a mano, ítem por ítem.

La consecuencia de diseño es grande: **la medida que falta para convertir (el espesor) viene en esa hoja.** No hay que inventarla ni preguntársela — hay que leerla. Por eso "conversión de unidades" y "leer una captura o un archivo" no son dos funciones separadas: son la misma función, y es la de mayor valor de todo el proyecto.

**Restricción de trabajo:** cada fase queda funcionando y probable en Docker por separado. No se rompe nada que hoy ande.

**Decisiones tomadas:** Claude (`claude-sonnet-5`) para tareas pesadas · Groq para las rápidas y la búsqueda web · tema claro + oscuro con selector (oscuro en negros neutros, sin azul) · catálogo de unidades fijo pero ampliable por él desde Precios base · conversión disponible desde el presupuesto **y** desde el chat, sobre un ítem o sobre todo · arrancamos por la base técnica.

---

## Principio rector

El código ya tiene el patrón correcto y hay que extenderlo, no reemplazarlo: en `resolveConvert()` (`server/routes/ai.js:187`) **la IA solo extrae datos y el JavaScript hace las cuentas**. Y ninguna IA escribe en la base: propone `ops`, el usuario confirma en el panel de borrador (`showOps`, `public/js/app.js:754`).

Todo lo nuevo respeta las dos reglas: **la IA extrae y propone, el servidor calcula y el usuario confirma.**

---

## Fase 1 — Cimientos: proveedor, unidades y navegación

### 1.1 Modelo de Groq deprecado

`server/groq.js:2` y `.env.example:17` usan `llama-3.3-70b-versatile`, deprecado. Cambiar a **`qwen/qwen3.6-27b`**: multimodal, con JSON mode y tool use, así que es reemplazo directo y además respaldo barato para visión.

### 1.2 Capa de proveedor — `server/ai/provider.js` (nuevo)

Hoy `callGroq` está importado directo en `server/routes/ai.js:3` y `server/routes/import.js:8`. Reemplazar por una función única:

```
complete({ task, system, messages, images, tools, schema })
```

- `server/ai/providers/groq.js` — el `fetch` actual de `groq.js`, movido tal cual.
- `server/ai/providers/claude.js` — SDK oficial `@anthropic-ai/sdk`, modelo `claude-sonnet-5`.
- Ruteo por tarea vía variables de entorno (`AI_ROUTE_COMMAND=claude`, `AI_ROUTE_SUGGEST=groq`, …), para mover una tarea de proveedor sin tocar código.

| Tarea | Proveedor | Motivo |
|---|---|---|
| `suggest`, `spellcheck`, `transcribe` | Groq | Latencia crítica / mecánico / Whisper anda muy bien |
| `parse` | Groq | Se puede subir a Claude si notás errores de precio |
| `command`, `chat`, `vision` | Claude | Error = presupuesto corrupto frente a un cliente |
| `web_search` | Groq compound | Búsqueda integrada con Tavily, barata |

**Tres detalles de migración que rompen si se pasan por alto:**

- Los 6 endpoints actuales pasan `temperature` (0 a 0.4). **Claude Sonnet 5 rechaza `temperature`/`top_p`/`top_k` con error 400.** El adaptador de Claude tiene que descartarlo, no reenviarlo.
- El truco de `response_format: { type: 'json_object' }` (`server/groq.js:20`) no existe igual en Claude: se usa `output_config: { format: { type: 'json_schema', schema } }`. La capa recibe `schema` y cada adaptador lo traduce.
- Para `command` y `vision`, `thinking: { type: 'adaptive' }` con `output_config: { effort: 'medium' }` — más preciso en conversiones, costo controlado.

`.env.example` suma `ANTHROPIC_API_KEY` y las `AI_ROUTE_*`. `package.json` suma `@anthropic-ai/sdk` (regenerar `package-lock.json`, el Dockerfile usa `npm ci`).

### 1.3 Catálogo de unidades — el cambio de fondo

Hoy las unidades están escritas en **cinco lugares distintos** y ninguno manda: el input de texto libre (`app.js:405`), tres listas hardcodeadas en prompts (`ai.js:15`, `ai.js:40`, `ai.js:175`), y `CONVERT_UNITS` con solo 4 opciones (`app.js:566`). Unificar en una única fuente de verdad.

**Tabla nueva `units`** en `server/db.js`:

| Campo | Para qué |
|---|---|
| `code` | Clave canónica: `m2`, `m3`, `ml`, `un`, `kg`… |
| `label` | Cómo se muestra y se imprime en el PDF: `m²`, `m³`, `m` |
| `kind` | `length` · `area` · `volume` · `count` · `weight` · `time` · `other` |
| `dims` | Qué medidas hacen falta para calcular la cantidad: `[]`, `["largo"]`, `["largo","ancho"]`, `["largo","ancho","alto"]` |
| `is_custom` | Si la dio de alta él |
| `position` | Orden en el selector |

Se siembra con las unidades que ya usan los prompts (m², m, un., kg, lt, hs, saco, día, global) más m³. **Él puede agregar las suyas desde Precios base** (ej: "viaje de arena", "bolsón"), indicando si son convertibles y con qué medidas — si las deja como `other`, la IA tiene prohibido inventarles una conversión.

- `GET/PUT /api/units` en `server/routes/prices.js` (la vista de Precios base ya tiene el patrón de guardado por reemplazo completo, `prices.js:13`).
- `unitsPromptBlock()` genera la lista para los prompts desde la tabla, igual que `priceRefsPromptBlock()` (`prices.js:39`). Las tres listas hardcodeadas se borran.
- **Normalizador de variantes** en `server/lib/units.js`: `"m2"`, `"M2"`, `"mts2"`, `"metros cuadrados"`, `"m^2"` → `m2`. Se aplica una vez sobre los datos que ya existen (los presupuestos guardados tienen unidades a mano) y después en cada escritura, en `replaceItems` (`budgets.js:63`) y en `normalizeOp`.

### 1.4 Motor de conversión — `server/lib/units.js` (nuevo)

Hoy la matemática está escrita **dos veces**: `resolveConvert()` (servidor, `ai.js:187`) y `renderConvertResults()` (cliente, `app.js:573`). Con el chat serían tres. Se extrae acá y todos la usan.

La regla que ya existe y se mantiene: **el total del ítem no cambia.** Se recalculan cantidad y precio unitario para que el trabajo siga costando lo mismo, solo expresado en otra unidad. Eso es lo que la modal actual promete (`index.html:232`) y es lo correcto: al municipio le cambia la presentación, no el precio.

Dos caminos de cálculo, y el primero es nuevo:

**A) Por factor dimensional — el caso común, una sola medida.**
Si un ítem está en m² y hay que pasarlo a m³, alcanza con el espesor: `cantidad_nueva = cantidad_vieja × espesor`. No hace falta la geometría completa de la pieza.

| Conversión | Medida que pide |
|---|---|
| m → m² | ancho |
| m² → m³ | espesor |
| m³ → m² | espesor (divide) |
| m² → m | ancho (divide) |

Esto importa porque **es exactamente un número, y ese número viene en la hoja que le dan.**

**B) Por geometría completa** — el camino que ya existe: piezas + largo/ancho/alto. Sirve cuando el ítem está en "un." y hay que expresarlo en m³ (ej: "12 plateas de 1.10 × 2 × 0.15").

**Conversiones prohibidas:** entre familias incompatibles (hs → m², kg → m³ sin densidad) el motor devuelve error y la IA tiene instrucción explícita de no inventar factores. Este es el punto donde un modelo sin frenos hace desastres.

### 1.5 Módulo de operaciones — `server/lib/ops.js` (nuevo)

Mover `normalizeOp()` (`ai.js:210`) para que `/command`, el chat y la visión validen con el mismo código. La op `convert` pasa a aceptar **varios ítems**: `nums: [1,3,5]` o `all: true`, además del `num` suelto de hoy.

### 1.6 Esquema de chat — `server/db.js`

- `chat_conversations` — `id`, `budget_id` (FK `ON DELETE CASCADE`, como `items`), `title`, `created_at`, `updated_at`.
- `chat_messages` — `id`, `conversation_id` (FK cascade), `role`, `content`, `tool_json`, `created_at`.

Índices por `budget_id` y `conversation_id`. Si después faltan columnas, ya está `addColumnIfMissing()` (`db.js:47`).

### 1.7 Navegación tipo app — `public/js/nav.js` (nuevo)

**Nav inferior de 3 pestañas dentro del editor**, con swipe y gesto de volver:

| Pestaña | Contenido |
|---|---|
| **Presupuesto** | Los ítems + total (lo que hoy es `#view-editor`) |
| **Chat** | El asistente de este presupuesto (Fase 3) |
| **PDF** | Formato, datos del cliente, condiciones de pago + botón grande de descargar |

Mover formato y datos del cliente a la pestaña PDF descomprime el editor, que hoy los tiene apilados arriba de los ítems (`index.html:87-136`). Ahí tienen más sentido: son cosas del documento, no del presupuesto.

- **Swipe:** las 3 pestañas en un track con `transform: translateX()`. Bloqueo de eje en `touchstart/touchmove` (si el gesto arranca más vertical que horizontal, gana el scroll) para no pelear con el scroll de los ítems.
- **Gesto de volver — el problema del papá:** un stack de capas atado a la History API. Abrir una modal hace `history.pushState`; un handler de `popstate` cierra la capa de arriba. El botón X y el gesto del celular pasan **por el mismo camino** (`history.back()`), así que no se desincronizan. Solo cuando no queda ninguna capa abierta el gesto sale de la app. Reemplaza los handlers de Escape y click-en-overlay repetidos en `app.js:535-538` y `app.js:631-634`.

> **Ojo con el service worker:** `public/sw.js` cachea una lista fija (`SHELL`, línea 3). Cada JS nuevo hay que agregarlo ahí **y** subir `CACHE = 'presupuestos-v3'`, o en el celular vas a seguir viendo la versión vieja y te vas a volver loco debuggeando.

**Se prueba:** deslizar entre las 3 pestañas · abrir una modal y cerrarla con el gesto del celular sin salir de la app · dar de alta una unidad propia en Precios base y verla en el selector.

---

## Fase 2 — Selector de unidades, rediseño móvil y el bug del autocompletado

### 2.1 Selector de unidades y conversión desde el presupuesto

- El input de texto libre de la unidad (`app.js:405`) pasa a ser un **selector** que abre una hoja inferior con las unidades del catálogo. Sin teclado, sin errores de tipeo.
- **Botón "Convertir" del ítem** (ya existe, `.ic-convert-toggle`, `app.js:456`): se rediseña. Muestra la unidad actual, deja elegir la unidad destino entre las compatibles, y pide **solo la medida que falte** (una sola, por el camino A). El camino B (geometría completa) queda disponible como opción desplegable para el caso de "un." → m³.
- **Botón "Convertir presupuesto"** en la barra del total: elegís unidad origen y destino, se muestran los ítems afectados con su resultado, y se aplican todos juntos por el panel de borrador.

### 2.2 El bug del autocompletado (causa confirmada)

Tres cosas se suman:

1. `#item-modal-suggest` (`index.html:214`) es un div **en flujo normal**, entre el textarea del nombre y la etiqueta de especificaciones. `.modal-suggest` es `display: flex` (`app.css:784`): al mostrarse y ocultarse cambia la altura de todo lo de abajo.
2. `scheduleSuggest()` llama a `hideSuggest()` **en cada tecla** (`app.js:639`) y recién muestra 600 ms después. Colapsa y expande constantemente.
3. `.modal-box` está anclada al fondo en celular (`align-items: flex-end`, `app.css:731`), así que cualquier cambio de altura mueve el borde superior **de abajo hacia arriba** — exactamente lo que él describe. Y `autoGrow()` (`app.js:522`) le cambia la altura al textarea en cada tecla, encima de todo.

**Arreglo:** las sugerencias pasan a `position: absolute` ancladas bajo el textarea (dejan de empujar nada) · no se vacían en cada tecla, se mantienen las anteriores hasta que llegan las nuevas · `autoGrow()` solo escribe `style.height` si cambió de verdad, y no achica mientras el campo tiene foco.

### 2.3 Tema claro / oscuro

El CSS ya usa variables en `:root` (`app.css:3-16`), así que es acotado: paleta clara en `:root`, oscura en `[data-theme="dark"]`.

- Oscuro en **negros neutros** (`#141416`, superficie `#1c1c1f`, elevada `#26262b`) — se va el `#14161f` actual, que es el azul oscuro que no querés.
- Arranca siguiendo `prefers-color-scheme`, se fuerza con un selector que guarda en `localStorage`.
- Actualizar `<meta name="theme-color">` (`index.html:6`) por JS al cambiar, para que la barra de estado acompañe.

### 2.4 Sensación de app nativa

Skeletons con shimmer (lista, ítems, chat) · micro-animaciones extendiendo el `@keyframes modalUp` que ya existe (`app.css:749`) · transición entre pestañas · entrada escalonada de tarjetas · todo bajo `@media (prefers-reduced-motion: reduce)` · áreas táctiles de 44px mínimo y `env(safe-area-inset-bottom)`, como ya hace `.totalbar`.

**Se prueba:** escribir el nombre de un ítem letra por letra en el celular y que **nada se mueva** · convertir un ítem de m² a m³ poniendo solo el espesor · convertir el presupuesto entero.

---

## Fase 3 — La hoja de cambios: visión e importación

> Esta es la fase que resuelve el flujo real. **No depende del chat**, así que se puede hacer antes que la Fase 4 si querés el resultado más rápido.

### 3.1 Imágenes y archivos

**No hace falta tocar el límite de `express.json` (512 kb, `index.js:21`).** El patrón correcto ya está en el repo: `express.raw({ type: () => true, limit: '20mb' })` (`import.js:17`). Se copia para las rutas de imagen; Groq acepta hasta 20 MB por request, así que calza.

Puntos de entrada: el botón **Importar** acepta `.jpg/.png/.heic` además de PDF/Excel/CSV (`index.html:157`), y se puede **adjuntar una imagen en el chat** (Fase 4).

### 3.2 Modo "hoja de propuesta de cambios"

El caso central. Distinto de importar, porque acá el presupuesto **ya existe** y la hoja dice qué cambiar:

1. Se le manda al modelo la foto o el archivo **junto con los ítems actuales** numerados.
2. El modelo **compara** y devuelve operaciones: qué ítem de la hoja corresponde a qué ítem del presupuesto, qué unidad piden, y **qué medida trae la hoja** (el espesor que faltaba).
3. Las medidas extraídas entran a `server/lib/units.js` y **la cuenta la hace el servidor**, nunca el modelo.
4. Todo cae en el panel de borrador existente, con el antes y el después de cada ítem, para confirmar.

**Salvaguardas obligatorias:** si un ítem de la hoja no matchea con ninguno del presupuesto, se reporta, no se adivina · si falta la medida para una conversión, ese ítem queda sin convertir con el aviso de qué falta · si la hoja pide una conversión entre familias incompatibles, se rechaza.

### 3.3 Extracción mejorada de archivos

`server/scripts/extract.py` ya intenta detectar tablas y, si no puede, devuelve texto crudo para que lo interprete la IA (`import.js:70-75`). Dos mejoras:

- Cuando cae en `source === 'text'` con un PDF, mandar además **la página como imagen** al modelo de visión. Los PDFs con columnas raras rompen el parser de texto pero se leen perfecto como imagen.
- Pasarle al prompt los encabezados que sí detectó como pistas, aunque no haya podido mapear todas las columnas.

**Se prueba:** foto de una hoja de propuesta con las cosas en m³ → los ítems correspondientes se convierten con el espesor de la hoja y el total de cada uno no cambia.

---

## Fase 4 — Chatbot: asistente y copiloto

Un chat que **ve los datos de tu viejo**. Esa es la única razón por la que le gana a Gemini: no responde "¿cuánto se cobra el revoque?" sino "vos cobraste esto en tus últimos 3 presupuestos".

### 4.0 Dos alcances y un atajo

| Dónde | Qué sabe | Para qué |
|---|---|---|
| **Chat global** (desde la lista) | El tarifario y el histórico de presupuestos | Estimar un trabajo nuevo desde cero ("me quieren alquilar tal máquina, la hora sale tanto, ¿cuánto le cobro?", con foto del lugar) y **crear el presupuesto** con lo que salga de esa charla |
| **Chat del presupuesto** (pestaña) | Además, los ítems, totales y unidades de ese presupuesto | Modificar, convertir, simular y consultar sobre el trabajo que está armando |
| **Atajo desde un ítem** | Lo mismo, pero con un ítem señalado | Tocar el ítem 3 abre el chat con "Trabajando sobre: ítem 3 — Plateas de hormigón", y desde ahí adjunta la foto y escribe corto, sin tener que describir de cuál habla |

### 4.1 Las cuatro cosas que tiene que saber hacer

1. **Convertir** — "pasá el ítem 3 y el 5 a metros cúbicos" o "pasá todo el presupuesto a m³". Ya está el motor; el chat solo lo invoca.
2. **Simular sin tocar nada** — *la capacidad nueva más importante*. "¿Cuánto me daría si le bajo un 10%?" o "¿y si le saco 5 m²?" → la IA calcula sobre los números reales y **responde con el resultado sin modificar el presupuesto**. Él mira, y recién ahí dice "sí, aplicalo" o "no, dejalo como está".
3. **Averiguar precios de hoy** — "¿cuánto sale el metro cuadrado hoy?" → búsqueda web, respuesta con la fuente citada, jamás aplicada sola.
4. **Estimar un trabajo nuevo** — con una foto del lugar y un dato de partida ("la hora sale tanto"), devuelve una estimación desglosada. Él decide el precio final.

### 4.2 Cómo se aplica un cambio (el punto delicado)

El principio del proyecto sigue en pie —la IA nunca escribe sola— pero la confirmación ahora es **conversacional**, no un panel más:

1. La IA propone y el mensaje trae una tarjeta con los números: qué ítems toca, total antes y total después.
2. Él confirma **de las dos formas**: tocando "Aplicar" en la tarjeta, o escribiendo "sí, aplicalo". Las dos hacen exactamente lo mismo.
3. Si dice que no, la propuesta queda descartada y la conversación sigue.

Poner un segundo panel de confirmación arriba de un "sí aplicalo" que ya dijo sería redundante y molesto. La frase **es** la confirmación.

### 4.3 Endpoints — `server/routes/chat.js` (nuevo)

`GET/POST /api/chats` (globales) · `GET/POST /api/budgets/:id/chats` · `GET /api/chats/:id/messages` · `POST /api/chats/:id/messages` (con imagen opcional y `item_num` opcional para el atajo) · `POST /api/chats/:id/apply` · `DELETE /api/chats/:id`

Sin streaming en esta fase (respuesta completa con skeleton). Streaming SSE queda anotado para después.

### 4.2 Herramientas que el modelo puede invocar

Ejecutadas en el servidor contra SQLite. Esto es lo que lo hace útil:

| Herramienta | Qué hace |
|---|---|
| `get_budget_items` | Ítems actuales + subtotales y total |
| `get_price_refs` | El tarifario de `price_refs` |
| `search_past_budgets` | Histórico: qué cobró antes por algo parecido y a quién |
| `convert_units` | Usa `server/lib/units.js` — **un ítem, varios o todo el presupuesto**, con matemática exacta |
| `simulate_changes` | **Calcula el resultado sin tocar nada**: totales antes y después de bajar un porcentaje, cambiar una cantidad o convertir. Es lo que contesta "¿cuánto me daría si…?" |
| `web_search` | Groq compound (`groq/compound-mini`, Tavily) para precios de mercado actuales |
| `propose_changes` | Deja una propuesta pendiente con su preview; se aplica solo cuando él confirma |
| `create_budget` | Solo en el chat global: crea un presupuesto nuevo con los ítems que salieron de la charla |

Pasar el tarifario como herramienta y no como contexto fijo importa: `priceRefsPromptBlock()` (`prices.js:39`) mete hasta 150 líneas en el prompt, y en un chat de 20 mensajes eso se paga 20 veces.

**Regla dura:** `web_search` y `propose_item_changes` nunca aplican nada solos. Los precios de internet se muestran como sugerencia con la fuente citada; los cambios caen en el panel de borrador.

### 4.3 Aplicar cambios desde el chat

Se reutiliza **el mismo panel de borrador** de `/command` y de la importación (`app.js:754`). Cero interfaz nueva, y el papá ya conoce el flujo de revisar y confirmar.

**Endurecimiento necesario:** las `ops` referencian ítems por número (`num`, 1-based). Si se edita un ítem entre que el bot propone y el usuario confirma, la operación cae en el ítem equivocado. Hoy `/command` tiene la misma falla latente. Agregar a cada op el nombre esperado del ítem y verificarlo al aplicar; si no coincide, descartar esa op y avisar, en vez de romper el presupuesto en silencio.

### 4.4 Prompt del asistente

Extiende el estilo de `COMMAND_SYSTEM` (`ai.js:160`): presupuestista argentino, jerga de plata (luca, palo, gamba), tarifario con prioridad absoluta, catálogo de unidades desde `unitsPromptBlock()`. Suma: conversar y asesorar, explicar diferencias entre materiales o técnicas, planificar etapas, y proponer cambios cuando corresponde.

**Se prueba:** "¿cuál es la diferencia entre revoque grueso y fino y cuál me conviene acá?" · "pasá todo el presupuesto a metros cúbicos" y que dé lo mismo que el botón manual.

---

## Fase 5 — Ajustes finos

Streaming SSE en el chat · títulos automáticos de conversación · corregir `README.md:8`, que dice que la voz usa Web Speech API cuando desde `d7484cd` usa Whisper por servidor.

---

## Verificación

Después de cada fase, en casa:

```bash
docker compose up -d --build
# → http://localhost:3002
```

En el `.env`: `APP_PASSWORD`, `APP_SECRET`, `GROQ_API_KEY` y, desde la Fase 1, `ANTHROPIC_API_KEY`.

**Antes de probar en el celular:** desregistrar el service worker o hard-reload. Si el `CACHE` de `sw.js` no subió de versión vas a estar mirando archivos viejos.

| Fase | Qué tiene que pasar |
|---|---|
| 1 | Todo lo que andaba sigue andando con la capa de proveedor en el medio · las 3 pestañas se deslizan · el gesto de volver cierra la modal en vez de salir · las unidades viejas quedaron normalizadas y podés dar de alta una propia |
| 2 | Escribir un nombre de ítem letra por letra sin que nada salte · el tema persiste al recargar · convertir un ítem de m² a m³ con solo el espesor · convertir el presupuesto entero |
| 3 | Foto de una hoja de propuesta en m³ → los ítems se convierten con la medida de la hoja y el total de cada uno no cambia |
| 4 | El chat responde una consulta de asesoramiento, usa tu tarifario, y una conversión que propone da igual que la del botón manual |

**Prueba de regresión en cada fase** (lo que hoy funciona y no se puede romper): crear presupuesto → dictar por voz → corregir ortografía → convertir una unidad a mano → exportar el PDF en formato Cliente y en formato Municipio.

---

## Archivos principales

**Nuevos:** `server/ai/provider.js`, `server/ai/providers/{groq,claude}.js`, `server/lib/{units,ops}.js`, `server/routes/chat.js`, `public/js/nav.js`, `public/js/chat.js`

**Modificados:** `server/groq.js` (se vacía hacia el adaptador), `server/routes/{ai,import,prices,budgets}.js`, `server/db.js`, `server/index.js`, `server/scripts/extract.py`, `public/index.html`, `public/css/app.css`, `public/js/{app,api,pdf}.js`, `public/sw.js`, `.env.example`, `package.json`

**Se reutiliza (no reescribir):** el panel de borrador `showOps`/`describeOp` (`app.js:721-801`), `normalizeOp`/`resolveConvert` (`ai.js:187-247`), `priceRefsPromptBlock` (`prices.js:39`), el guardado por reemplazo completo de Precios base (`prices.js:13`), el patrón `express.raw` (`import.js:17`), `addColumnIfMissing` (`db.js:47`), los helpers de números `parseNum`/`parseQty`/`fmtMoneyInput` (`app.js:43-76`).
