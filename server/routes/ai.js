import express from 'express';
import { Router } from 'express';
import { complete, transcribeAudio } from '../ai/provider.js';
import { ITEMS_SCHEMA, TEXTS_SCHEMA, SUGGESTIONS_SCHEMA, CLIENT_SCHEMA } from '../ai/schemas.js';
import { normalizeOps } from '../lib/ops.js';
import { canonicalLabel } from '../lib/units.js';
import { prepareForVision } from '../lib/images.js';
import db, { loadUnitCatalog } from '../db.js';
import { priceRefsPromptBlock } from './prices.js';
import { unitsPromptBlock } from './units.js';

const router = Router();

const PARSE_SYSTEM = `Sos un presupuestista experto en construcción y refacciones en Argentina. Convertís descripciones habladas o escritas de trabajos en items de presupuesto. El usuario dicta por voz, así que el texto puede venir desprolijo, sin puntuación y con jerga.

Reglas:
- Devolvé SOLO un JSON con esta forma exacta: {"items":[{"name":"...","detail":"...","quantity":N,"unit":"...","unit_price":N}]}
- "name": nombre claro y profesional del item, con mayúscula inicial (ej: "Demolición de pared de ladrillo", "Construcción de Tabiquería Interior").
- "detail": especificaciones del item, una por línea separadas con \\n (ej: "Medidas: 10.00 m lineales x 2.50 m de alto\\nEstructura: Zapata corrida y columnas de amarre"). Incluí acá medidas, materiales y aclaraciones que mencione el usuario. Si no hay detalles, usar "".
- "quantity": número. Si no se menciona, usar 1.
- "unit": una de las etiquetas de la lista de unidades de abajo, tal cual está escrita. Si no está claro, "un.".
- "unit_price": precio unitario en pesos argentinos, número sin separadores.
- Jerga de plata argentina: "luca" = 1.000 (ej "15 lucas" = 15000), "un palo" = 1.000.000, "gamba" = 100, "20 mil" = 20000, "k" = 1000.
- Si dicen el precio total de varias unidades (ej "3 puertas por 300 mil"), calculá el precio unitario (100000).
- Si NO mencionan precio, estimá un precio de mercado realista en pesos argentinos actuales (tené en cuenta la inflación: los precios de construcción en Argentina son altos, ej. la hora de albañil ronda decenas de miles de pesos, no cientos). El usuario siempre revisa y corrige antes de confirmar.
- Si mencionan un trabajo grande sin detallar (ej "hacer un baño completo"), desglosalo en sus items típicos (demolición, materiales, colocación, plomería, mano de obra, etc.).
- Si el texto no contiene ningún trabajo o item reconocible, devolvé {"items":[]}.`;

const SPELL_SYSTEM = `Sos un corrector ortográfico de español rioplatense (Argentina) para descripciones de presupuestos de construcción. Te paso una lista de textos y devolvés cada uno corregido.

Reglas:
- Devolvé SOLO un JSON con esta forma exacta: {"texts":["...","..."]} con la MISMA cantidad de elementos y en el MISMO orden que recibiste.
- Corregí faltas de ortografía, tildes y errores de tipeo.
- Poné mayúscula inicial al empezar cada oración y agregá el punto final si la oración no termina con signo de puntuación (. ! ? :).
- Si un texto tiene varias líneas (separadas por \\n), corregí cada línea por separado y mantené los saltos de línea.
- NO cambies el significado, NO traduzcas, NO agregues ni quites información.
- NO toques números, medidas, unidades (m², m³, kg, hs), precios ni nombres propios (ej: "Plaza Gertrudis Funes", "Municipalidad de la Capital").
- Si un texto ya está bien o está vacío, devolvelo igual.`;

const SUGGEST_SYSTEM = `Sos un asistente de presupuestos para un trabajador argentino (construcción, refacciones, servicios). El usuario está escribiendo el nombre de un item y necesitás sugerir cómo completarlo.

Reglas:
- Devolvé SOLO un JSON con esta forma: {"suggestions":[{"name":"...","unit":"...","unit_price":N}]}
- Máximo 3 sugerencias, ordenadas por relevancia.
- "name": nombre completo y profesional del item que empieza o se relaciona con lo que escribió el usuario.
- "unit": una de las etiquetas de la lista de unidades de abajo, tal cual está escrita.
- "unit_price": precio estimado de mercado en pesos argentinos actuales (número, sin separadores). Tené en cuenta la inflación argentina: los precios de construcción son altos (la hora de albañil ronda decenas de miles de pesos, el m² de colocación de cerámica también). Si no tenés idea, usá 0.
- Tené en cuenta los items que ya cargó (te los paso como contexto) para inferir el rubro del trabajo.`;

