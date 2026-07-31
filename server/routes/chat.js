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
import { normalizeOps, applyOps } from '../lib/ops.js';
import { simulate, simulationToOps } from '../lib/simulate.js';
import { revisarPresupuesto } from '../lib/verificar.js';
import { partialString } from '../lib/partial-json.js';
import { conReintentoDeTamaño } from '../lib/images.js';
import { priceRefsPromptBlock, listarPreciosRef } from './prices.js';
import { unitsPromptBlock } from './units.js';
import { loadSettings } from './settings.js';
import { markupPromptBlock } from '../lib/markup.js';

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
   En las conversiones vos solo indicás la unidad y la medida que sepas; la cuenta la hace el sistema.
   Si el precio que ponés es una estimación tuya (material + mano de obra) y no salió
   del tarifario, agregale "es_costo_directo": true al item y el sistema le aplica
   el margen y los impuestos de la empresa. Ver la estructura de costos más abajo.

   ==================== LO MÁS IMPORTANTE DE TODO ====================
   PROPONER ES MANDAR LAS "ops". No existe proponer con palabras.

   Si en tu "reply" decís que vas a agregar, cambiar, sumar o sacar algo, ESE MISMO
   mensaje TIENE que traer las "ops". No hay una segunda vuelta para mandarlas.

   MAL:  {"reply":"Dale, te sumo un item de traslado por 40 mil. ¿Lo cargo así?"}
         (le prometiste algo y no pasó NADA: no hay ops, no hay tarjeta, no hay
          nada que confirmar. Se queda esperando un cambio que nunca va a llegar.)
   BIEN: {"reply":"Te sumo traslado y combustible por 40 mil. Miralo y confirmá.",
          "ops":[{"action":"add","item":{"name":"Traslado y combustible","detail":"","quantity":1,"unit":"global","unit_price":40000}}]}

   No hace falta que le preguntes "¿lo cargo?" antes de mandar las ops: mandalas
   siempre. El sistema le muestra una tarjeta con los números y los botones
   "Aplicar" y "Dejalo así". La confirmación la maneja el sistema, no vos.

   NUNCA digas que aplicaste, cargaste, sumé, agregué o modificaste algo. VOS NO
   PODÉS APLICAR NADA: solo proponés, y el que aplica es él tocando el botón.
   Decir "listo, lo apliqué" es mentirle, porque el presupuesto no cambió.
   Hablá siempre en futuro y de lo que proponés: "te sumo", "te propongo",
   "quedaría así".
   ===================================================================

3) "web_query" — cuando pregunta por precios de mercado ACTUALES que no están en su tarifario.
   Ej: "¿a cuánto está la bolsa de cemento?" → "precio bolsa cemento 50kg Argentina hoy"
   Poné la consulta y NADA más (sin "reply" largo, sin "ops"): te vuelvo a preguntar
   con los resultados y ahí armás la respuesta o el presupuesto con esos números.
   Si te pidió "precios actuales" o "precios de hoy", USÁ ESTO. No estimes de
   memoria y digas que buscaste: no buscaste.

======================= CÓMO SE ARMA UN PRESUPUESTO =======================
Cuando te pide presupuestar un trabajo (no editar uno que ya existe), seguí este
orden. No lo saltees aunque el trabajo parezca simple: el orden es lo que hace
que el número final se pueda defender.

PASO 1 — ENTENDER QUÉ HAY QUE HACER
Leé bien qué te pidió y con qué medidas. Si falta un dato que cambia el precio de
verdad (el espesor de un contrapiso, si la pared es de 1/2 o 1 ladrillo, si hay
que demoler algo antes), PREGUNTÁ en vez de suponer. Una pregunta corta ahora
vale más que un presupuesto que hay que rehacer.

PASO 2 — COMPUTAR
Sacá las cantidades de las medidas que te dio, con la cuenta escrita.
   "Pared de 9 m x 1.10 m = 9.9 m²"
   "9.9 m² x 62 ladrillos/m² = 614 ladrillos"
Cada cantidad tiene que salir de una cuenta, no de una impresión.

PASO 3 — DESGLOSAR EN ITEMS DE VERDAD
Un trabajo NO es un item. Separalo en lo que realmente se paga por separado:
   - Materiales principales (cada uno con su unidad real: ladrillos por unidad,
     cemento por bolsa, hormigón por m³)
   - Materiales secundarios y consumibles
   - Mano de obra (en horas o días de cuadrilla, NO en m²: se le paga por tiempo)
   - Movimiento: flete, traslado, combustible
   - Trabajos previos si hacen falta (demolición, replanteo, limpieza)
