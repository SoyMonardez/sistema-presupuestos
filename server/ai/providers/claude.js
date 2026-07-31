// Adaptador de Claude, para las tareas donde un error sale caro: editar items de
// un presupuesto que ya existe, leer una foto de una hoja de cambios, conversar.
//
// Diferencias con Groq que hay que respetar sí o sí:
//   - No acepta temperature / top_p / top_k: mandarlos devuelve 400. Se descartan.
//   - El JSON estricto no se pide con response_format sino con output_config.format.
//   - max_tokens limita el pensamiento MÁS la respuesta, así que va holgado.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5';

export const name = 'claude';

// Piso de tokens de salida.
//
// Los techos que vienen de provider.js están calculados para el límite por
// minuto del tier gratuito de Groq, que es apretadísimo (8000 TPM para prompt +
// respuesta). Acá ese límite no existe, y en cambio max_tokens incluye lo que el
// modelo piensa: pasarle 2500 sería ahogarle el razonamiento justo en las tareas
// que se le mandan PORQUE hay que razonarlas.
//
// Así que el número que llega se toma como mínimo, no como máximo.
const PISO_TOKENS = 8000;

let client = null;
function getClient() {
    if (!process.env.ANTHROPIC_API_KEY) throw new Error('Falta ANTHROPIC_API_KEY en .env');
    if (!client) client = new Anthropic();
    return client;
}

export function isConfigured() {
    return Boolean(process.env.ANTHROPIC_API_KEY);
}

// Traduce el formato neutral de mensajes al de la Messages API.
function toClaudeMessages(messages) {
    return messages.map(msg => {
        if (typeof msg.content === 'string') {
            return { role: msg.role, content: msg.content };
        }
        const parts = msg.content.map(part => part.type === 'image'
            ? { type: 'image', source: { type: 'base64', media_type: part.mediaType, data: part.data } }
            : { type: 'text', text: part.text });
        return { role: msg.role, content: parts };
    });
}

function extractText(content) {
    return content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('')
        .trim();
}

function buildRequest({ system, messages, schema, maxTokens, effort }) {
    const request = {
        model: MODEL,
        max_tokens: Math.max(Number(maxTokens) || 0, PISO_TOKENS),
        messages: toClaudeMessages(messages),
        // El pensamiento adaptativo es lo que hace que las conversiones y la
        // lectura de una hoja borrosa salgan bien; el effort le pone techo al gasto.
        thinking: { type: 'adaptive' },
        output_config: {
            effort,
            ...(schema ? { format: { type: 'json_schema', schema } } : {}),
        },
    };
    if (system) request.system = system;
    return request;
}

export const supportsStream = true;

/**
 * Igual que complete(), pero avisando el texto a medida que llega.
 * Solo se emiten los bloques de texto: el pensamiento no se muestra.
 */
export async function completeStream({ system, messages, schema, expectJson = false, maxTokens = 16000, effort = 'medium' }, onDelta) {
    const stream = getClient().messages.stream(buildRequest({ system, messages, schema, maxTokens, effort }));

    let completo = '';
    stream.on('text', (fragmento) => {
        completo += fragmento;
        onDelta?.(fragmento);
    });

    const final = await stream.finalMessage();
    if (final.stop_reason === 'refusal') {
        throw new Error('La IA rechazó el pedido por sus filtros de seguridad. Reformulalo.');
    }
    if (!completo.trim()) throw new Error('Respuesta vacía de Claude');

    if (!schema && !expectJson) return { text: completo.trim() };
    try {
        return JSON.parse(stripCodeFence(completo.trim()));
    } catch {
        throw new Error('Claude devolvió un JSON inválido');
    }
}

export async function complete({ system, messages, schema, expectJson = false, maxTokens = 16000, effort = 'medium' }) {
    const request = buildRequest({ system, messages, schema, maxTokens, effort });

    const response = await getClient().messages.create(request);

    // Los clasificadores de seguridad pueden rechazar un pedido y devolver 200 con
    // el contenido vacío. Si no se chequea antes, leer content[0] revienta.
    if (response.stop_reason === 'refusal') {
        throw new Error('La IA rechazó el pedido por sus filtros de seguridad. Reformulalo.');
    }

    const text = extractText(response.content);
    if (!text) throw new Error('Respuesta vacía de Claude');

    if (!schema && !expectJson) return { text };

    try {
        return JSON.parse(stripCodeFence(text));
    } catch {
        throw new Error('Claude devolvió un JSON inválido');
    }
}

// Las tareas que piden JSON por prompt en vez de por schema (las operaciones de
// edición — ver server/ai/schemas.js) pueden venir envueltas en ```json … ```.
// Es barato desenvolverlo acá y evita toda una familia de fallas.
function stripCodeFence(text) {
    const fenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/);
    return fenced ? fenced[1].trim() : text;
}