// Audio crudo (el frontend manda el blob del MediaRecorder tal cual)
const rawAudio = express.raw({ type: ['audio/*', 'video/*', 'application/octet-stream'], limit: '15mb' });

router.post('/transcribe', rawAudio, async (req, res) => {
    if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'No llegó audio' });
    }
    try {
        const text = await transcribeAudio(req.body, req.headers['content-type'] || 'audio/webm');
        if (!text) return res.status(422).json({ error: 'No se entendió el audio. Probá de nuevo más cerca del micrófono.' });
        res.json({ text });
    } catch (err) {
        console.error('[ai/transcribe]', err.message);
        res.status(502).json({ error: 'No se pudo transcribir el audio. Probá de nuevo.' });
    }
});

// Convierte texto libre (o tabla cruda de un archivo) en items estructurados.
export async function parseItemsFromText(text, maxItems = 200) {
    const catalog = loadUnitCatalog();
    const result = await complete({
        task: 'parse',
        system: PARSE_SYSTEM + unitsPromptBlock() + priceRefsPromptBlock(),
        messages: [{ role: 'user', content: String(text || '').slice(0, 6000) }],
        schema: ITEMS_SCHEMA,
    });

    return Array.isArray(result.items) ? result.items.slice(0, maxItems).map(i => ({
        name: String(i.name || '').slice(0, 200) || 'Item',
        detail: String(i.detail || '').slice(0, 1000),
        quantity: Number(i.quantity) || 1,
        unit: canonicalLabel(i.unit || 'un.', catalog),
        unit_price: Number(i.unit_price) || 0,
    })) : [];
}

router.post('/parse', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Falta el texto' });
    if (text.length > 4000) return res.status(400).json({ error: 'Texto demasiado largo' });

    try {
        const items = await parseItemsFromText(text, 50);
        res.json({ items });
    } catch (err) {
        console.error('[ai/parse]', err.message);
        res.status(502).json({ error: 'La IA no pudo procesar el texto. Probá de nuevo.' });
    }
});

router.post('/spellcheck', async (req, res) => {
    const texts = Array.isArray(req.body?.texts)
        ? req.body.texts.slice(0, 100).map(t => String(t ?? ''))
        : null;
    if (!texts) return res.status(400).json({ error: 'Falta texts[]' });

    // Solo mandamos a la IA los que tienen contenido; los vacíos quedan igual.
    const idxConTexto = texts.map((t, i) => (t.trim() ? i : -1)).filter(i => i >= 0);
    if (!idxConTexto.length) return res.json({ texts });

    const payload = idxConTexto.map(i => texts[i]);
    if (payload.join('').length > 8000) return res.status(400).json({ error: 'Demasiado texto para corregir de una' });

    try {
        const result = await complete({
            task: 'spellcheck',
            system: SPELL_SYSTEM,
            messages: [{ role: 'user', content: JSON.stringify({ texts: payload }) }],
            schema: TEXTS_SCHEMA,
        });

        const corrected = Array.isArray(result.texts) ? result.texts : [];
        const out = texts.slice();
        idxConTexto.forEach((origIdx, k) => {
            if (typeof corrected[k] === 'string') out[origIdx] = corrected[k].slice(0, 1000);
        });
        res.json({ texts: out });
    } catch (err) {
        console.error('[ai/spellcheck]', err.message);
        const limite = /\b429\b|rate_limit/i.test(err.message);
        res.status(502).json({ error: limite
            ? 'Se alcanzó el límite diario de IA. Probá de nuevo más tarde.'
            : 'No se pudo corregir el texto. Probá de nuevo.' });
    }
});

const CLIENT_SYSTEM = `Completás los datos oficiales de un cliente para un presupuesto de obra en San Juan, Argentina. Te paso el nombre del cliente y devolvés sus datos para la cabecera del presupuesto.

DATOS CONOCIDOS (si el cliente coincide, usalos EXACTOS):
- Municipalidad de la Capital (San Juan): role="Dra. Susana Laciar" (intendenta), cp="J5402", phone="264 6 317574", address="", email="".

Reglas:
- Devolvé SOLO un JSON con esta forma: {"role":"","address":"","cp":"","phone":"","email":""}
- "role": autoridad o persona a cargo (la intendenta/el intendente para un municipio; el responsable/dueño para una empresa o cliente particular dejalo "").
- Completá únicamente lo que sabés con certeza. Si dudás de un teléfono, código postal o email, dejalo en "" — NUNCA inventes números ni datos.`;

