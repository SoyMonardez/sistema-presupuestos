// Ruteo de IA por tarea.
//
// Antes todo iba a Groq porque era lo único cableado. Ahora cada tarea elige
// proveedor según lo que cuesta equivocarse:
//
//   - Rápidas y de bajo riesgo (sugerencias, ortografía) → Groq, que vuela.
//   - Caras de equivocar (editar items, leer una hoja, conversar) → Claude.
//
// Se puede pisar cualquier ruta con una variable de entorno sin tocar código:
//   AI_ROUTE_COMMAND=groq   AI_ROUTE_SUGGEST=claude   ...

import * as groq from './providers/groq.js';
import * as claude from './providers/claude.js';

const PROVIDERS = { groq, claude };

const DEFAULT_ROUTES = {
    suggest:     'groq',
    spellcheck:  'groq',
    parse:       'groq',
    client_data: 'groq',
    command:     'claude',
    chat:        'claude',
    vision:      'claude',
};

// Valores por defecto razonables para cada tarea, pisables desde el que llama.
//
// Sobre "effort": es cuánto puede pensar el modelo antes de contestar. Está
// separado de maxTokens a propósito, porque los dos salen del mismo presupuesto
// y hay que balancearlos. Las tareas mecánicas no necesitan pensar; las que
// deciden plata sí, y mucho — un presupuesto mal estimado se factura.
//
// Ojo con maxTokens en Groq: lo descuenta del límite por minuto ANTES de correr
// nada, así que un techo alto se paga aunque no se use. Por eso los números son
// ajustados y no generosos.
const TASK_DEFAULTS = {
    suggest:     { maxTokens: 400,  temperature: 0.4,  effort: 'low' },
    spellcheck:  { maxTokens: 2500, temperature: 0,    effort: 'low' },
    client_data: { maxTokens: 300,  temperature: 0,    effort: 'low' },

    // Las que deciden números. Acá el razonamiento no es un lujo: sin él, el
    // modelo tira el primer precio que se le viene y arma presupuestos que no
    // cierran. Se les da margen de salida suficiente para que pensar no le coma
    // el lugar a la respuesta.
    parse:       { maxTokens: 2500, temperature: 0.2,  effort: 'medium' },
    command:     { maxTokens: 3500, temperature: 0.15, effort: 'medium' },
    // temperature baja: esto produce plata, no prosa. Lo que se gana en variedad
    // se paga en números inventados.
    chat:        { maxTokens: 3500, temperature: 0.15, effort: 'high' },
    vision:      { maxTokens: 4000, temperature: 0.1,  effort: 'high' },
};

const warned = new Set();

function resolveProvider(task) {
    const fromEnv = process.env[`AI_ROUTE_${task.toUpperCase()}`];
    const wanted = (fromEnv || DEFAULT_ROUTES[task] || 'groq').toLowerCase();
    const provider = PROVIDERS[wanted];

    if (provider && provider.isConfigured()) return provider;

    // Degradación elegante: si falta la API key del proveedor elegido, se usa
    // cualquiera que sí esté configurado en vez de tirar la app abajo. Sirve para
    // probar en local con una sola key.
    const fallback = Object.values(PROVIDERS).find(p => p.isConfigured());
    if (!fallback) {
        throw new Error('No hay ninguna IA configurada: falta GROQ_API_KEY o ANTHROPIC_API_KEY en .env');
    }
    if (!warned.has(task)) {
        warned.add(task);
        const motivo = provider ? `${wanted} no está configurado` : `"${wanted}" no existe como proveedor`;
        console.warn(`[ai] ${task}: ${motivo}, se usa ${fallback.name}`);
    }
    return fallback;
}

/**
 * Punto único de entrada a cualquier modelo de texto o visión.
 *
 * @param {object}   opts
 * @param {string}   opts.task      - clave de ruteo: parse | command | chat | vision | ...
 * @param {string}   [opts.system]  - system prompt
 * @param {Array}    opts.messages  - [{ role, content }] donde content es string
 *                                    o [{ type:'text', text } | { type:'image', mediaType, data }]
 * @param {object}   [opts.schema]  - JSON Schema; si viene, se devuelve el objeto parseado
 * @param {boolean}  [opts.expectJson] - pedir JSON sin schema (lo describe el prompt)
 * @returns {Promise<object>} el JSON parseado, o { text } si no se pidió JSON
 */
export async function complete({ task, system, messages, schema, expectJson, maxTokens, temperature, effort }) {
    const provider = resolveProvider(task);
    const defaults = TASK_DEFAULTS[task] || {};

    const hasImages = messages.some(m =>
        Array.isArray(m.content) && m.content.some(p => p.type === 'image'));

    return provider.complete({
        system,
        messages,
        schema,
        expectJson,
        hasImages,
        maxTokens:   maxTokens   ?? defaults.maxTokens,
        temperature: temperature ?? defaults.temperature,
        effort:      effort      ?? defaults.effort,
    });
}

/**
 * Igual que complete(), pero llamando a `onDelta(fragmento)` con el texto a
 * medida que lo escribe el modelo. Si el proveedor que le toca a la tarea no
 * soporta streaming, cae a la versión de siempre: el que llama recibe el
 * resultado igual, solo que de una sola vez.
 */
export async function completeStream({ task, system, messages, schema, expectJson, maxTokens, temperature, effort }, onDelta) {
    const provider = resolveProvider(task);
    const defaults = TASK_DEFAULTS[task] || {};

    const opts = {
        system,
        messages,
        schema,
        expectJson,
        hasImages: messages.some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image')),
        maxTokens:   maxTokens   ?? defaults.maxTokens,
        temperature: temperature ?? defaults.temperature,
        effort:      effort      ?? defaults.effort,
    };

    if (provider.supportsStream && provider.completeStream) {
        return provider.completeStream(opts, onDelta);
    }
    return provider.complete(opts);
}

/** Qué proveedor atiende cada tarea. Solo para diagnóstico y logs de arranque. */
export function routingSummary() {
    return Object.keys(DEFAULT_ROUTES).reduce((acc, task) => {
        try { acc[task] = resolveProvider(task).name; } catch { acc[task] = 'sin configurar'; }
        return acc;
    }, {});
}

// Whisper y la búsqueda web son específicas de Groq, no se rutean.
export const transcribeAudio = groq.transcribeAudio;
export const webSearch = groq.webSearch;
