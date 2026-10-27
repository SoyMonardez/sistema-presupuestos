// Voz de ElevenLabs. La clave vive solo en el .env del servidor.
const API = 'https://api.elevenlabs.io/v1';
const VOICE_ID = process.env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';
const MODEL_ID = process.env.ELEVENLABS_MODEL_ID || 'eleven_multilingual_v2';
// La conversación por voz necesita que la primera sílaba llegue rápido más que
// la mejor entonación: Flash tarda una fracción de multilingual_v2.
const FAST_MODEL_ID = process.env.ELEVENLABS_FAST_MODEL_ID || 'eleven_flash_v2_5';
// Velocidad de habla: 1 es la normal de la voz; ElevenLabs acepta de 0.7 a 1.2.
// Probado en el celular, a 1 se escuchaba lento para una conversación.
const SPEED = Math.min(1.2, Math.max(0.7, Number(process.env.ELEVENLABS_SPEED) || 1.1));

export function isConfigured() {
    return Boolean(process.env.ELEVENLABS_API_KEY);
}

export async function synthesize(text, { rapida = false } = {}) {
    if (!isConfigured()) throw new Error('La voz de ElevenLabs no está configurada');
    const res = await fetch(`${API}/text-to-speech/${encodeURIComponent(VOICE_ID)}/stream?output_format=mp3_44100_128`, {
        method: 'POST',
        headers: {
            'xi-api-key': process.env.ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
        },
        body: JSON.stringify({
            text: String(text || '').slice(0, 3000),
            model_id: rapida ? FAST_MODEL_ID : MODEL_ID,
            language_code: 'es',
            voice_settings: { stability: 0.55, similarity_boost: 0.7, style: 0, use_speaker_boost: true, speed: SPEED },
        }),
        signal: AbortSignal.timeout(rapida ? 20000 : 45000),
    });
    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`ElevenLabs ${res.status}: ${detail.slice(0, 240)}`);
    }
    return Buffer.from(await res.arrayBuffer());
}

/**
 * Token de un solo uso para que el navegador abra el WebSocket de Scribe
 * (voz a texto en vivo) sin ver nunca la clave. Vence a los 15 minutos y se
 * consume al conectar, así que se pide uno por sesión de escucha.
 */
export async function tokenTranscripcion() {
    if (!isConfigured()) throw new Error('La voz de ElevenLabs no está configurada');
    const res = await fetch(`${API}/single-use-token/realtime_scribe`, {
        method: 'POST',
        headers: { 'xi-api-key': process.env.ELEVENLABS_API_KEY },
        signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`ElevenLabs token ${res.status}: ${detail.slice(0, 240)}`);
    }
    const data = await res.json();
    if (!data?.token) throw new Error('ElevenLabs no devolvió el token');
    return data.token;
}
