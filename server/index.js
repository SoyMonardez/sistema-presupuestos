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
import { routingSummary } from './ai/provider.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3002;

if (!process.env.APP_PASSWORD || !process.env.APP_SECRET) {
    console.error('[presupuestos] Faltan APP_PASSWORD y/o APP_SECRET en .env');
    process.exit(1);
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Login con rate limit básico (anti fuerza bruta) ----------
const loginAttempts = new Map(); // ip → { count, resetAt }
app.post('/api/login', (req, res) => {
    const ip = req.ip;
    const now = Date.now();
    const entry = loginAttempts.get(ip);
    if (entry && entry.resetAt > now && entry.count >= 10) {
        return res.status(429).json({ error: 'Demasiados intentos. Esperá unos minutos.' });
    }
    if (verifyPassword(String(req.body?.password || ''))) {
        loginAttempts.delete(ip);
        return res.json({ token: issueToken() });
    }
    if (!entry || entry.resetAt <= now) {
        loginAttempts.set(ip, { count: 1, resetAt: now + 15 * 60 * 1000 });
    } else {
        entry.count++;
    }
    res.status(401).json({ error: 'Contraseña incorrecta' });
});

// ---------- API protegida ----------
app.use('/api/budgets', authMiddleware, budgetsRouter);
app.use('/api/prices', authMiddleware, pricesRouter);
app.use('/api/units', authMiddleware, unitsRouter);
app.use('/api/ai', authMiddleware, aiRouter);
app.use('/api/import', authMiddleware, importRouter);

// ---------- Frontend estático ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

app.listen(PORT, () => {
    console.log(`[presupuestos] Escuchando en http://localhost:${PORT}`);
    // Qué proveedor atiende cada tarea. Si falta una API key se ve acá al arrancar,
    // en vez de descubrirlo cuando la app tira un error a mitad de un presupuesto.
    const rutas = routingSummary();
    console.log('[presupuestos] IA: ' + Object.entries(rutas).map(([t, p]) => `${t}→${p}`).join('  '));
});
