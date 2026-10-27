// La conversación por voz: dictarle el presupuesto de corrido.
//
// Tres piezas, una por modelo, para que cada una haga lo que mejor le sale:
//
//   /token   → el navegador abre el WebSocket de Scribe (ElevenLabs) y va
//              recibiendo lo que dice palabra por palabra. La clave nunca sale
//              de acá: se le da un token de un solo uso.
//   /cortar  → Groq, rápido: de lo que se dictó, qué parte ya es un pedido
//              entero y qué parte todavía viene (ver server/lib/cortador.js).
//   /turno   → Claude: decide los items y la plata. Streamea lo que piensa
//              hacer, después las ops (validadas acá, como siempre) y al final
//              lo que va a decir en voz alta.
//
// La regla de siempre se mantiene: el modelo propone y el servidor valida. Lo
// que cambia es quién confirma — con el modo Auto lo aplica la pantalla sola,
// pero lo que llega a la pantalla pasó por normalizeOps igual que en el chat.

import { Router } from 'express';
import { loadUnitCatalog } from '../db.js';
import { complete, completeStream } from '../ai/provider.js';
import { isConfigured as vozConfigurada, tokenTranscripcion } from '../ai/elevenlabs.js';
import { normalizeOps, normalizeEncabezado } from '../lib/ops.js';
import { atajo, normalizarCorte, quitarEstimados } from '../lib/cortador.js';
import { partialString, objectBefore } from '../lib/partial-json.js';
import { priceRefsPromptBlock } from './prices.js';
import { unitsPromptBlock } from './units.js';
import { loadSettings } from './settings.js';
import { markupPromptBlock } from '../lib/markup.js';
import { OPS_FORMATO, vocabularioDelPresupuesto } from './ai.js';

const router = Router();

const limite = (err) => /\b429\b|rate_limit/i.test(err.message);

// ---------------------------------------------------------------------------
// Token para el WebSocket de Scribe
// ---------------------------------------------------------------------------
router.post('/token', async (req, res) => {
    if (!vozConfigurada()) return res.status(503).json({ error: 'La voz de ElevenLabs no está configurada' });
    try {
        res.set('Cache-Control', 'no-store');
        // Con el token va la lista de términos que Scribe tiene que preferir
        // (los items y el tarifario de él): es lo que más baja los errores.
        res.json({
            token: await tokenTranscripcion(),
            keyterms: vocabularioDelPresupuesto(Number(req.body?.budget)).slice(0, 50),
        });
    } catch (err) {
        console.error('[voz/token]', err.message);
        res.status(502).json({ error: 'No se pudo abrir la escucha en vivo' });
    }
});

// ---------------------------------------------------------------------------
// Cortador
// ---------------------------------------------------------------------------
const CORTAR_SYSTEM = `Separás en pedidos lo que un presupuestista argentino le va dictando por voz a su asistente. El texto viene de un reconocedor de voz: sin puntuación confiable, con muletillas y cortado donde él hizo una pausa, no donde termina la idea.

Te paso "resto" (lo que quedó esperando de antes) y "nuevo" (lo último que dijo). Juntalos y devolvé SOLO este JSON:
{"instrucciones":[{"texto":"...","tipo":"pedido"}],"resto":"...","acuse":"..."}

- "instrucciones": cada pedido COMPLETO, en el orden en que los dijo, con el texto limpio de muletillas ("eh", "este", "mirá") pero sin cambiar ningún dato. Un pedido por item o por cambio: "agregá demolición a 300 mil y un contrapiso de 20 metros a 15 lucas" son DOS pedidos.
- "tipo": "pedido" para todo lo que hay que pensar (agregar, cambiar, borrar items, poner datos del encabezado, preguntas sobre el presupuesto). Solo usá "confirmar", "confirmar_todo", "rechazar", "deshacer" o "salir" si esa es la frase ENTERA ("sí", "sí a todo", "no", "deshacé eso", "terminamos").
- "resto": lo del final que parece CORTADO a mitad de idea y va a seguir (termina en "a", "de", "con", "y", "el precio es", un número a medio decir, o nombra un item sin decir nada más cuando venía dando cantidad y precio de los anteriores). Si todo está completo, "".
- Un pedido está completo cuando ya se puede actuar aunque falten datos: "agregá un item de pintura" alcanza; el que piensa estima lo que falte.
- "acuse": 2 a 5 palabras para contestarle al toque mientras se piensa, en castellano rioplatense ("Dale, anoto la demolición", "Ahí lo cambio"). "" si no hay pedidos.`;

