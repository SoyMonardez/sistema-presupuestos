import { Router } from 'express';
import db from '../db.js';

const router = Router();

const listStmt = db.prepare(`
    SELECT b.*,
           COALESCE((SELECT SUM(i.quantity * i.unit_price) FROM items i WHERE i.budget_id = b.id), 0) AS total,
           (SELECT COUNT(*) FROM items i WHERE i.budget_id = b.id) AS item_count
    FROM budgets b
    ORDER BY b.updated_at DESC
`);

const getStmt   = db.prepare('SELECT * FROM budgets WHERE id = ?');
const itemsStmt = db.prepare('SELECT * FROM items WHERE budget_id = ? ORDER BY position, id');

router.get('/', (_req, res) => {
    res.json(listStmt.all());
});

router.post('/', (req, res) => {
    const name = String(req.body?.name || '').trim() || 'Presupuesto sin nombre';
    const client = String(req.body?.client || '').trim();
    const info = db.prepare('INSERT INTO budgets (name, client) VALUES (?, ?)').run(name, client);
    res.status(201).json({ ...getStmt.get(info.lastInsertRowid), items: [], total: 0 });
});

router.get('/:id', (req, res) => {
    const budget = getStmt.get(req.params.id);
    if (!budget) return res.status(404).json({ error: 'No existe' });
    const items = itemsStmt.all(budget.id);
    const total = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    res.json({ ...budget, items, total });
});

router.put('/:id', (req, res) => {
    const budget = getStmt.get(req.params.id);
    if (!budget) return res.status(404).json({ error: 'No existe' });
    const name     = String(req.body?.name ?? budget.name).trim() || budget.name;
    const client   = String(req.body?.client ?? budget.client).trim();
    const notes    = String(req.body?.notes ?? budget.notes);
    const location = String(req.body?.location ?? budget.location).trim();
    const validity = Math.max(0, Math.round(Number(req.body?.validity_days ?? budget.validity_days) || 0));
    const advance  = Math.min(100, Math.max(0, Number(req.body?.advance_pct ?? budget.advance_pct) || 0));
    const format   = (String(req.body?.format ?? budget.format).trim() === 'municipal') ? 'municipal' : 'original';
    const cRole    = String(req.body?.client_role ?? budget.client_role).trim();
    const cAddr    = String(req.body?.client_address ?? budget.client_address).trim();
    const cCp      = String(req.body?.client_cp ?? budget.client_cp).trim();
    const cPhone   = String(req.body?.client_phone ?? budget.client_phone).trim();
    const cEmail   = String(req.body?.client_email ?? budget.client_email).trim();
    db.prepare(`UPDATE budgets SET name = ?, client = ?, notes = ?, location = ?, validity_days = ?, advance_pct = ?, format = ?, client_role = ?, client_address = ?, client_cp = ?, client_phone = ?, client_email = ?, updated_at = datetime('now') WHERE id = ?`)
      .run(name, client, notes, location, validity, advance, format, cRole, cAddr, cCp, cPhone, cEmail, budget.id);
    res.json(getStmt.get(budget.id));
});

router.delete('/:id', (req, res) => {
    const info = db.prepare('DELETE FROM budgets WHERE id = ?').run(req.params.id);
    if (!info.changes) return res.status(404).json({ error: 'No existe' });
    res.json({ ok: true });
});

// Guardado simple: el frontend manda el set completo de items y se reemplaza.
const replaceItems = db.transaction((budgetId, items) => {
    db.prepare('DELETE FROM items WHERE budget_id = ?').run(budgetId);
    const insert = db.prepare(
        'INSERT INTO items (budget_id, name, quantity, unit, unit_price, position, detail) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    items.forEach((item, i) => {
        insert.run(
            budgetId,
            String(item.name || '').trim() || 'Item',
            Number(item.quantity) || 0,
            String(item.unit || 'un.').trim(),
            Number(item.unit_price) || 0,
            i,
            String(item.detail || '').slice(0, 1000)
        );
    });
    db.prepare(`UPDATE budgets SET updated_at = datetime('now') WHERE id = ?`).run(budgetId);
});

router.put('/:id/items', (req, res) => {
    const budget = getStmt.get(req.params.id);
    if (!budget) return res.status(404).json({ error: 'No existe' });
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'Falta items[]' });
    if (items.length > 200) return res.status(400).json({ error: 'Demasiados items' });
    replaceItems(budget.id, items);
    const saved = itemsStmt.all(budget.id);
    const total = saved.reduce((sum, i) => sum + i.quantity * i.unit_price, 0);
    res.json({ items: saved, total });
});

export default router;
