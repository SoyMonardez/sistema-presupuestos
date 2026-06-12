const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GROQ_MODEL   = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';

// Mismo patrón que el ai-service del portfolio: respuesta JSON estricta.
export async function callGroq(messages, { temperature = 0.3, maxTokens = 1000 } = {}) {
    if (!GROQ_API_KEY) throw new Error('Falta GROQ_API_KEY en .env');

    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
            model: GROQ_MODEL,
            messages,
            temperature,
            max_tokens: maxTokens,
            response_format: { type: 'json_object' },
        }),
    });

    if (!res.ok) {
        const detail = await res.text();
        throw new Error(`Groq ${res.status}: ${detail.slice(0, 400)}`);
    }
    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('Respuesta vacía de Groq');
    return JSON.parse(content);
}
