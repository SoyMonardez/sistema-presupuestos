// Adaptador de Groq. Es el mismo fetch que venía usando la app, movido acá y
// con la firma neutral que define provider.js.
//
// Groq sirve para lo que tiene que ser rápido y barato: sugerencias mientras se
// tipea, ortografía, transcripción de voz. También trae búsqueda web integrada
// en sus modelos "compound", que usamos como herramienta desde el chat.

const API = 'https://api.groq.com/openai/v1';

const MODEL         = process.env.GROQ_MODEL         || 'qwen/qwen3.6-27b';
const VISION_MODEL  = process.env.GROQ_VISION_MODEL  || MODEL;
const SEARCH_MODEL  = process.env.GROQ_SEARCH_MODEL  || 'groq/compound-mini';
const WHISPER_MODEL = process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo';

export const name = 'groq';

export function isConfigured() {
    return Boolean(process.env.GROQ_API_KEY);
}

function authHeaders() {
    if (!process.env.GROQ_API_KEY) throw new Error('Falta GROQ_API_KEY en .env');
    return { 'Authorization': `Bearer ${process.env.GROQ_API_KEY}` };
}

// Traduce el formato neutral de mensajes al de OpenAI, que es el que habla Groq.
function toGroqMessages(system, messages) {
    const out = [];
    if (system) out.push({ role: 'system', content: system });

    for (const msg of messages) {
        if (typeof msg.content === 'string') {
            out.push({ role: msg.role, content: msg.content });
            continue;
        }
        // Contenido mixto (texto + imágenes)
        const parts = msg.content.map(part => part.type === 'image'
            ? { type: 'image_url', image_url: { url: `data:${part.mediaType};base64,${part.data}` } }
            : { type: 'text', text: part.text });
        out.push({ role: msg.role, content: parts });
    }
    return out;
}

/**
 * Rescata el JSON de una respuesta que vino con adornos.
 *
 * Los modelos que razonan (qwen3, deepseek) escriben su cadena de pensamiento en
 * un bloque <think>…</think> y después encierran la respuesta en un cerco de
 * ```json. Eso rompe cualquier JSON.parse directo. Se pide reasoning_format
 * 'hidden' para que no pase, pero esto queda como red por si el próximo modelo
 * se comporta distinto: es barato y evita perder una lectura entera por un cerco.
 */
function parseJsonFlexible(raw) {
    let texto = String(raw).trim();
    texto = texto.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

    const cerco = texto.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (cerco) texto = cerco[1].trim();

    try {
        return JSON.parse(texto);
    } catch {
        // Último intento: quedarse con el objeto más externo que aparezca.
        const desde = texto.indexOf('{');
        const hasta = texto.lastIndexOf('}');
        if (desde >= 0 && hasta > desde) return JSON.parse(texto.slice(desde, hasta + 1));
        throw new Error('La IA no devolvió un JSON válido');
    }
}

// Cuánto puede "pensar" el modelo antes de contestar.
//
// Esto importa más de lo que parece: los modelos que razonan gastan del MISMO
// presupuesto de completion para pensar y para responder. Con un prompt largo
// (el de leer una hoja de cambios lo es) qwen3 se comió los 4000 tokens enteros
// razonando y devolvió contenido vacío, que Groq reporta como
// "failed to validate JSON" con failed_generation vacío — un error que no dice
// nada de lo que realmente pasó.
//
// Para las tareas que devuelven JSON se apaga el razonamiento: los prompts ya
// describen la forma exacta de la respuesta, y lo que devuelve se valida después
// contra normalizeOp igual. Preferimos una respuesta que llega a una respuesta
// "mejor pensada" que se corta por la mitad.
const EFFORT_TO_GROQ = { low: 'none', medium: 'none', high: 'low' };

export async function complete({ system, messages, schema, expectJson = false, maxTokens = 2000, temperature = 0.2, hasImages = false, effort = 'medium' }) {
    const wantsJson = Boolean(schema) || expectJson;
    const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
            model: hasImages ? VISION_MODEL : MODEL,
            messages: toGroqMessages(system, messages),
            temperature,
            max_tokens: maxTokens,
            // El prompt describe la forma exacta del JSON; json_object alcanza y
            // es lo que ya venía funcionando con todos los modelos de Groq.
            ...(wantsJson ? {
                response_format: { type: 'json_object' },
                // Sin esto, un modelo que razona mete su <think> en el contenido y
                // Groq rechaza el request entero por "failed to validate JSON",
                // devolviendo failed_generation vacío (un rato largo de debug).
                reasoning_format: 'hidden',
                reasoning_effort: EFFORT_TO_GROQ[effort] || 'none',
            } : {}),
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Groq ${res.status}: ${detail.slice(0, 400)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Respuesta vacía de Groq');

    return wantsJson ? parseJsonFlexible(content) : { text: content };
}

/**
 * Búsqueda web. Groq la trae integrada en los modelos "compound" (usa Tavily por
 * detrás), así que no hace falta contratar un buscador aparte.
 * Devuelve texto en prosa; el que llama decide qué hacer con eso — nunca se
 * aplica solo a un presupuesto.
 */
export async function webSearch(query, { maxTokens = 900 } = {}) {
    const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({
            model: SEARCH_MODEL,
            messages: [
                {
                    role: 'system',
                    content: 'Sos un asistente que busca precios y datos actuales en Argentina. Respondé corto y concreto, con los valores que encontraste y de qué fecha son. Si no encontrás un dato confiable, decilo en vez de estimar.',
                },
                { role: 'user', content: String(query).slice(0, 500) },
            ],
            max_tokens: maxTokens,
            temperature: 0.2,
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Groq búsqueda ${res.status}: ${detail.slice(0, 400)}`);
    }

    const data = await res.json();
    const message = data.choices?.[0]?.message;
    return {
        text: String(message?.content || '').trim(),
        // Los modelos compound devuelven las fuentes que consultaron.
        sources: message?.executed_tools?.flatMap(t => t.search_results?.results || []).map(r => ({
            title: r.title,
            url: r.url,
        })) || [],
    };
}

/**
 * Transcripción de audio con Whisper. Es específica de Groq (anda muy bien y sale
 * centavos), así que no pasa por el ruteo de proveedores.
 */
export async function transcribeAudio(buffer, mimeType = 'audio/webm') {
    const ext = mimeType.includes('mp4') ? 'mp4'
              : mimeType.includes('ogg') ? 'ogg'
              : mimeType.includes('wav') ? 'wav'
              : 'webm';

    const form = new FormData();
    form.append('file', new Blob([buffer], { type: mimeType }), `audio.${ext}`);
    form.append('model', WHISPER_MODEL);
    form.append('language', 'es');
    form.append('temperature', '0');

    const res = await fetch(`${API}/audio/transcriptions`, {
        method: 'POST',
        headers: authHeaders(),
        body: form,
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Groq audio ${res.status}: ${detail.slice(0, 400)}`);
    }
    const data = await res.json();
    return String(data.text || '').trim();
}
