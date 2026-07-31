// El asistente del presupuesto.
//
// Por qué existe teniendo Gemini o ChatGPT a mano: porque este ve SUS datos. No
// contesta "el revoque se cobra tanto" en abstracto, contesta con el tarifario
// que él cargó y con lo que cobró en sus presupuestos anteriores.
//
// Cómo está armado, y por qué no con tool-calling:
// El resto del proyecto ya tiene un patrón que funciona — la IA propone en JSON,
// el servidor valida y calcula, el usuario confirma. Un loop de herramientas
// agregaría varias vueltas de red por mensaje y otra superficie de error, para
// llegar al mismo lado. Así que el contexto que necesita (items, tarifario,
// histórico) va en el mensaje, y lo que pide se resuelve en una segunda pasada
// solo cuando hace falta (búsqueda de precios en internet).
//
// La regla de oro no cambia: la IA no escribe en la base. Propone, y él confirma.

import { Router } from 'express';
import db, { loadUnitCatalog } from '../db.js';
import { complete, completeStream, webSearch } from '../ai/provider.js';
import { normalizeOps } from '../lib/ops.js';
import { simulate, simulationToOps } from '../lib/simulate.js';
import { partialString } from '../lib/partial-json.js';
import { conReintentoDeTamaño } from '../lib/images.js';
import { priceRefsPromptBlock } from './prices.js';
import { unitsPromptBlock } from './units.js';

const router = Router();

const CHAT_SYSTEM = `Sos el asistente de un presupuestista argentino de construcción y refacciones. Lo tuteás, hablás en rioplatense, y sos concreto: él está laburando, no quiere ensayos.

Te paso el presupuesto que está armando (items numerados 1,2,3... como los ve en pantalla), su tarifario y, cuando hace falta, datos de sus presupuestos anteriores.

Devolvé SIEMPRE SOLO un JSON con esta forma:
{"reply":"...","ops":[...],"simulate":{...},"web_query":"..."}

- "reply": tu respuesta en español, para mostrarle. Es lo único que él lee, así que tiene que entenderse sola. Corta y al grano: 1 a 4 oraciones salvo que pida una explicación.
  IMPORTANTE: poné "reply" SIEMPRE PRIMERO en el JSON. Se le va mostrando mientras lo escribís, así que si va al final lo deja esperando la pantalla en blanco.
- "ops", "simulate" y "web_query" son opcionales: mandá solo el que corresponda, o ninguno si es pura charla.
- "title": solo en tu PRIMERA respuesta de la conversación, 3 a 5 palabras que resuman de qué se trata ("Descuento del 10%", "Conversión a m³"). Sirve para que la reconozca después en la lista.

CUÁNDO USAR CADA UNO

1) "simulate" — cuando pregunta CUÁNTO LE DARÍA algo, sin querer cambiarlo todavía.
   Ej: "¿cuánto me da si le bajo un 10%?", "¿y si le saco el item 3?", "¿cuánto sale si lo dejo en 2 millones?"
   Formas: {"type":"discount","pct":10,"all":true} · {"type":"discount","pct":10,"num":3}
           {"type":"set_price","num":2,"unit_price":300000} · {"type":"set_qty","num":1,"quantity":25}
           {"type":"remove","num":3} · {"type":"add","item":{...}}
           {"type":"convert","all":true,"target_unit":"m³","alto":0.15}
           {"type":"round_total","to":2000000}
   VOS NO HACÉS LA CUENTA: el sistema la calcula exacta y le muestra el antes y el después.
   En "reply" no pongas números inventados del resultado — decí qué vas a simular y ya.

2) "ops" — cuando pide CAMBIAR el presupuesto de verdad ("bajale un 10%", "sacá el item 3", "pasá todo a m³").
   Mismas operaciones que ya conocés: add / update / remove / convert.
   {"action":"convert","all":true,"target_unit":"m³","alto":0.15}
   {"action":"update","num":2,"unit_price":300000}
   {"action":"remove","num":3}
   {"action":"add","item":{"name":"...","detail":"...","quantity":N,"unit":"...","unit_price":N}}
   Los cambios NO se aplican solos: se le muestran para que confirme. Decíselo en "reply".
   En las conversiones vos solo indicás la unidad y la medida que sepas; la cuenta la hace el sistema.

3) "web_query" — cuando pregunta por precios de mercado ACTUALES que no están en su tarifario.
   Ej: "¿a cuánto está la bolsa de cemento?" → "precio bolsa cemento 50kg Argentina hoy"
   Poné la consulta y NADA más (sin "reply" largo): te vuelvo a preguntar con los resultados y ahí contestás.

SI TE MANDA UNA FOTO
Puede ser tres cosas, fijate cuál:
- LA HOJA DE CAMBIOS que le devolvió el municipio o el cliente: compará contra los items que tiene cargados y devolvé las "ops" que correspondan (casi siempre conversiones de unidad). La medida que hace falta para convertir (el espesor, el ancho) SUELE ESTAR EN LA HOJA: leela de ahí, no la inventes. Si viene en centímetros pasala a metros (15 cm = 0.15). Si una línea de la hoja no matchea con ningún item, decíselo en "reply" en vez de forzarla.
- UNA LISTA DE TRABAJOS para cargar: devolvé "ops" con action "add". Si la hoja no dice el precio, poné 0 y avisale que lo complete.
- EL LUGAR DE LA OBRA (una pared, un terreno, un techo): describí lo que ves y, si te da datos para estimar, proponé los items con "ops". Aclarale siempre que es una estimación a ojo desde una foto.
Si un número está borroso o cortado, NO lo adivines: decilo en "reply".

REGLAS QUE NO SE ROMPEN
- Nunca inventes un precio del tarifario. Si no está, decilo y ofrecé buscarlo.
- Si te pregunta cuánto cobrar por algo, mirá primero su tarifario y su histórico. Si no hay nada parecido, decí que es una estimación tuya.
- Nunca cambies nada sin que él confirme.
- Para conversiones y descuentos NO calcules vos: usá "simulate" u "ops" y dejá que el sistema haga la aritmética.
- Si te pide algo que no tiene que ver con presupuestos, contestá igual pero corto.`;