router.post('/client-data', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (name.length < 3) return res.status(400).json({ error: 'Escribí primero el nombre del cliente' });

    try {
        const r = await complete({
            task: 'client_data',
            system: CLIENT_SYSTEM,
            messages: [{ role: 'user', content: `Cliente: "${name.slice(0, 120)}"` }],
            schema: CLIENT_SCHEMA,
        });
        res.json({
            role:    String(r.role || '').slice(0, 120),
            address: String(r.address || '').slice(0, 160),
            cp:      String(r.cp || '').slice(0, 20),
            phone:   String(r.phone || '').slice(0, 40),
            email:   String(r.email || '').slice(0, 120),
        });
    } catch (err) {
        console.error('[ai/client-data]', err.message);
        const limite = /\b429\b|rate_limit/i.test(err.message);
        res.status(502).json({ error: limite
            ? 'Se alcanzó el límite diario de IA. Probá de nuevo más tarde.'
            : 'No se pudieron buscar los datos del cliente.' });
    }
});

const COMMAND_SYSTEM = `Sos un asistente que edita presupuestos de construcción ya cargados por un presupuestista argentino. Te paso el estado actual de los items (numerados 1,2,3... tal como los ve el usuario en la pantalla) y una instrucción en español, a veces informal o mal escrita, y vos devolvés los cambios a aplicar.

Reglas:
- Devolvé SOLO un JSON con esta forma exacta: {"ops":[...],"summary":"..."}
- "summary": una sola oración en español explicando qué hiciste (o por qué no pudiste), para mostrarle al usuario antes de que confirme.
- Cada elemento de "ops" es uno de estos 4 tipos:

1) Agregar item nuevo: {"action":"add","item":{"name":"...","detail":"...","quantity":N,"unit":"...","unit_price":N}}
   Usalo para pedidos de agregar trabajos nuevos (ej "agregá 20 m² de contrapiso a 15 lucas el metro"), con la jerga de plata que ya conocés (luca=1000, palo=1000000, gamba=100, k=1000) y estimando precio de mercado realista si no lo dan.

2) Borrar un item existente: {"action":"remove","num":N}
   "num" es el número del item tal cual lo ve el usuario (empieza en 1) — si no lo dan, identificá el item por su descripción.

3) Modificar SOLO nombre, cantidad o precio de un item existente (el usuario da el valor directamente, no hace falta calcular nada): {"action":"update","num":N,"quantity":N,"unit":"...","unit_price":N,"name":"...","detail":"..."} — incluí SOLO los campos que cambian.

4) CONVERTIR LA UNIDAD DE MEDIDA de items existentes. Puede ser uno, varios o todos:
   - Un item:        {"action":"convert","num":N,"target_unit":"m³", ...medidas}
   - Varios items:   {"action":"convert","nums":[1,3,5],"target_unit":"m³", ...medidas}
   - Todo el presupuesto: {"action":"convert","all":true,"target_unit":"m³", ...medidas}

   Usá "all":true cuando pidan algo como "pasá todo el presupuesto a metros cúbicos". No hace falta que filtres qué items se pueden convertir: mandá all:true y el sistema convierte los compatibles y avisa por los demás.

   Las medidas van como números en metros, solo las que apliquen:
   - "alto": el espesor. Es lo que hace falta para pasar de m² a m³.
   - "ancho": para pasar de m a m².
   - "largo" y "pieces": solo cuando el item está en unidades sueltas ("un.") y hay que expresarlo como medida (ej "12 plateas de 1.10m x 2m x 0.15m" → pieces 12, largo 1.10, ancho 2, alto 0.15).

   Sacá las medidas de la instrucción del usuario o del "name"/"detail" del item. Si no están, NO las inventes: mandá igual la operación sin la medida y el sistema le va a avisar al usuario qué falta.

- Si el pedido no tiene relación con el presupuesto o no entendés qué hacer, devolvé {"ops":[],"summary":"No entendí el pedido, ¿podés reformularlo?"}.
- Nunca devuelvas más de 30 operaciones de una vez.`;

