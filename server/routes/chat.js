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
import { complete, webSearch } from '../ai/provider.js';
import { normalizeOps } from '../lib/ops.js';
import { simulate, simulationToOps } from '../lib/simulate.js';
import { priceRefsPromptBlock } from './prices.js';
import { unitsPromptBlock } from './units.js';

const router = Router();

const CHAT_SYSTEM = `Sos el asistente de un presupuestista argentino de construcción y refacciones. Lo tuteás, hablás en rioplatense, y sos concreto: él está laburando, no quiere ensayos.

Te paso el presupuesto que está armando (items numerados 1,2,3... como los ve en pantalla), su tarifario y, cuando hace falta, datos de sus presupuestos anteriores.

Devolvé SIEMPRE SOLO un JSON con esta forma:
{"reply":"...","ops":[...],"simulate":{...},"web_query":"..."}

- "reply": tu respuesta en español, para mostrarle. Es lo único que él lee, así que tiene que entenderse sola. Corta y al grano: 1 a 4 oraciones salvo que pida una explicación.
- "ops", "simulate" y "web_query" son opcionales: mandá solo el que corresponda, o ninguno si es pura charla.

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

router.post('/chats/:id/messages', async (req, res) => {
    const chat = db.prepare('SELECT * FROM chat_conversations WHERE id = ?').get(req.params.id);
    if (!chat) return res.status(404).json({ error: 'No existe la conversación' });

    const texto = String(req.body?.text || '').trim();
    if (!texto) return res.status(400).json({ error: 'Falta el mensaje' });
    if (texto.length > 2000) return res.status(400).json({ error: 'Mensaje demasiado largo' });

    // El item señalado desde el atajo ("estoy hablando del item 3").
    const itemNum = Number(req.body?.item_num) || null;

    const items = itemsStmt.all(chat.budget_id);
    const catalog = loadUnitCatalog();

    db.prepare('INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)')
        .run(chat.id, 'user', texto);

    try {
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

        let respuesta = await complete({ task: 'chat', system, messages: mensajes, expectJson: true });

        // Segunda pasada: pidió buscar precios en internet. Se hace la búsqueda y
        // se le devuelve para que conteste con los datos a la vista.
        let fuentes = [];
        if (respuesta.web_query && !respuesta.ops?.length && !respuesta.simulate) {
            try {
                const hallazgo = await webSearch(String(respuesta.web_query).slice(0, 300));
                fuentes = hallazgo.sources || [];
                respuesta = await complete({
                    task: 'chat',
                    system,
                    messages: [
                        ...mensajes,
                        { role: 'assistant', content: JSON.stringify({ reply: 'Buscando…' }) },
                        {
                            role: 'user',
                            content: `Resultados de la búsqueda "${respuesta.web_query}":\n${hallazgo.text}\n\nContestale con estos datos. Aclarale que son precios de internet, no de su tarifario, y que los revise. No devuelvas web_query de nuevo.`,
                        },
                    ],
                    expectJson: true,
                });
            } catch (err) {
                console.warn('[chat] búsqueda web falló:', err.message);
                // Distinguir la cuota agotada de una falla cualquiera: si le decís
                // "probá en un rato" cuando faltan 40 minutos de cuota, prueba tres
                // veces y piensa que está roto.
                const cuota = /\b429\b|rate_limit/i.test(err.message);
                const minutos = err.message.match(/try again in (?:(\d+)m)?([\d.]+)s/i);
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

        // El título de la conversación sale del primer mensaje, para reconocerla
        // después en la lista.
        if (!chat.title) {
            db.prepare('UPDATE chat_conversations SET title = ? WHERE id = ?')
                .run(texto.slice(0, 60), chat.id);
        }
        db.prepare(`UPDATE chat_conversations SET updated_at = datetime('now') WHERE id = ?`).run(chat.id);

        res.json({
            message: { id: info.lastInsertRowid, role: 'assistant', content: reply, data: tieneAdjunto ? adjunto : null },
        });
    } catch (err) {
        console.error('[chat]', err.message);
        const limite = /\b429\b|rate_limit/i.test(err.message);
        res.status(502).json({ error: limite
            ? 'Se alcanzó el límite diario de IA. Probá de nuevo más tarde.'
            : 'El asistente no pudo responder. Probá de nuevo.' });
    }
});

export default router;