// ---------------------------------------------------------------------------
// Consultas de apoyo
// ---------------------------------------------------------------------------

const itemsStmt = db.prepare('SELECT * FROM items WHERE budget_id = ? ORDER BY position, id');

/**
 * Qué cobró antes por algo parecido. Esto es lo que le gana a un chat genérico:
 * no es un precio de internet, es el precio que él puso y le aceptaron.
 */
function historicoPromptBlock(budgetId, consulta) {
    const palabras = String(consulta || '')
        .toLowerCase()
        .replace(/[^a-záéíóúñ0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter(p => p.length > 3)      // "de", "por", "con" no discriminan nada
        .slice(0, 6);
    if (!palabras.length) return '';

    const where = palabras.map(() => 'LOWER(i.name) LIKE ?').join(' OR ');
    const filas = db.prepare(`
        SELECT i.name, i.quantity, i.unit, i.unit_price, b.name AS obra, b.client, b.updated_at
        FROM items i
        JOIN budgets b ON b.id = i.budget_id
        WHERE i.budget_id != ? AND (${where})
        ORDER BY b.updated_at DESC
        LIMIT 12
    `).all(budgetId, ...palabras.map(p => `%${p}%`));

    if (!filas.length) return '';
    const lineas = filas.map(f =>
        `- "${f.name}": $${f.unit_price} por ${f.unit} (en "${f.obra}"${f.client ? `, cliente ${f.client}` : ''}, ${String(f.updated_at).slice(0, 10)})`);
    return `\n\nLO QUE COBRÓ ANTES POR TRABAJOS PARECIDOS (de sus propios presupuestos — es el dato más confiable que tenés):\n${lineas.join('\n')}`;
}

function itemsParaPrompt(items) {
    return items.map((it, i) => ({
        num: i + 1,
        name: it.name || '',
        detail: it.detail || '',
        quantity: it.quantity,
        unit: it.unit,
        unit_price: it.unit_price,
        total: Math.round(((Number(it.quantity) || 0) * (Number(it.unit_price) || 0)) * 100) / 100,
    }));
}

// ---------------------------------------------------------------------------
// Conversaciones
// ---------------------------------------------------------------------------

router.get('/budgets/:budgetId/chats', (req, res) => {
    const chats = db.prepare(
        'SELECT * FROM chat_conversations WHERE budget_id = ? ORDER BY updated_at DESC'
    ).all(req.params.budgetId);
    res.json({ chats });
});

router.post('/budgets/:budgetId/chats', (req, res) => {
    const budget = db.prepare('SELECT id FROM budgets WHERE id = ?').get(req.params.budgetId);
    if (!budget) return res.status(404).json({ error: 'No existe el presupuesto' });
    const info = db.prepare('INSERT INTO chat_conversations (budget_id, title) VALUES (?, ?)')
        .run(budget.id, String(req.body?.title || '').slice(0, 120));
    res.status(201).json(db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(info.lastInsertRowid));
});

router.get('/chats/:id/messages', (req, res) => {
    const mensajes = db.prepare(
        'SELECT id, role, content, tool_json, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id'
    ).all(req.params.id);
    res.json({
        messages: mensajes.map(m => ({
            id: m.id,
            role: m.role,
            content: m.content,
            // Lo adjunto (simulación, ops propuestas) viaja aparte del texto para
            // que el frontend pueda volver a dibujar la tarjeta al recargar.
            data: m.tool_json ? safeParse(m.tool_json) : null,
            created_at: m.created_at,
        })),
    });
});

router.delete('/chats/:id', (req, res) => {
    const info = db.prepare('DELETE FROM chat_conversations WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'No existe' });
    res.json({ ok: true });
});

function safeParse(txt) {
    try { return JSON.parse(txt); } catch { return null; }
}

// ---------------------------------------------------------------------------
// El mensaje
// ---------------------------------------------------------------------------

const MAX_HISTORIAL = 14;   // mensajes previos que se le mandan al modelo

/**
 * Todo el trabajo de responder un mensaje. Lo comparten el endpoint normal y el
 * de streaming, para que no haya dos versiones de la misma lógica que se
 * separen con el tiempo.
 *
 * `onDelta` es opcional: si viene, se le pasa el texto de la respuesta a medida
 * que lo escribe el modelo.
 */
async function responder(chat, texto, itemNum, onDelta, imagen) {
    const items = itemsStmt.all(chat.budget_id);
    const catalog = loadUnitCatalog();

    const previos = db.prepare(
        'SELECT role, content FROM chat_messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?'
    ).all(chat.id, MAX_HISTORIAL).reverse();

    const contexto = {
        items_actuales: itemsParaPrompt(items),
        total: Math.round(items.reduce((s, i) => s + i.quantity * i.unit_price, 0) * 100) / 100,
        ...(itemNum ? { hablando_del_item: itemNum } : {}),
    };

    const system = CHAT_SYSTEM
        + unitsPromptBlock()
        + priceRefsPromptBlock()
        + historicoPromptBlock(chat.budget_id, texto);

    const mensajes = [
        { role: 'user', content: `Presupuesto actual:\n${JSON.stringify(contexto).slice(0, 7000)}` },
        ...previos.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    ];

    // Con foto la tarea es 'vision': va al modelo que sabe mirar, que además es
    // el que el plan manda usar cuando equivocarse sale caro.
    //
    // Pero el techo de salida se fija a mano en vez de heredar el de 'vision'
    // (4000): una respuesta del chat es la misma con foto o sin ella, y Groq
    // descuenta ese techo del presupuesto por minuto antes de correr nada. Con
    // 4000 el request se pasaba por 27 tokens y rebotaba entero, aun con la
    // imagen achicada al mínimo — el problema no era la foto, era el techo.
    const tarea = imagen ? 'vision' : 'chat';
    const TOKENS_SALIDA = 2500;

    // La foto va pegada al último mensaje del usuario, que es el que la mandó.
    // El prompt del chat ya es largo, así que acá se arranca con la imagen más
    // chica que en la importación: entre el system, el presupuesto y el
    // histórico queda poco margen de tokens.
    const conFoto = (mensajesBase, fn) => imagen
        ? conReintentoDeTamaño(
            Buffer.from(imagen.data, 'base64'),
            imagen.mediaType,
            (img) => {
                const copia = mensajesBase.slice();
                const ultimo = copia[copia.length - 1];
                const textoUltimo = typeof ultimo?.content === 'string' ? ultimo.content : texto;
                copia[copia.length - 1] = { role: 'user', content: [img, { type: 'text', text: textoUltimo }] };
                return fn(copia);
            },
            [900, 700, 550],
        )
        : fn(mensajesBase);

    // Lo que llega es el JSON a medio escribir; se le va sacando el campo "reply"
    // para mostrarlo (ver server/lib/partial-json.js).
    let crudo = '';
    let mostrado = '';
    const emitir = onDelta ? (trozo) => {
        crudo += trozo;
        const parcial = partialString(crudo, 'reply');
        if (parcial.length > mostrado.length) {
            onDelta(parcial.slice(mostrado.length));
            mostrado = parcial;
        }
    } : null;

    let rehizo = false;
    let respuesta;
    if (emitir) {
        try {
            respuesta = await conFoto(mensajes, (msgs) =>
                completeStream({ task: tarea, system, messages: msgs, expectJson: true, maxTokens: TOKENS_SALIDA }, emitir));
        } catch (err) {
            // El streaming va sin modo JSON estricto para que sea streaming de
            // verdad (ver providers/groq.js), así que de vez en cuando el modelo
            // puede devolver algo que no parsea. Se rehace la consulta con el
            // modo estricto en lugar de perderle el mensaje.
            if (!/JSON/i.test(err.message)) throw err;
            console.warn('[chat] el stream no devolvió JSON válido, reintento sin streaming');
            respuesta = await conFoto(mensajes, (msgs) =>
                complete({ task: tarea, system, messages: msgs, expectJson: true, maxTokens: TOKENS_SALIDA }));
            rehizo = true;   // lo que se mostró quedó viejo
        }
    } else {
        respuesta = await conFoto(mensajes, (msgs) =>
            complete({ task: tarea, system, messages: msgs, expectJson: true, maxTokens: TOKENS_SALIDA }));
    }

    // Segunda pasada: pidió buscar precios en internet. Se hace la búsqueda y
    // se le devuelve para que conteste con los datos a la vista.
    let fuentes = [];
    if (respuesta.web_query && !respuesta.ops?.length && !respuesta.simulate) {
        try {
            const hallazgo = await webSearch(String(respuesta.web_query).slice(0, 300));
            fuentes = hallazgo.sources || [];
            const seguimiento = [
                ...mensajes,
                { role: 'assistant', content: JSON.stringify({ reply: 'Buscando…' }) },
                {
                    role: 'user',
                    content: `Resultados de la búsqueda "${respuesta.web_query}":\n${hallazgo.text}\n\nContestale con estos datos. Aclarale que son precios de internet, no de su tarifario, y que los revise. No devuelvas web_query de nuevo.`,
                },
            ];
            // En la segunda pasada se vuelve a arrancar el texto desde cero: lo
            // que se mostró de la primera era el "buscando", no la respuesta.
            crudo = '';
            mostrado = '';
            rehizo = true;
            respuesta = emitir
                ? await completeStream({ task: 'chat', system, messages: seguimiento, expectJson: true, maxTokens: TOKENS_SALIDA }, emitir)
                : await complete({ task: 'chat', system, messages: seguimiento, expectJson: true, maxTokens: TOKENS_SALIDA });
        } catch (err) {
            console.warn('[chat] búsqueda web falló:', err.message);
            // Distinguir la cuota agotada de una falla cualquiera: si le decís
            // "probá en un rato" cuando faltan 40 minutos de cuota, prueba tres
            // veces y piensa que está roto.
            const cuota = /\b429\b|rate_limit/i.test(err.message);
            const minutos = err.message.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
            rehizo = true;
            respuesta = {
                reply: cuota
                    ? `Me quedé sin cuota de búsqueda en internet por hoy${minutos?.[1] ? ` (se libera en ~${minutos[1]} min)` : ''}. Lo que sí puedo: mirar tu tarifario y lo que cobraste antes.`
                    : 'No pude buscar el precio en internet ahora. Probá de nuevo en un rato.',
            };
        }
    }

    const adjunto = {};

    // La simulación la calcula el servidor: la IA solo dijo qué simular.
    if (respuesta.simulate) {
        const sim = simulate(items, respuesta.simulate, catalog);
        if (sim.ok) {
            adjunto.simulation = { ...sim, items: undefined };  // los items completos no van al cliente
            // Si acepta la simulación, se aplica por el mismo camino que todo
            // lo demás: se guardan las ops equivalentes listas para confirmar.
            adjunto.ops = simulationToOps(items, sim);
        } else if (!sim.unknownType) {
            // Pidió simular algo que no se puede (convertir horas a m³): se le
            // dice. Si el modelo mandó un simulate que no venía al caso, se
            // descarta callado en vez de mostrarle un error que no entiende.
            adjunto.simulation = { ok: false, reason: sim.reason };
        }
    }

    // Cambios pedidos directamente.
    if (Array.isArray(respuesta.ops) && respuesta.ops.length) {
        const { ops, warnings } = normalizeOps(respuesta.ops, items, catalog, 200);
        adjunto.ops = ops;
        if (warnings.length) adjunto.warnings = warnings;
    }
    if (fuentes.length) adjunto.sources = fuentes.slice(0, 4);

    const reply = String(respuesta.reply || '').slice(0, 3000)
        || 'No supe qué contestar a eso, ¿lo reformulás?';

    const tieneAdjunto = Object.keys(adjunto).length > 0;
    const info = db.prepare(
        'INSERT INTO chat_messages (conversation_id, role, content, tool_json) VALUES (?, ?, ?, ?)'
    ).run(chat.id, 'assistant', reply, tieneAdjunto ? JSON.stringify(adjunto) : '');

    // El título lo pone el modelo en su primera respuesta ("Descuento del 10%").
    // Si no lo mandó —pasa seguido, es un campo opcional en un prompt largo— se
    // arma con lo que hizo, que describe la conversación mejor que la pregunta
    // cruda. Recién como último recurso se usa el texto del usuario.
    let titulo = chat.title;
    if (!titulo) {
        titulo = String(respuesta.title || '').trim().slice(0, 60)
            || adjunto.simulation?.label
            || texto.slice(0, 60);
        db.prepare('UPDATE chat_conversations SET title = ? WHERE id = ?').run(titulo, chat.id);
    }
    db.prepare(`UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?`).run(chat.id);

    return {
        message: { id: info.lastInsertRowid, role: 'assistant', content: reply, data: tieneAdjunto ? adjunto : null },
        title: titulo,
        // Avisa que el texto que se streameó quedó viejo y hay que reemplazarlo.
        replaced: rehizo,
    };
}

function mensajeDeError(err) {
    const limite = /\b429\b|rate_limit/i.test(err.message);
    return limite
        ? 'Se alcanzó el límite diario de IA. Probá de nuevo más tarde.'
        : 'El asistente no pudo responder. Probá de nuevo.';
}

const TIPOS_IMAGEN = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif']);

function leerPedido(req) {
    const texto = String(req.body?.text || '').trim();
    if (!texto) return { error: 'Falta el mensaje' };
    if (texto.length > 2000) return { error: 'Mensaje demasiado largo' };

    // Foto adjunta, en base64. Viene ya achicada del navegador salvo que no haya
    // podido (HEIC): en ese caso la achica prepareForVision antes de mandarla.
    let imagen = null;
    const cruda = req.body?.image;
    if (cruda?.data) {
        if (!TIPOS_IMAGEN.has(String(cruda.mediaType))) {
            return { error: 'Ese formato de imagen no lo puedo leer' };
        }
        imagen = { data: String(cruda.data), mediaType: String(cruda.mediaType) };
    }

    // El item señalado desde el atajo ("estoy hablando del item 3").
    return { texto, itemNum: Number(req.body?.item_num) || null, imagen };
}

router.post('/chats/:id/messages', async (req, res) => {
    const chat = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'No existe la conversación' });

    const pedido = leerPedido(req);
    if (pedido.error) return res.status(400).json({ error: pedido.error });

    db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(chat.id, 'user', pedido.texto);

    try {
        const out = await responder(chat, pedido.texto, pedido.itemNum, null, pedido.imagen);
        res.json(out);
    } catch (err) {
        console.error('[chat]', err.message);
        res.status(502).json({ error: mensajeDeError(err) });
    }
});

/**
 * Igual que el anterior pero por SSE, para que el texto aparezca mientras se
 * escribe en vez de después de varios segundos de pantalla quieta.
 *
 * Eventos: "delta" (un pedazo de texto) · "done" (el mensaje completo con su
 * simulación y sus ops) · "error".
 */
router.post('/chats/:id/messages/stream', async (req, res) => {
    const chat = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'No existe la conversación' });

    const pedido = leerPedido(req);
    if (pedido.error) return res.status(400).json({ error: pedido.error });

    db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(chat.id, 'user', pedido.texto);

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        // Sin esto, un proxy que buffea (nginx por defecto) se guarda todo y lo
        // suelta junto al final: el streaming deja de existir sin dar la cara.
        'X-Accel-Buffering': 'no',
    });
    const enviar = (evento, dato) => res.write(`event: ${evento}\ndata: ${JSON.stringify(dato)}\n\n`);

    try {
        const out = await responder(chat, pedido.texto, pedido.itemNum, (trozo) => enviar('delta', { text: trozo }), pedido.imagen);
        enviar('done', out);
    } catch (err) {
        console.error('[chat/stream]', err.message);
        enviar('error', { error: mensajeDeError(err) });
    } finally {
        res.end();
    }
});

export default router;