export async function runCommand(text, currentItems) {
    const items = (Array.isArray(currentItems) ? currentItems : []).slice(0, 200);
    const catalog = loadUnitCatalog();

    const itemsForPrompt = items.map((it, i) => ({
        num: i + 1,
        name: it.name || '',
        detail: it.detail || '',
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        total: Math.round(((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)) * 100) / 100,
    }));

    const result = await complete({
        task: 'command',
        system: COMMAND_SYSTEM + unitsPromptBlock() + priceRefsPromptBlock(),
        messages: [{
            role: 'user',
            content: JSON.stringify({ instruccion: text, items_actuales: itemsForPrompt }).slice(0, 8000),
        }],
        // Sin schema a propósito: las ops distinguen "campo ausente" de "campo
        // vacío" y un schema estricto rompería eso (ver server/ai/schemas.js).
        expectJson: true,
    });

    const { ops, warnings } = normalizeOps(result.ops, items, catalog, 200);

    let summary = String(result.summary || '').slice(0, 300);
    if (warnings.length) {
        // Lo que no se pudo convertir se le dice al usuario, no se esconde.
        summary = [summary, ...warnings].filter(Boolean).join(' ').slice(0, 600);
    }
    if (!ops.length && !summary) {
        summary = 'No encontré cambios para aplicar.';
    }

    return { ops, summary, warnings };
}

router.post('/command', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    const currentItems = Array.isArray(req.body?.items) ? req.body.items : [];
    if (!text) return res.status(400).json({ error: 'Falta el texto' });
    if (text.length > 2000) return res.status(400).json({ error: 'Texto demasiado largo' });
    if (currentItems.length > 200) return res.status(400).json({ error: 'Demasiados items' });

    try {
        const { ops, summary } = await runCommand(text, currentItems);
        res.json({ ops, summary });
    } catch (err) {
        console.error('[ai/command]', err.message);
        const limite = /\b429\b|rate_limit/i.test(err.message);
        res.status(502).json({ error: limite
            ? 'Se alcanzó el límite diario de IA. Probá de nuevo más tarde.'
            : 'La IA no pudo procesar el pedido. Probá de nuevo.' });
    }
});

// ---------------------------------------------------------------------------
// Visión: la hoja de propuesta de cambios
// ---------------------------------------------------------------------------
// El flujo real que resuelve esto: él pasa el presupuesto en m², y el municipio
// le devuelve una hoja con las mismas cosas pedidas en m³. Hasta ahora sacaba
// esas cuentas a mano, item por item.
//
// La clave de diseño: la medida que falta para convertir (el espesor) VIENE EN
// ESA HOJA. No hay que inventarla ni preguntarla — hay que leerla. Por eso leer
// la foto y convertir no son dos funciones separadas: son la misma.
//
// Como siempre: el modelo solo lee y dice qué vio; la cuenta la hace units.js.

const CHANGES_SYSTEM = `Sos un presupuestista argentino experto en leer hojas de propuesta de cambios que manda un municipio o un cliente sobre un presupuesto ya presentado.

Te paso DOS cosas:
1. Una imagen (foto o escaneo) de la hoja de cambios que le dieron.
2. Los items del presupuesto actual, numerados 1, 2, 3... tal como los ve el usuario.

Tu trabajo es COMPARAR la hoja contra el presupuesto y decir qué cambios pide.

Devolvé SOLO un JSON con esta forma exacta: {"ops":[...],"summary":"...","sin_match":["..."]}

- "summary": una oración en español contando qué pide la hoja, para mostrarle al usuario antes de que confirme.
- "sin_match": lista de textos de la hoja que NO pudiste asociar a ningún item del presupuesto. Es importante que los reportes en vez de forzarlos: que aparezca acá no es un error, es información.

Cada elemento de "ops" es uno de estos:

1) CONVERTIR LA UNIDAD de un item (el caso más común en estas hojas):
   {"action":"convert","num":N,"target_unit":"m³","alto":0.15}
   - "num": el número del item DEL PRESUPUESTO ACTUAL que corresponde a esa línea de la hoja.
   - "target_unit": la unidad que pide la hoja.
   - Las medidas van como números en metros, solo las que apliquen:
     · "alto" = el espesor. Es lo que hace falta para pasar de m² a m³.
     · "ancho" = para pasar de m a m².
     · "largo" y "pieces" = solo si el item está en unidades sueltas y hay que expresarlo como medida.
   - LEÉ la medida EN LA HOJA. Casi siempre está ahí (un espesor, un ancho, una sección). Puede estar en centímetros: pasala a metros vos (15 cm = 0.15).
   - Si la hoja NO trae la medida y tampoco está en el item, mandá igual la operación SIN la medida: el sistema le va a avisar al usuario exactamente qué falta. NO la inventes ni la estimes.

2) CAMBIAR cantidad, precio o nombre que pide la hoja:
   {"action":"update","num":N,"quantity":N,"unit_price":N,"name":"..."} — solo los campos que cambian.

3) AGREGAR un item que está en la hoja y no en el presupuesto:
   {"action":"add","item":{"name":"...","detail":"...","quantity":N,"unit":"...","unit_price":N}}
   Si la hoja no dice el precio, poné 0: que lo complete él. NO inventes precios que el municipio no pidió.

4) BORRAR un item que la hoja pide sacar: {"action":"remove","num":N}

Reglas duras:
- Asociá cada línea de la hoja con su item por la DESCRIPCIÓN, no por el orden: las hojas suelen venir reordenadas.
- Si una línea de la hoja no matchea con ninguno de los items, va a "sin_match". NO la fuerces contra el item más parecido.
- Si no estás seguro de un número que leíste en la foto (está borroso, cortado o tachado), NO lo uses: mencionalo en el summary.
- Vos NO hacés ninguna cuenta de conversión. Solo decís qué unidad piden y qué medida leíste; el sistema calcula cantidad y precio con matemática exacta.
- Si la imagen no es una hoja de presupuesto o no se entiende nada, devolvé {"ops":[],"summary":"No pude leer la hoja: ...","sin_match":[]}.`;

