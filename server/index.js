import './env.js';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authMiddleware, issueToken, verifyPassword } from './auth.js';
import budgetsRouter from './routes/budgets.js';
import pricesRouter from './routes/prices.js';
import unitsRouter from './routes/units.js';
import aiRouter from './routes/ai.js';
import importRouter from './routes/import.js';
import chatRouter from './routes/chat.js';
import settingsRouter from './routes/settings.js';
import { routingSummary } from './ai/provider.js';
import { buildCsp } from './csp.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3002;

if (!process.env.APP_PASSWORD || !process.env.APP_SECRET) {
    console.error('[presupuestos] Faltan APP_PASSWORD y/o APP_SECRET en .env');
    process.exit(1);
}

const app = express();
app.disable('x-powered-by');

// En el VPS esto corre detrás del Nginx Proxy Manager. Sin esto, req.ip devuelve
// la IP del proxy para TODAS las peticiones, así que el límite de intentos del
// login pasa a ser global: con diez contraseñas mal, cualquiera desde afuera te
// deja sin poder entrar quince minutos.
//
// Va en 1 y no en true: se confía en un solo salto (el proxy que está adelante).
// Con `true` se confía en la cadena entera de X-Forwarded-For, que la manda el
// cliente y se puede inventar — ahí el límite se saltea poniendo una IP falsa.
app.set('trust proxy', 1);

// Cabeceras de seguridad. La CSP es lo que convierte un XSS en "se ve un nombre
// raro" en vez de "te roban la sesión": ya pasó una vez que el nombre de un item
// venido de un Excel importado terminara ejecutándose.
const CSP = buildCsp(path.join(__dirname, '..', 'public', 'index.html'));
app.use((_req, res, next) => {
    if (CSP) res.setHeader('Content-Security-Policy', CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    // Nada de esto necesita cámara, micrófono va aparte (lo pide el dictado).
    res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), payment=()');
    next();
});

app.use(express.json({ limit: '512kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Login con rate limit básico (anti fuerza bruta) ----------
const VENTANA_MS = 15 * 60 * 1000;
const MAX_INTENTOS = 10;
const MAX_IPS = 5000;              // techo duro, por si alguien rota direcciones

const loginAttempts = new Map();   // ip → { count, resetAt }

/**
 * Saca las entradas ya vencidas. Ahora que se cuenta por IP real (ver
 * 'trust proxy'), sin esto el Map crece sin techo: cada IP que probó una
 * contraseña mal queda guardada para siempre, y eso es una fuga de memoria
 * que además se puede provocar a propósito.
 */
function limpiarIntentos(now) {
    for (const [ip, e] of loginAttempts) {
        if (e.resetAt <= now) loginAttempts.delete(ip);
    }
    // Si aun así quedó enorme (muchas IPs dentro de la misma ventana), se vacía:
    // perder el conteo es preferible a quedarse sin memoria, y la ventana es corta.
    if (loginAttempts.size > MAX_IPS) loginAttempts.clear();
}

app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    limpiarIntentos(now);

    const entry = loginAttempts.get(ip);
    if (entry && entry.resetAt > now && entry.count >= MAX_INTENTOS) {
        return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos.' });
    }
    if (verifyPassword(String(req.body?.password || ''))) {
        loginAttempts.delete(ip);
        return res.json({ token: issueToken() });
    }
    if (!entry || entry.resetAt <= now) {
        loginAttempts.set(ip, { count: 1, resetAt: now + VENTANA_MS });
    } else {
        entry.count++;
    }
    res.status(401).json({ error: 'Contraseña incorrecta' });
});

// ---------- API protegida ----------
app.use('/api/budgets', authMiddleware, budgetsRouter);
app.use('/api/prices', authMiddleware, pricesRouter);
app.use('/api/units', authMiddleware, unitsRouter);
app.use('/api/settings', authMiddleware, settingsRouter);
app.use('/api/ai', authMiddleware, aiRouter);
app.use('/api/import', authMiddleware, importRouter);
// El chat cuelga de /api porque tiene rutas de los dos lados: las conversaciones
// de un presupuesto (/api/budgets/:id/chats) y los mensajes (/api/chats/:id/...).
//
// Con su propio límite de body: los mensajes pueden traer una foto en base64. El
// navegador ya la achica antes de mandarla (unos 150 kb), pero si no pudo —HEIC
// fuera de iPhone— sube la original, y 512 kb no alcanzan.
app.use('/api', authMiddleware, express.json({ limit: '12mb' }), chatRouter);

// ---------- Frontend estático ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
    console.log(`[presupuestos] Escuchando en http://localhost:${PORT}`);
    // Qué proveedor atiende cada tarea. Si falta una API key se ve acá al arrancar,
    // en vez de descubrirlo cuando la app tira un error a mitad de un presupuesto.
    const rutas = routingSummary();
    console.log('[presupuestos] IA: ' + Object.entries(rutas).map(([t, p]) => `${t}→${p}`).join('  '));
});
