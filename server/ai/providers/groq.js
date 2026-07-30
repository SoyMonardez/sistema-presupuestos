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

export async function complete({ system, messages, schema, expectJson = false, maxTokens = 2000, temperature = 0.2, hasImages = false }) {
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
            ...(wantsJson ? { response_format: { type: 'json_object' } } : {}),
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Groq ${res.status}: ${detail.slice(0, 400)}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Respuesta vacía de Groq');

    return wantsJson ? JSON.parse(content) : { text: content };
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