const VISION_IMPORT_SYSTEM = `Sos un presupuestista argentino. Te paso la foto o el escaneo de un presupuesto, una planilla o una lista de trabajos, y lo convertís en items estructurados.

Reglas:
- Devolvé SOLO un JSON con esta forma exacta: {"items":[{"name":"...","detail":"...","quantity":N,"unit":"...","unit_price":N}]}
- Leé la tabla tal como está: NO inventes items que no aparecen.
- "unit": una de las etiquetas de la lista de unidades de abajo, tal cual está escrita.
- OJO con la columna de precio: si la planilla trae "Importe" o "Total" (precio ya multiplicado por la cantidad) y no un precio unitario, dividí ese total por la cantidad para obtener el unitario. Si trae las dos columnas, usá la de precio unitario.
- Si un número está borroso o cortado, poné 0 antes que adivinar.
- Si no se entiende nada o no es una lista de trabajos, devolvé {"items":[]}.`;

const IMAGE_TYPES = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png',
    webp: 'image/webp', gif: 'image/gif', heic: 'image/heic', heif: 'image/heif',
};

// La imagen viaja como body crudo, mismo patrón que la importación de archivos y
// el audio. Los items NO viajan acá: se leen de la base por budget_id, así el
// número de cada op referencia lo que está guardado de verdad.
const rawImage = express.raw({ type: () => true, limit: '20mb' });

