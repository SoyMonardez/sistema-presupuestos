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
export async function completeStream({ system, messages, schema, expectJson = false, maxTokens = 16000, effort = 'medium', laxFallback = false }, onDelta) {
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
    return parseJsonFlexible(completo, { lax: laxFallback });
}

export async function complete({ system, messages, schema, expectJson = false, maxTokens = 16000, effort = 'medium', laxFallback = false }) {
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
    return parseJsonFlexible(text, { lax: laxFallback });
}

// Las tareas que piden JSON por prompt en vez de por schema (las operaciones de
// edición — ver server/ai/schemas.js) a veces vienen envueltas en ```json … ```,
// o con alguna palabra suelta antes o después a pesar de que el prompt pide
// "SOLO un JSON". Es la misma red que ya tenía Groq (ver ese archivo) — acá
// faltaba, y fue justo lo que rompió la segunda pasada de la búsqueda web: ese
// mensaje de seguimiento no tiene el pedido de JSON tan a mano en el contexto
// inmediato, y alcanza con que el modelo agregue una palabra de más para que un
// JSON.parse directo reviente.
//
// `lax` es para el chat: probado en vivo, el modo Asistente (respuestas largas,
// con negritas y viñetas) hace que Claude directamente se olvide del sobre JSON
// y conteste en prosa suelta — pasó 3 de 3 veces con la misma pregunta. Ahí, en
// vez de tirar la respuesta entera, se toma el texto tal cual como "reply": en
// el chat todos los demás campos (ops, simulate, web_query) son opcionales, así
// que perderlos es mucho más barato que perder la respuesta. Las tareas que sí
// necesitan una forma exacta (comando, visión) NO pasan `lax`, y ahí un JSON
// roto sigue siendo un error de verdad.
function parseJsonFlexible(raw, { lax = false } = {}) {
    let texto = String(raw).trim();
    const cerco = texto.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (cerco) texto = cerco[1].trim();

    try {
        return JSON.parse(texto);
    } catch {
        const desde = texto.indexOf('{');
        const hasta = texto.lastIndexOf('}');
        if (desde >= 0 && hasta > desde) {
            try {
                return JSON.parse(texto.slice(desde, hasta + 1));
            } catch { /* cae al error de abajo */ }
        }
        if (lax) return { reply: texto };
        throw new Error('Claude devolvió un JSON inválido');
    }
}