router.post('/cortar', async (req, res) => {
    const resto = String(req.body?.resto || '').trim().slice(0, 1500);
    const nuevo = String(req.body?.nuevo || '').trim().slice(0, 1500);
    const final = req.body?.final === true;
    const completo = [resto, nuevo].filter(Boolean).join(' ');
    if (!completo) return res.json({ instrucciones: [], resto: '', acuse: '' });

    // Lo corto y repetido se resuelve sin modelo.
    if (!resto) {
        const tipo = atajo(nuevo);
        if (tipo) return res.json({ instrucciones: [{ texto: nuevo, tipo }], resto: '', acuse: '' });
    }

    try {
        const raw = await complete({
            task: 'voz_cortar',
            system: CORTAR_SYSTEM,
            messages: [{ role: 'user', content: JSON.stringify({ resto, nuevo, cierre_de_turno: final }) }],
            expectJson: true,
        });
        res.json(normalizarCorte(raw, completo, { final }));
    } catch (err) {
        // Sin cortador se manda todo como un pedido: Claude sabe separar, solo
        // que tarda más. Peor sería perder lo que dictó.
        console.error('[voz/cortar]', err.message);
        res.json(normalizarCorte(null, completo, { final: true }));
    }
});

// ---------------------------------------------------------------------------
// Turno: Claude piensa y decide
// ---------------------------------------------------------------------------
const TURNO_SYSTEM = (auto) => `Sos el asistente por voz de un presupuestista argentino de construcción. Él te va dictando el presupuesto en voz alta, sin mirar la pantalla, y vos lo cargás. Hablás como un ayudante de confianza: rioplatense, cálido, MUY breve.

Te paso los items actuales (numerados 1, 2, 3… como los ve él), el encabezado y uno o más pedidos dictados. Los pedidos vienen de un reconocedor de voz: puede haber palabras mal transcriptas ("metro cuadrado" = m², "metros cúbicos" = m³, "por" = x). Interpretá con criterio.

Devolvé SOLO un JSON, con las claves EN ESTE ORDEN:
{"pensamiento":"...","ops":[...],"encabezado":{...},"respuesta":"..."}

- "pensamiento": qué vas a hacer, en primera persona y con los números exactos, una línea por cambio. Ej: "Agrego «Demolición»: 1 m² a $320.000." Es lo que él ve en pantalla ANTES de que se aplique.
${OPS_FORMATO}
CARGAR SIEMPRE, AUNQUE FALTEN DATOS (esto manda por encima de lo de arriba):
- Un nombre de trabajo suelto ("contrapiso", "pintura", "y colocación de cerámica") ES un pedido de agregar ese item. Si nombra varios, son varios items. Cargalos YA con lo que haya: él completa lo que falta después, por voz o a mano.
- NUNCA dejes de cargar un item por falta de cantidad, unidad o precio, ni le pidas esos datos antes de cargarlo. Lo que falte:
  · cantidad: 1.
  · unidad: la lógica para ese trabajo (m² para pisos, revoques y pintura; m³ para hormigón; "global" para limpieza o flete; "un." si no hay una clara).
  · precio: si el trabajo está en el TARIFARIO, ese precio (sin "es_costo_directo"). Si no está, 0. NO estimes precios de tu cabeza salvo que él lo pida ("estimá", "poneles precio de mercado"); ahí sí, con "es_costo_directo": true.
- Si quedaron items en $0 o con cantidad supuesta, decíselo en una frase corta ("Quedaron sin precio, dictámelos cuando quieras"). Sin pedirle permiso y sin listar todo.
- Si dice "cargame cinco items" sin nombrarlos todavía, no cargues nada: contestá "Dale, decime cuáles" y esperá. Los nombres le van a llegar en los pedidos siguientes.
- El precio que DICE es el precio unitario final de venta: va tal cual, sin "es_costo_directo". Solo si dice que es "a costo" va "es_costo_directo": true.
- Si dice el total de varias unidades ("3 puertas por 300 mil"), calculá el unitario.
- Nombres de item claros y con mayúscula inicial ("Demolición de mampostería", no "demolicion"). Si da medidas o materiales, van en "detail".
- "encabezado": solo los datos de la cabecera que pidió cambiar. Claves posibles: "name" (el título del presupuesto), "client", "location" (ubicación de la obra), "client_role", "client_address", "client_cp", "client_phone", "client_email", "validity_days" (número), "advance_pct" (número, porcentaje de anticipo). Si no pidió nada del encabezado, {}.
- Si pregunta algo (el total, cuántos items van), contestalo en "respuesta" sin ops.
- Preguntá SOLO si no se entiende QUÉ trabajo es o a qué item se refiere (ruido, una frase cortada sin sentido). Que falte un número nunca es motivo para preguntar.
- En "respuesta" no expliques el coeficiente, los gastos generales ni de dónde salió cada precio: eso ya lo ve en pantalla y hablado cansa.
- "respuesta": lo que vas a DECIR en voz alta. 1 o 2 oraciones cortas, sin markdown, sin listas, sin repetir todos los números (ya los ve). ${auto
        ? 'Los cambios se aplican solos: hablá en pasado y cerrá invitando a seguir. Ej: "Listo, agregué la demolición. ¿Con qué seguimos?"'
        : 'Los cambios TODAVÍA NO se hicieron: esperan que él diga que sí. Si hay ops, terminá SIEMPRE preguntando si lo hacés ("¿Le doy?", "¿Lo saco?"). Nunca digas "listo" ni "¿seguimos?": no se hizo nada todavía. Ej: "Te agrego la demolición a 320 mil, ¿le doy?"'}
- Si son muchos pedidos juntos (está leyendo una planilla), resumí: "Cargué los cinco items. ¿Seguimos?"
- Nunca más de 30 ops de una vez.`;

