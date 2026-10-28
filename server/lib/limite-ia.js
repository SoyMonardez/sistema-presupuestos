// Límite de uso de las rutas que gastan créditos de IA (Claude, Groq, ElevenLabs).
//
// El login ya tiene el suyo, pero con un token robado (o un bug del navegador
// que repita pedidos en bucle) se podía llamar a la IA sin techo. Se cuenta por
// acceso y no por IP: el que paga es el acceso, y un celular cambia de IP.
//
// Dos ventanas: una por minuto, que corta un bucle enseguida, y una por día, que
// pone techo a lo que se puede gastar aunque vaya despacio. Los números son
// holgados para el uso real (una conversación por voz rápida son unas 3 o 4
// llamadas por turno) y se cambian en el .env sin tocar código.

const MINUTO_MS = 60 * 1000;
const DIA_MS = 24 * 60 * 60 * 1000;

export function crearLimiteIA({
    porMinuto = Number(process.env.IA_LIMITE_MINUTO) || 60,
    porDia = Number(process.env.IA_LIMITE_DIA) || 2000,
    ahora = () => Date.now(),
} = {}) {
    const usos = new Map();     // acceso → { minuto: {n, desde}, dia: {n, desde} }

    function contar(ventana, largo, t) {
        if (t - ventana.desde >= largo) { ventana.n = 0; ventana.desde = t; }
        return ventana;
    }

    /** true si el pedido entra; lo cuenta. */
    function permitir(clave) {
        const t = ahora();
        let u = usos.get(clave);
        if (!u) { u = { minuto: { n: 0, desde: t }, dia: { n: 0, desde: t } }; usos.set(clave, u); }
        const m = contar(u.minuto, MINUTO_MS, t);
        const d = contar(u.dia, DIA_MS, t);
        if (m.n >= porMinuto) return { ok: false, motivo: 'minuto', reintentar: m.desde + MINUTO_MS - t };
        if (d.n >= porDia) return { ok: false, motivo: 'dia', reintentar: d.desde + DIA_MS - t };
        m.n++;
        d.n++;
        return { ok: true };
    }

    /** Middleware de Express. Va después de authMiddleware: usa req.ws. */
    function middleware(req, res, next) {
        const r = permitir(req.ws || req.ip);
        if (r.ok) return next();
        res.set('Retry-After', String(Math.ceil(r.reintentar / 1000)));
        res.status(429).json({ error: r.motivo === 'minuto'
            ? 'Demasiados pedidos a la IA seguidos. Esperá un minuto.'
            : 'Se alcanzó el límite diario de IA de este acceso. Probá mañana.' });
    }

    return { permitir, middleware };
}