router.post('/vision', rawImage, async (req, res) => {
    const ext = String(req.query.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const mediaType = IMAGE_TYPES[ext];
    if (!mediaType) {
        return res.status(400).json({ error: 'Subí una foto (JPG, PNG, WEBP o HEIC)' });
    }
    if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'No llegó la imagen' });
    }

    const modo = req.query.mode === 'changes' ? 'changes' : 'import';
    const catalog = loadUnitCatalog();

    // Cuánto mide la imagen decide cuántos tokens cuesta la lectura. Si el
    // proveedor rechaza el request por tamaño, se reintenta con una versión más
    // chica en vez de devolverle un error al usuario: una hoja impresa se sigue
    // leyendo bien bastante más abajo de lo que sale de la cámara.
    const ANCHOS = [1100, 900, 700];

    async function leerConReintento(fn) {
        let ultimoError;
        for (const ancho of ANCHOS) {
            const preparada = await prepareForVision(req.body, mediaType, { maxWidth: ancho });
            try {
                return await fn({ type: 'image', ...preparada });
            } catch (err) {
                // Solo tiene sentido reintentar si se quejó por el tamaño.
                const porTamaño = /\b413\b|too large|rate_limit_exceeded|tokens per minute/i.test(err.message);
                ultimoError = err;
                if (!porTamaño) throw err;
                console.warn(`[vision] ${ancho}px no entró, reintento más chico`);
            }
        }
        throw ultimoError;
    }

    try {
        if (modo === 'import') {
            const result = await leerConReintento(imagen => complete({
                task: 'vision',
                system: VISION_IMPORT_SYSTEM + unitsPromptBlock() + priceRefsPromptBlock(),
                messages: [{ role: 'user', content: [imagen, { type: 'text', text: 'Convertí esta hoja en items.' }] }],
                schema: ITEMS_SCHEMA,
            }));
            const items = (result.items || []).slice(0, 200).map(i => ({
                name: String(i.name || '').slice(0, 200),
                detail: String(i.detail || '').slice(0, 1000),
                quantity: Number(i.quantity) || 1,
                unit: canonicalLabel(i.unit || 'un.', catalog),
                unit_price: Number(i.unit_price) || 0,
            })).filter(i => i.name.trim());
            return res.json({ mode: 'import', items });
        }

        // Modo "hoja de cambios": necesita contra qué comparar.
        const budgetId = Number(req.query.budget);
        if (!Number.isInteger(budgetId)) {
            return res.status(400).json({ error: 'Falta el presupuesto a comparar' });
        }
        const current = db.prepare('SELECT * FROM items WHERE budget_id = ? ORDER BY position, id').all(budgetId);
        if (!current.length) {
            return res.status(422).json({ error: 'Este presupuesto no tiene items todavía. Cargalos primero y después subí la hoja de cambios.' });
        }

        const itemsForPrompt = current.map((it, i) => ({
            num: i + 1,
            name: it.name || '',
            detail: it.detail || '',
            quantity: it.quantity,
            unit: it.unit,
            unit_price: it.unit_price,
            total: Math.round(((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)) * 100) / 100,
        }));

        const result = await leerConReintento(imagen => complete({
            task: 'vision',
            system: CHANGES_SYSTEM + unitsPromptBlock() + priceRefsPromptBlock(),
            messages: [{
                role: 'user',
                content: [
                    imagen,
                    { type: 'text', text: `Presupuesto actual:\n${JSON.stringify(itemsForPrompt).slice(0, 8000)}` },
                ],
            }],
            // Sin schema, igual que /command: las ops distinguen campo ausente de
            // campo vacío (ver server/ai/schemas.js).
            expectJson: true,
        }));

        const { ops, warnings } = normalizeOps(result.ops, current, catalog, 200);

        const sinMatch = (Array.isArray(result.sin_match) ? result.sin_match : [])
            .slice(0, 10).map(s => String(s).slice(0, 200)).filter(Boolean);

        let summary = String(result.summary || '').slice(0, 400);
        // Lo que no se pudo convertir y lo que no matcheó se dice, no se esconde:
        // una hoja mal leída en silencio es peor que una hoja no leída.
        const avisos = [
            ...warnings,
            ...sinMatch.map(s => `En la hoja dice "${s}" pero no encontré a qué item corresponde.`),
        ];
        if (avisos.length) summary = [summary, ...avisos].filter(Boolean).join(' ').slice(0, 900);
        if (!ops.length && !summary) summary = 'No encontré cambios para aplicar en esa hoja.';

        res.json({ mode: 'changes', ops, summary, warnings: avisos });
    } catch (err) {
        console.error('[ai/vision]', err.message);
        const limite = /\b429\b|rate_limit/i.test(err.message);
        res.status(502).json({ error: limite
            ? 'Se alcanzó el límite diario de IA. Probá de nuevo más tarde.'
            : 'No se pudo leer la imagen. Probá con una foto más nítida.' });
    }
});

router.post('/suggest', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (query.length < 2) return res.json({ suggestions: [] });

    const context = Array.isArray(req.body?.items)
        ? req.body.items.slice(0, 30).map(i => String(i.name || '').slice(0, 80)).filter(Boolean)
        : [];

    try {
        const catalog = loadUnitCatalog();
        const result = await complete({
            task: 'suggest',
            system: SUGGEST_SYSTEM + unitsPromptBlock() + priceRefsPromptBlock(),
            messages: [{
                role: 'user',
                content: `Items ya cargados: ${context.length ? context.join(', ') : '(ninguno)'}\nEl usuario está escribiendo: "${query.slice(0, 120)}"`,
            }],
            schema: SUGGESTIONS_SCHEMA,
        });

        const suggestions = Array.isArray(result.suggestions) ? result.suggestions.slice(0, 3).map(s => ({
            name: String(s.name || '').slice(0, 120),
            unit: canonicalLabel(s.unit || 'un.', catalog),
            unit_price: Number(s.unit_price) || 0,
        })).filter(s => s.name) : [];
        res.json({ suggestions });
    } catch (err) {
        console.error('[ai/suggest]', err.message);
        res.json({ suggestions: [] });
    }
});

export default router;
