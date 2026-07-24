import express from 'express';
import { Router } from 'express';
import { callGroq, transcribeAudio } from '../groq.js';
import { priceRefsPromptBlock } from './prices.js';

const router = Router();

const PARSE_SYSTEM = `Sos un presupuestista experto en construcción y refacciones en Argentina. Convertís descripciones habladas o escritas de trabajos en items de presupuesto. El usuario dicta por voz, así que el texto puede venir desprolijo, sin puntuación y con jerga.

Reglas:
- Devolvé SOLO un JSON con esta forma exacta: {"items":[{"name":"...","detail":"...","quantity":N,"unit":"...","unit_price":N}]}
- "name": nombre claro y profesional del item, con mayúscula inicial (ej: "Demolición de pared de ladrillo", "Construcción de Tabiquería Interior").
- "detail": especificaciones del item, una por línea separadas con \\n (ej: "Medidas: 10.00 m lineales x 2.50 m de alto\\nEstructura: Zapata corrida y columnas de amarre"). Incluí acá medidas, materiales y aclaraciones que mencione el usuario. Si no hay detalles, usar "".
- "quantity": número. Si no se menciona, usar 1.
- "unit": unidad de medida. Usá: "m²" (metros cuadrados), "m" (metros lineales), "un." (unidades), "kg", "lt", "hs" (horas), "saco", "día", "global". Si no está claro, "un.".
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
- "unit": unidad típica ("m²", "m", "un.", "kg", "lt", "hs", "saco", "día", "global").
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
    const result = await callGroq([
        { role: 'system', content: PARSE_SYSTEM + priceRefsPromptBlock() },
        { role: 'user', content: String(text || '').slice(0, 6000) },
    ], { temperature: 0.2, maxTokens: 2500 });

    return Array.isArray(result.items) ? result.items.slice(0, maxItems).map(i => ({
        name: String(i.name || '').slice(0, 200) || 'Item',
        detail: String(i.detail || '').slice(0, 1000),
        quantity: Number(i.quantity) || 1,
        unit: String(i.unit || 'un.').slice(0, 20),
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
        const result = await callGroq([
            { role: 'system', content: SPELL_SYSTEM },
            { role: 'user', content: JSON.stringify({ texts: payload }) },
        ], { temperature: 0, maxTokens: 2500 });

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
        const r = await callGroq([
            { role: 'system', content: CLIENT_SYSTEM },
            { role: 'user', content: `Cliente: "${name.slice(0, 120)}"` },
        ], { temperature: 0, maxTokens: 300 });
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

4) CONVERTIR LA UNIDAD DE MEDIDA de un item existente (ej "pasá el item 3 a metros cúbicos", "convertilo a m²", "adaptalo a metros lineales"): {"action":"convert","num":N,"target_unit":"m"|"m²"|"m³","largo":N,"ancho":N,"alto":N,"pieces":N}
   - IMPORTANTE: en este caso NO hagas vos la cuenta de precio ni de cantidad final — eso lo calcula el sistema con matemática exacta, no una IA. Tu única tarea acá es EXTRAER los datos:
   - "largo","ancho","alto": medidas en metros que encuentres mencionadas en el "name" o "detail" del item (ej "1.10m x 2m x 0.15m" = largo 1.10, ancho 2, alto 0.15). Poné 0 en la que no encuentres o no aplique para la unidad pedida (metros cúbicos necesita las 3; metros cuadrados necesita largo y ancho; metros lineales necesita solo largo).
   - "pieces": cuántas piezas iguales representa ese item. Normalmente es la "quantity" actual del item si su unidad actual es "un." (o similar, tipo "unidad"/"pieza"); si la unidad actual YA es una medida (m, m², m³), usá 1.
   - Si NO encontrás las medidas necesarias para la conversión pedida en el name/detail del item, no inventes números: omitilo de "ops" y explicá en "summary" que faltan las medidas y hay que agregarlas al item primero (por ejemplo en sus Especificaciones).

- Si el pedido no tiene relación con el presupuesto o no entendés qué hacer, devolvé {"ops":[],"summary":"No entendí el pedido, ¿podés reformularlo?"}.
- Nunca devuelvas más de 30 operaciones de una vez.`;

