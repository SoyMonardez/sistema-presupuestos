import crypto from 'node:crypto';
import { PRINCIPAL, enterWorkspace } from './db.js';

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const APP_SECRET   = process.env.APP_SECRET || '';

// Accesos: contraseña → espacio de trabajo (su propia base de datos).
//   APP_PASSWORD         → 'principal' (la base de siempre)
//   APP_PASSWORD_<NOMBRE> → un espacio aparte llamado <nombre> en minúsculas
// Las contraseñas viven en el .env, nunca en el código.
export function loadAccesses(env = process.env) {
    const accesses = new Map();    // nombre → contraseña
    if (env.APP_PASSWORD) accesses.set(PRINCIPAL, env.APP_PASSWORD);
    for (const [key, value] of Object.entries(env)) {
        const m = key.match(/^APP_PASSWORD_([A-Za-z0-9_-]+)$/);
        if (!m || !value) continue;
        const name = m[1].toLowerCase();
        if (name === PRINCIPAL) throw new Error(`APP_PASSWORD_${m[1]}: "${PRINCIPAL}" es el nombre del acceso APP_PASSWORD`);
        accesses.set(name, value);
    }
    // Dos accesos con la misma contraseña: entraría siempre al primero.
    const vistas = new Set();
    for (const pass of accesses.values()) {
        if (vistas.has(pass)) throw new Error('Hay dos accesos con la misma contraseña en el .env');
        vistas.add(pass);
    }
    return accesses;
}

export const ACCESSES = loadAccesses();

// Token: base64url(payload).hmac — sin dependencias, suficiente para un solo usuario.
// Para cerrar TODAS las sesiones abiertas (un celular perdido, un token que se
// filtró) se cambia APP_SECRET en el .env y se reinicia: los tokens viejos dejan
// de validar. Un mes y no tres: si uno se escapa, sirve menos tiempo.
const TOKEN_DAYS = 30;

function sign(payload) {
    return crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
}

// Se comparan los hashes y no los textos: así los dos lados miden lo mismo y el
// tiempo de la comparación no delata el largo de la contraseña.
function safeEqual(a, b) {
    const ha = crypto.createHash('sha256').update(String(a)).digest();
    const hb = crypto.createHash('sha256').update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
}

export function issueToken(ws = PRINCIPAL) {
    const payload = Buffer.from(JSON.stringify({
        exp: Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000,
        ws,
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

/** A qué espacio da acceso la contraseña, o null si no es ninguna. */
export function verifyPassword(password) {
    if (!password) return null;
    // Se recorren todos sin cortar al primero, para que el tiempo no delate cuál era.
    let found = null;
    for (const [name, pass] of ACCESSES) {
        if (safeEqual(password, pass) && !found) found = name;
    }
    return found;
}

/** El espacio del token, o null si el token no sirve. */
export function verifyToken(token) {
    if (!token) return null;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return null;
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!safeEqual(mac, sign(payload))) return null;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        if (typeof data.exp !== 'number' || data.exp <= Date.now()) return null;
        // Los tokens de antes no traían espacio: eran todos del principal.
        const ws = data.ws ?? PRINCIPAL;
        // Si sacaron el acceso del .env, sus sesiones dejan de servir.
        return ACCESSES.has(ws) ? ws : null;
    } catch {
        return null;
    }
}

export function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    const ws = verifyToken(token);
    if (!ws) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    req.ws = ws;
    enterWorkspace(ws);
    next();
}

/**
 * Vuelve a dejar activo el espacio de la petición. Va después de un body-parser
 * (ver enterWorkspace en db.js): el parser lo pierde al leer el cuerpo.
 */
export function workspace(req, _res, next) {
    enterWorkspace(req.ws);
    next();
}
