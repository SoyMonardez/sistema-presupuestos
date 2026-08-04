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
// `lax`: ver el comentario del mismo nombre en providers/claude.js — para el
// chat, si ni sacando el cerco de código ni el objeto más externo hay JSON
// válido, se toma el texto tal cual como "reply" en vez de perder la respuesta
// entera. Las tareas con forma exacta (comando, visión) no lo activan.
function parseJsonFlexible(raw, { lax = false } = {}) {
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
        if (desde >= 0 && hasta > desde) {
            try {
                return JSON.parse(texto.slice(desde, hasta + 1));
            } catch { /* cae al error de abajo */ }
        }
        if (lax) return { reply: texto };
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
// Durante un tiempo esto estuvo en 'none' PARA TODO, y fue un error caro: las
// tareas que deciden plata (armar un presupuesto, leer una hoja, editar items)
// quedaron sin pensar nada, y se notó — presupuestos a costo, cantidades
// redondeadas a ojo, precios tirados de memoria.
//
// Ahora cada nivel pide lo suyo, y el riesgo de quedarse sin margen se cubre
// donde corresponde: si el modelo gasta todo pensando y devuelve vacío, se
// reintenta sin razonamiento (ver reintentoSinRazonar más abajo). Es mejor
// pensar y tener una red que no pensar nunca.
// Ojo: qwen3 en Groq solo acepta 'none' o 'default'. Los niveles finos ('low',
// 'medium', 'high') que sí entiende Claude devuelven 400 acá, así que se
// colapsan: lo mecánico no piensa, lo que decide números piensa.
const EFFORT_TO_GROQ = { low: 'none', medium: 'default', high: 'default' };

/**
 * Reintenta cuando Groq dice "esperá y probá de nuevo".
 *
 * El tier gratuito tiene un techo de tokens por minuto que se llena rápido si hay
 * dos llamadas seguidas (el chat hace eso cuando busca precios: una para pedir la
 * búsqueda y otra para redactar con los resultados). El propio error trae cuánto
 * hay que esperar, y casi siempre son unos segundos: vale mucho más la pena
 * aguantar eso que devolverle "probá más tarde" a alguien que está laburando.
 */
async function fetchConEspera(url, opciones, intentos = 2) {
    for (let i = 0; ; i++) {
        const res = await fetch(url, opciones);
        if (res.ok || i >= intentos) return res;

        const detalle = await res.clone().text();
        if (res.status !== 429) return res;

        // "Please try again in 3.57s"
        const m = detalle.match(/try again in ([\d.]+)s/i);
        const espera = Math.min(Math.ceil((parseFloat(m?.[1]) || 3) * 1000) + 250, 12000);
        console.warn(`[groq] cuota llena, reintento en ${Math.round(espera / 1000)}s`);
        await new Promise(r => setTimeout(r, espera));
    }
}

// El cuerpo del request es el mismo con y sin streaming; solo cambia el flag.
function buildBody({ system, messages, schema, expectJson, maxTokens, temperature, hasImages, effort, stream = false }) {
    const wantsJson = Boolean(schema) || expectJson;
    return {
        model: hasImages ? VISION_MODEL : MODEL,
        messages: toGroqMessages(system, messages),
        temperature,
        max_tokens: maxTokens,
        ...(stream ? { stream: true } : {}),
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
    };
}

export const supportsStream = true;

/**
 * Igual que complete(), pero avisando el texto a medida que llega.
 *
 * `onDelta(fragmento)` recibe los pedazos crudos del contenido. Como las tareas
 * que streamean piden JSON, lo que va llegando es el JSON a medio escribir: el
 * que llama decide qué mostrar de eso (ver extraerReplyParcial en el chat).
 */
export async function completeStream(opts, onDelta) {
    const wantsJson = Boolean(opts.schema) || opts.expectJson;

    // Acá NO se pide response_format: json_object, y es a propósito.
    //
    // Groq valida el JSON del lado del servidor antes de contestar, así que con
    // el modo estricto la respuesta llega ENTERA en un solo fragmento: medido,
    // 1 fragmento con json_object contra 131 sin él, y el primer texto en
    // pantalla pasa de 724 ms a 426 ms. Con el modo estricto el streaming
    // existe en el papel y no en la práctica.
    //
    // A cambio hay que parsear a mano lo que llega, que es justo lo que hace
    // parseJsonFlexible. Si aun así sale mal, el que llama tiene la respuesta
    // sin streaming como red (ver el catch en routes/chat.js).
    const body = buildBody({ ...opts, stream: true });
    delete body.response_format;

    const res = await fetchConEspera(`${API}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify(body),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Groq ${res.status}: ${detail.slice(0, 400)}`);
    }

    let completo = '';
    let buffer = '';
    const decoder = new TextDecoder();

    for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        // SSE: eventos separados por línea en blanco, cada uno con "data: {...}".
        const eventos = buffer.split('\n');
        buffer = eventos.pop() || '';   // la última puede estar cortada al medio

        for (const linea of eventos) {
            const dato = linea.trim();
            if (!dato.startsWith('data:')) continue;
            const payload = dato.slice(5).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
                const json = JSON.parse(payload);
                const trozo = json.choices?.[0]?.delta?.content;
                if (trozo) {
                    completo += trozo;
                    onDelta?.(trozo);
                }
            } catch {
                // Un evento suelto malformado no justifica tirar toda la respuesta.
            }
        }
    }

    if (!completo) throw new Error('Respuesta vacía de Groq');
    return wantsJson ? parseJsonFlexible(completo, { lax: opts.laxFallback }) : { text: completo };
}

/**
 * Un modelo que razona gasta del MISMO presupuesto para pensar y para contestar.
 * Con un prompt largo puede quedarse sin margen: termina por "length" habiendo
 * pensado todo y escrito nada, y Groq lo reporta como "failed to validate JSON"
 * con failed_generation vacío, que no dice nada de lo que pasó.
 *
 * Cuando eso ocurre se rehace la consulta sin razonamiento. Se pierde calidad en
 * ese mensaje puntual, pero se pierde entero si no.
 */
function sinMargenParaContestar(data, err) {
    if (err) return /failed_generation":\s*""/.test(err.message) || /json_validate_failed/.test(err.message);
    const choice = data?.choices?.[0];
    return choice?.finish_reason === 'length' && !choice?.message?.content;
}

export async function complete({ system, messages, schema, expectJson = false, maxTokens = 2000, temperature = 0.2, hasImages = false, effort = 'medium', laxFallback = false }) {
    const wantsJson = Boolean(schema) || expectJson;

    const pedir = async (esfuerzo) => {
        const res = await fetchConEspera(`${API}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(buildBody({ system, messages, schema, expectJson, maxTokens, temperature, hasImages, effort: esfuerzo })),
        });
        if (!res.ok) {
            const detail = await res.text();
            const err = new Error(`Groq ${res.status}: ${detail.slice(0, 400)}`);
            if (sinMargenParaContestar(null, err)) err.sinMargen = true;
            throw err;
        }
        return res.json();
    };

    let data;
    try {
        data = await pedir(effort);
        if (sinMargenParaContestar(data)) {
            console.warn('[groq] se quedó sin margen pensando, reintento sin razonamiento');
            data = await pedir('low');   // 'low' mapea a 'none': sin razonamiento
        }
    } catch (err) {
        if (!err.sinMargen) throw err;
        console.warn('[groq] se quedó sin margen pensando, reintento sin razonamiento');
        data = await pedir('low');
    }

    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Respuesta vacía de Groq');

    return wantsJson ? parseJsonFlexible(content, { lax: laxFallback }) : { text: content };
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