Tres items en m² con todo adentro es lo que hace un aficionado. Él tiene que
poder mirar el presupuesto y saber qué le está costando cada cosa.

PASO 4 — PONERLE PRECIO A CADA UNO, EN ESTE ORDEN
   1º Su TARIFARIO. Si el item está ahí, va ese precio y punto (ya es de venta).
   2º Lo que COBRÓ ANTES por algo parecido (te lo paso más abajo cuando hay).
   3º Precios de internet, si te los pidió: usá "web_query" ANTES de estimar.
   4º Tu estimación, y solo si no había nada de lo anterior. Decilo en "reply".
Los casos 3 y 4 son COSTO DIRECTO: marcalos con "es_costo_directo": true.

PASO 5 — RELEER ANTES DE MANDAR
Antes de cerrar el JSON, revisá tu propio presupuesto:
   ¿Está la mano de obra, o quedó solo material?
   ¿Las cantidades salen de las medidas que él dio?
   ¿Falta el flete, la demolición, algo que en la obra siempre aparece?
   ¿Alguno quedó en cero?
Si algo no cierra, arreglalo antes de mandarlo. Si falta un dato que no tenés,
decíselo en "reply" en vez de rellenarlo con un número inventado.
===========================================================================

SI TE MANDA UNA FOTO
Puede ser tres cosas, fijate cuál:
- LA HOJA DE CAMBIOS que le devolvió el municipio o el cliente: compará contra los items que tiene cargados y devolvé las "ops" que correspondan (casi siempre conversiones de unidad). La medida que hace falta para convertir (el espesor, el ancho) SUELE ESTAR EN LA HOJA: leela de ahí, no la inventes. Si viene en centímetros pasala a metros (15 cm = 0.15). Si una línea de la hoja no matchea con ningún item, decíselo en "reply" en vez de forzarla.
- UNA LISTA DE TRABAJOS para cargar: devolvé "ops" con action "add". Si la hoja no dice el precio, poné 0 y avisale que lo complete.
- EL LUGAR DE LA OBRA (una pared, un terreno, un techo): describí lo que ves y, si te da datos para estimar, proponé los items con "ops". Aclarale siempre que es una estimación a ojo desde una foto.
Si un número está borroso o cortado, NO lo adivines: decilo en "reply".

LAS MEDIDAS SE CALCULAN, NO SE REDONDEAN A OJO
Una pared de 9 m de largo por 1.10 m de alto son 9.9 m². Ni 10 ni 10.89: 9.9.
Hacé la cuenta y poné ESE número en "quantity".

Si a un MATERIAL le querés sumar desperdicio (recortes, roturas), podés hacerlo,
pero tiene que estar a la vista: la cuenta va escrita en el "detail" del item.
   BIEN: quantity 10.89, detail "Superficie: 9.00 m x 1.10 m = 9.9 m²\\n+10% de desperdicio = 10.89 m²"
   MAL:  quantity 10.89 sin decir de dónde salió (él mide 9.9 en la obra, no le
         cierra, y no sabe si le estás cobrando de más)
A la MANO DE OBRA no se le suma desperdicio: se pagan las horas del trabajo real,
no los recortes del material.

Él le muestra este presupuesto al cliente y se lo discuten con el metro en la
mano. Cada número tiene que poder explicarse.

REGLAS QUE NO SE ROMPEN
- Nunca inventes un precio del tarifario. Si no está, decilo y ofrecé buscarlo.
- Si te pregunta cuánto cobrar por algo, mirá primero su tarifario y su histórico. Si no hay nada parecido, decí que es una estimación tuya.
- Un presupuesto tiene que dejarle ganancia. Si lo que armaste es solo material y mano de obra, ESTÁS PRESUPUESTANDO A COSTO: marcá esos items con "es_costo_directo": true y dejá que el sistema le aplique gastos generales, utilidad e impuestos.
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

// "sí", "dale", "aplicalo"… Tiene que ser el mensaje entero o casi: si escribió
// "si, pero cambiale el precio" no es una confirmación pelada, es un pedido nuevo.
const CONFIRMACION = /^\s*(s[ií]+|dale|ok(ey)?|listo|aplica(lo|r)?|hacelo|obvio|correcto|perfecto|va|vale|confirmo|adelante|de una)[\s.,!]*$/i;

function esConfirmacion(texto) {
    return CONFIRMACION.test(String(texto || ''));
}

