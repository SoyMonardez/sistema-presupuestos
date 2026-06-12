import { Router } from 'express';
import db from '../db.js';

const router = Router();

const listStmt = db.prepare('SELECT * FROM price_refs ORDER BY position, id');

router.get('/', (_req, res) => {
    res.json(listStmt.all());
});

// Guardado simple: el frontend manda la lista completa y se reemplaza (igual que items).
const replaceAll = db.transaction((prices) => {
    db.prepare('DELETE FROM price_refs').run();
    const insert = db.prepare(
        `INSERT INTO price_refs (name, unit, price, position, updated_at) VALUES (?, ?, ?, ?, datetime('now'))`
    );
    prices.forEach((p, i) => {
        insert.run(
            String(p.name || '').trim().slice(0, 120) || 'Item',
            String(p.unit || 'un.').trim().slice(0, 20),
            Number(p.price) || 0,
            i
        );
    });
});

router.put('/', (req, res) => {
    const prices = Array.isArray(req.body?.prices) ? req.body.prices : null;
    if (!prices) return res.status(400).json({ error: 'Falta prices[]' });
    if (prices.length > 300) return res.status(400).json({ error: 'Demasiados precios' });
    replaceAll(prices.filter(p => String(p.name || '').trim()));
    res.json({ prices: listStmt.all() });
});

export default router;

// Bloque de contexto para los prompts de IA. Devuelve '' si no hay precios cargados.
export function priceRefsPromptBlock() {
    const prices = listStmt.all();
    if (!prices.length) return '';
    const lines = prices.slice(0, 150).map(p => `- ${p.name}: $${p.price} por ${p.unit}`);
    return `\n\nLISTA DE PRECIOS DEL USUARIO (su tarifario real — tiene PRIORIDAD ABSOLUTA sobre cualquier estimación tuya):\n${lines.join('\n')}\n\nReglas para usar la lista:\n- Si un item del trabajo coincide o es equivalente a uno de la lista, usá ESE precio exacto.\n- Si un item es similar o derivado (ej. la lista tiene "Revoque grueso" y piden "revoque fino"), extrapolá desde el precio de la lista, no desde tu conocimiento general.\n- Solo si el item no tiene ninguna relación con la lista, estimá un precio de mercado.`;
}
