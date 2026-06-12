import express from 'express';
import { Router } from 'express';
import { callGroq, transcribeAudio } from '../groq.js';

const router = Router();

const PARSE_SYSTEM = `Sos un presupuestista experto en construcción y refacciones en Argentina. Convertís descripciones habladas o escritas de trabajos en items de presupuesto. El usuario dicta por voz, así que el texto puede venir desprolijo, sin puntuación y con jerga.

Reglas:
- Devolvé SOLO un JSON con esta forma exacta: {"items":[{"name":"...","quantity":N,"unit":"...","unit_price":N}]}
- "name": nombre claro y profesional del item, con mayúscula inicial (ej: "Demolición de pared de ladrillo", "Mano de obra").
- "quantity": número. Si no se menciona, usar 1.
- "unit": unidad de medida. Usá: "m²" (metros cuadrados), "m" (metros lineales), "un." (unidades), "kg", "lt", "hs" (horas), "saco", "día", "global". Si no está claro, "un.".
- "unit_price": precio unitario en pesos argentinos, número sin separadores.
- Jerga de plata argentina: "luca" = 1.000 (ej "15 lucas" = 15000), "un palo" = 1.000.000, "gamba" = 100, "20 mil" = 20000, "k" = 1000.
- Si dicen el precio total de varias unidades (ej "3 puertas por 300 mil"), calculá el precio unitario (100000).
- Si NO mencionan precio, estimá un precio de mercado realista en pesos argentinos actuales (tené en cuenta la inflación: los precios de construcción en Argentina son altos, ej. la hora de albañil ronda decenas de miles de pesos, no cientos). El usuario siempre revisa y corrige antes de confirmar.
- Si mencionan un trabajo grande sin detallar (ej "hacer un baño completo"), desglosalo en sus items típicos (demolición, materiales, colocación, plomería, mano de obra, etc.).
- Si el texto no contiene ningún trabajo o item reconocible, devolvé {"items":[]}.`;

const SUGGEST_SYSTEM = `Sos un asistente de presupuestos para un trabajador argentino (construcción, refacciones, servicios). El usuario está escribiendo el nombre de un item y necesitás sugerir cómo completarlo.

Reglas:
- Devolvé SOLO un JSON con esta forma: {"suggestions":[{"name":"...","unit":"...","unit_price":N}]}
- Máximo 3 sugerencias, ordenadas por relevancia.
- "name": nombre completo y profesional del item que empieza o se relaciona con lo que escribió el usuario.
- "unit": unidad típica ("m²", "m", "un.", "kg", "lt", "hs", "saco", "día", "global").
- "unit_price": precio estimado de mercado en pesos argentinos actuales (número, sin separadores). Tené en cuenta la inflación argentina: los precios de construcción son altos (la hora de albañil ronda decenas de miles de pesos, el m² de colocación de cerámica también). Si no tenés idea, usá 0.
- Tené en cuenta los items que ya cargó (te los paso como contexto) para inferir el rubro del trabajo.`;

// Audio crudo (el frontend manda el blob del MediaRecorder tal cual)
const rawAudio = express.raw({ type: ['audio/*', 'video/*', 'application/octet-stream'], limit: '15mb' });

router.post('/transcribe', rawAudio, async (req, res) => {
    if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'No llegó audio' });
    }
    try {
        const text = await transcribeAudio(req.body, req.headers['content-type'] || 'audio/webm');
        if (!text) return res.status(422).json({ error: 'No se entendió el audio. Probá de nuevo más cerca del micrófono.' });
        res.json({ text });
    } catch (err) {
        console.error('[ai/transcribe]', err.message);
        res.status(502).json({ error: 'No se pudo transcribir el audio. Probá de nuevo.' });
    }
});

router.post('/parse', async (req, res) => {
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'Falta el texto' });
    if (text.length > 4000) return res.status(400).json({ error: 'Texto demasiado largo' });

    try {
        const result = await callGroq([
            { role: 'system', content: PARSE_SYSTEM },
            { role: 'user', content: text },
        ], { temperature: 0.2, maxTokens: 1500 });

        const items = Array.isArray(result.items) ? result.items.slice(0, 50).map(i => ({
            name: String(i.name || '').slice(0, 120) || 'Item',
            quantity: Number(i.quantity) || 1,
            unit: String(i.unit || 'un.').slice(0, 20),
            unit_price: Number(i.unit_price) || 0,
        })) : [];
        res.json({ items });
    } catch (err) {
        console.error('[ai/parse]', err.message);
        res.status(502).json({ error: 'La IA no pudo procesar el texto. Probá de nuevo.' });
    }
});

router.post('/suggest', async (req, res) => {
    const query = String(req.body?.query || '').trim();
    if (query.length < 2) return res.json({ suggestions: [] });

    const context = Array.isArray(req.body?.items)
        ? req.body.items.slice(0, 30).map(i => String(i.name || '').slice(0, 80)).filter(Boolean)
        : [];

    try {
        const result = await callGroq([
            { role: 'system', content: SUGGEST_SYSTEM },
            { role: 'user', content: `Items ya cargados: ${context.length ? context.join(', ') : '(ninguno)'}\nEl usuario está escribiendo: "${query.slice(0, 120)}"` },
        ], { temperature: 0.4, maxTokens: 400 });

        const suggestions = Array.isArray(result.suggestions) ? result.suggestions.slice(0, 3).map(s => ({
            name: String(s.name || '').slice(0, 120),
            unit: String(s.unit || 'un.').slice(0, 20),
            unit_price: Number(s.unit_price) || 0,
        })).filter(s => s.name) : [];
        res.json({ suggestions });
    } catch (err) {
        console.error('[ai/suggest]', err.message);
        res.json({ suggestions: [] });
    }
});

export default router;