// Recalcula cantidad/precio de una conversión de unidad con aritmética exacta —
// misma lógica que el conversor manual del item (ver openConvertModal en app.js),
// para no depender de que la IA haga la cuenta bien (no la hace bien siempre).
function resolveConvert(op, currentItems) {
    const num = Number(op.num);
    if (!num || num < 1 || num > currentItems.length) return null;
    const cur = currentItems[num - 1];
    const total = Math.round(((Number(cur.quantity) || 0) * (Number(cur.unit_price) || 0)) * 100) / 100;
    const target = String(op.target_unit || '').trim();
    const largo = Number(op.largo) || 0;
    const ancho = Number(op.ancho) || 0;
    const alto  = Number(op.alto) || 0;
    const pieces = Number(op.pieces) || 1;

    let qty;
    if (target === 'm³' && largo > 0 && ancho > 0 && alto > 0) qty = pieces * largo * ancho * alto;
    else if (target === 'm²' && largo > 0 && ancho > 0) qty = pieces * largo * ancho;
    else if (target === 'm' && largo > 0) qty = pieces * largo;
    else return null; // faltan medidas para la unidad pedida

    qty = Math.round(qty * 1e6) / 1e6;
    if (!qty) return null;
    const unit_price = Math.round((total / qty) * 100) / 100;
    return { action: 'update', num, fields: { quantity: qty, unit: target, unit_price } };
}

function normalizeOp(op, currentItems) {
    const itemCount = currentItems.length;
    const action = String(op?.action || '').toLowerCase();
    if (action === 'add') {
        const item = op.item || {};
        return {
            action: 'add',
            item: {
                name: String(item.name || '').slice(0, 200) || 'Item',
                detail: String(item.detail || '').slice(0, 1000),
                quantity: Number(item.quantity) || 1,
                unit: String(item.unit || 'un.').slice(0, 20),
                unit_price: Number(item.unit_price) || 0,
            },
        };
    }
    if (action === 'convert') {
        return resolveConvert(op, currentItems);
    }
    if (action === 'update') {
        const num = Number(op.num);
        if (!num || num < 1 || num > itemCount) return null;
        const fields = {};
        if (op.name !== undefined) fields.name = String(op.name).slice(0, 200);
        if (op.detail !== undefined) fields.detail = String(op.detail).slice(0, 1000);
        if (op.quantity !== undefined) fields.quantity = Number(op.quantity) || 0;
        if (op.unit !== undefined) fields.unit = String(op.unit).slice(0, 20);
        if (op.unit_price !== undefined) fields.unit_price = Math.round((Number(op.unit_price) || 0) * 100) / 100;
        if (!Object.keys(fields).length) return null;
        return { action: 'update', num, fields };
    }
    if (action === 'remove') {
        const num = Number(op.num);
        if (!num || num < 1 || num > itemCount) return null;
        return { action: 'remove', num };
    }
    return null;
}

export async function runCommand(text, currentItems) {
    const items = (Array.isArray(currentItems) ? currentItems : []).slice(0, 200);
    const itemsForPrompt = items.map((it, i) => ({
        num: i + 1,
        name: it.name || '',
        detail: it.detail || '',
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        total: Math.round(((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)) * 100) / 100,
    }));

    const result = await callGroq([
        { role: 'system', content: COMMAND_SYSTEM + priceRefsPromptBlock() },
        { role: 'user', content: JSON.stringify({ instruccion: text, items_actuales: itemsForPrompt }).slice(0, 8000) },
    ], { temperature: 0.15, maxTokens: 3000 });

    const rawOps = Array.isArray(result.ops) ? result.ops.slice(0, 30) : [];
    const hadConvertAttempt = rawOps.some(o => String(o?.action || '').toLowerCase() === 'convert');
    const normalized = rawOps.map(op => normalizeOp(op, items)).filter(Boolean);
    let summary = String(result.summary || '').slice(0, 300);
    if (hadConvertAttempt && !normalized.length) {
        summary = summary || 'Faltan las medidas (largo/ancho/alto) en ese item para poder convertirlo — agregalas en sus Especificaciones y probá de nuevo.';
    }
    return { ops: normalized, summary };
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

router.post('/suggest', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (query.length < 2) return res.json({ suggestions: [] });

    const context = Array.isArray(req.body?.items)
        ? req.body.items.slice(0, 30).map(i => String(i.name || '').slice(0, 80)).filter(Boolean)
        : [];

    try {
        const result = await callGroq([
            { role: 'system', content: SUGGEST_SYSTEM + priceRefsPromptBlock() },
            { role: 'user', content: `Items ya cargados: ${context.length ? context.join(', ') : '(ninguno)'}\nEl usuario está escribiendo: "${query.slice(0, 120)}"` },
        ], { temperature: 0.4, maxTokens: 400 });

        const suggestions = Array.isArray(result.suggestions) ? result.suggestions.slice(0, 3).map(s => ({
            name: String(s.name || '').slice(0, 120),
            unit: String(s.unit || 'un.').slice(0, 20),
            unit_price: Number(s.unit_price) || 0,
        })).filter(s => s.name) : [];
        res.json({ suggestions });
    } catch (err) {
        console.error('[ai/suggest]', err.message);
        res.json({ suggestions: [] });
    }
});

export default router;