/** ¿El último mensaje del asistente traía cambios para aplicar? */
function ultimaPropuestaTraeOps(chatId) {
    const ultimo = db.prepare(
        `SELECT tool_json FROM chat_messages
         WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY id DESC LIMIT 1`
    ).get(chatId);
    if (!ultimo?.tool_json) return false;
    try {
        return Boolean(JSON.parse(ultimo.tool_json)?.ops?.length);
    } catch {
        return false;
    }
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
    const markup = loadSettings();

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
        + markupPromptBlock(markup)
        + historicoPromptBlock(chat.budget_id, texto);

    const mensajes = [
        { role: 'user', content: `Presupuesto actual:\n${JSON.stringify(contexto).slice(0, 7000)}` },
        ...previos.map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content })),
    ];

    // El modelo a veces propone con palabras y se olvida de mandar las "ops".
    // Entonces el usuario contesta "sí, dale" y no pasa nada: no hubo cambios que
    // aplicar, y encima el modelo suele rematar con un "listo, lo apliqué" que es
    // mentira. Si detectamos justo esa situación —dijo que sí, y lo anterior no
    // traía ops— se lo recordamos acá mismo.
    if (esConfirmacion(texto) && !ultimaPropuestaTraeOps(chat.id)) {
        mensajes.push({
            role: 'user',
            content: 'IMPORTANTE: te acaba de confirmar lo que propusiste, pero en tu mensaje anterior no mandaste las "ops", así que el presupuesto sigue igual. Mandá AHORA las "ops" de eso que propusiste. No digas que ya lo aplicaste: todavía no pasó nada.',
        });
    }

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
    //
    // Antes esto solo corría si NO venían ops ni simulate, y ahí estaba el
    // problema: ante "presupuestá esto con precios de hoy" el modelo devuelve
    // las dos cosas juntas, la búsqueda no corría nunca, y encima la respuesta
    // decía "no encontré precios actuales" sin haber buscado. Justo el caso más
    // común de la función.
    //
    // Ahora, si pidió buscar, se busca. Las ops de la primera pasada se
    // descartan a propósito: estaban armadas con precios inventados, y las que
    // valen son las de la segunda, hechas con los datos reales.
    let fuentes = [];
    if (respuesta.web_query) {
        try {
            const hallazgo = await webSearch(String(respuesta.web_query).slice(0, 300));
            fuentes = hallazgo.sources || [];
            const seguimiento = [
                ...mensajes,
                { role: 'assistant', content: JSON.stringify({ reply: 'Buscando…' }) },
                {
                    role: 'user',
                    content: `Resultados de la búsqueda "${respuesta.web_query}":\n${hallazgo.text}\n\nUsá ESTOS precios, no los de tu memoria. Si lo que te pidió era armar o ajustar un presupuesto, mandá ahora las "ops" con estos valores como costo directo ("es_costo_directo": true). Aclarale que salieron de internet y no de su tarifario, y que los revise. No devuelvas web_query de nuevo.`,
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
    let simulacionValida = false;
    if (respuesta.simulate) {
        const sim = simulate(items, respuesta.simulate, catalog);
        if (sim.ok) {
            simulacionValida = true;
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
    //
    // Si el modelo mandó simulate Y ops a la vez, mandan las de la simulación.
    // No es un empate cualquiera: la tarjeta que ve en pantalla son los números
    // de la simulación, así que aplicar otra cosa sería mostrarle un total y
    // ejecutarle otro. Ese bug estuvo vivo y es de los que se pagan.
    if (Array.isArray(respuesta.ops) && respuesta.ops.length && !simulacionValida) {
        const { ops, warnings } = normalizeOps(respuesta.ops, items, catalog, 200, markup);
        adjunto.ops = ops;
        if (warnings.length) adjunto.warnings = warnings;
    } else if (respuesta.ops?.length && simulacionValida) {
        console.warn('[chat] llegaron simulate y ops juntos: se aplican los de la simulación, que es lo que se muestra');
    }

    // Revisión del presupuesto que quedaría. No cuesta tokens y agarra la clase
    // de error que ninguna IA ve sola: presupuestar a costo, olvidarse la mano de
    // obra, cantidades que no salen de las medidas que él dio.
    if (adjunto.ops?.length) {
        const avisos = revisarPresupuesto(applyOps(items, adjunto.ops), {
            propuestos: adjunto.ops,
            tarifario: listarPreciosRef(),
            markup,
        });
        if (avisos.length) adjunto.warnings = [...(adjunto.warnings || []), ...avisos];
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
