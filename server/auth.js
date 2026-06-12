import crypto from 'node:crypto';

const APP_PASSWORD = process.env.APP_PASSWORD || '';
const APP_SECRET   = process.env.APP_SECRET || '';

// Token: base64url(payload).hmac — sin dependencias, suficiente para un solo usuario.
const TOKEN_DAYS = 90;

function sign(payload) {
    return crypto.createHmac('sha256', APP_SECRET).update(payload).digest('base64url');
}

function safeEqual(a, b) {
    const ba = Buffer.from(a);
    const bb = Buffer.from(b);
    return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

export function issueToken() {
    const payload = Buffer.from(JSON.stringify({
        exp: Date.now() + TOKEN_DAYS * 24 * 60 * 60 * 1000,
    })).toString('base64url');
    return `${payload}.${sign(payload)}`;
}

export function verifyPassword(password) {
    if (!password || !APP_PASSWORD) return false;
    return safeEqual(password, APP_PASSWORD);
}

export function verifyToken(token) {
    if (!token) return false;
    const dot = token.lastIndexOf('.');
    if (dot < 0) return false;
    const payload = token.slice(0, dot);
    const mac = token.slice(dot + 1);
    if (!safeEqual(mac, sign(payload))) return false;
    try {
        const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
        return typeof data.exp === 'number' && data.exp > Date.now();
    } catch {
        return false;
    }
}

export function authMiddleware(req, res, next) {
    const header = req.headers['authorization'] || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : header;
    if (!verifyToken(token)) {
        return res.status(401).json({ error: 'No autorizado' });
    }
    next();
}