function itemsParaPrompt(items) {
    return items.map((it, i) => ({
        num: i + 1,
        name: String(it?.name || '').slice(0, 200),
        detail: String(it?.detail || '').slice(0, 300),
        quantity: it?.quantity,
        unit: it?.unit,
        unit_price: it?.unit_price,
    }));
}

function historialParaPrompt(historial) {
    // Pares usuario/asistente alternados, que es lo que pide la API. Lo que no
    // encaja en ese orden se descarta: es contexto, no la fuente de verdad.
    const out = [];
    for (const h of (Array.isArray(historial) ? historial : []).slice(-12)) {
        const role = h?.rol === 'asistente' ? 'assistant' : 'user';
        const content = String(h?.texto || '').trim().slice(0, 1200);
        if (!content) continue;
        if (!out.length && role !== 'user') continue;
        if (out.length && out[out.length - 1].role === role) {
            out[out.length - 1].content += '\n' + content;
        } else {
            out.push({ role, content });
        }
    }
    // El mensaje nuevo va como usuario: el historial tiene que cerrar en asistente.
    if (out.length && out[out.length - 1].role === 'user') out.pop();
    return out;
}

router.post('/turno', async (req, res) => {
    const instrucciones = (Array.isArray(req.body?.instrucciones) ? req.body.instrucciones : [])
        .map(t => String(t || '').trim().slice(0, 1500)).filter(Boolean).slice(0, 20);
    const items = (Array.isArray(req.body?.items) ? req.body.items : []).slice(0, 200);
    const encabezado = req.body?.encabezado && typeof req.body.encabezado === 'object' ? req.body.encabezado : {};
    const auto = req.body?.auto === true;

    if (!instrucciones.length) return res.status(400).json({ error: 'No llegó ningún pedido' });

    res.writeHead(200, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',   // ver el mismo header en routes/chat.js
    });
    let cortado = false;
    res.on('close', () => { if (!res.writableEnded) cortado = true; });
    const enviar = (evento, dato) => {
        if (!cortado) res.write(`event: ${evento}\ndata: ${JSON.stringify(dato)}\n\n`);
    };

    const catalog = loadUnitCatalog();
    const markup = loadSettings();
    const system = TURNO_SYSTEM(auto) + unitsPromptBlock() + priceRefsPromptBlock()
        // El bloque de la empresa le pide explicar el coeficiente en la
        // respuesta; hablado eso es un párrafo que nadie quiere escuchar.
        + markupPromptBlock(markup).split('\n').filter(l => !l.includes('"reply"')).join('\n');

    const contexto = {
        encabezado: normalizeEncabezado(encabezado),
        items_actuales: itemsParaPrompt(items),
        pedidos: instrucciones,
    };
    const messages = [
        ...historialParaPrompt(req.body?.historial),
        { role: 'user', content: JSON.stringify(contexto).slice(0, 14000) },
    ];

    // Las ops se validan y se mandan apenas el modelo las termina de escribir,
    // sin esperar a que redacte la respuesta: así la pantalla ya muestra el
    // cambio mientras se genera lo que va a decir.
    const validar = (obj) => {
        const { ops: crudas, sinPrecio } = quitarEstimados(obj?.ops, instrucciones);
        const { ops, warnings } = normalizeOps(crudas, items, catalog, 200, markup);
        if (sinPrecio.length) warnings.push(`Sin precio (dictámelo cuando quieras): ${sinPrecio.join(', ')}.`);
        return { ops, warnings, encabezado: normalizeEncabezado(obj?.encabezado) };
    };

    let crudo = '';
    let pensado = '';
    let dicho = '';
    let opsEnviadas = false;

    try {
        const final = await completeStream({
            task: 'voz_turno', system, messages, expectJson: true, laxFallback: true,
        }, (trozo) => {
            crudo += trozo;

            const p = partialString(crudo, 'pensamiento');
            if (p.length > pensado.length) {
                enviar('pensamiento', { text: p.slice(pensado.length) });
                pensado = p;
            }

            if (!opsEnviadas) {
                const previo = objectBefore(crudo, 'respuesta');
                if (previo) {
                    opsEnviadas = true;
                    enviar('ops', validar(previo));
                }
            }

            const r = partialString(crudo, 'respuesta');
            if (r.length > dicho.length) {
                enviar('respuesta', { text: r.slice(dicho.length) });
                dicho = r;
            }
        });

        if (!opsEnviadas) enviar('ops', validar(final));
        const respuesta = String(final?.respuesta || final?.reply || '').trim().slice(0, 1200);
        enviar('done', {
            pensamiento: String(final?.pensamiento || pensado).trim().slice(0, 2000),
            respuesta: respuesta || dicho,
        });
    } catch (err) {
        if (!cortado) {
            console.error('[voz/turno]', err.message);
            enviar('error', { error: limite(err)
                ? 'Se alcanzó el límite de IA. Probá de nuevo en un rato.'
                : 'No pude procesar eso. ¿Me lo repetís?' });
        }
    } finally {
        if (!cortado) res.end();
    }
});

export default router;
