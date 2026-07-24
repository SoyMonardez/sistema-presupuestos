import express from 'express';
import { Router } from 'express';
import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseItemsFromText } from './ai.js';

const router = Router();
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'extract.py');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');
const ALLOWED = ['pdf', 'xlsx', 'csv'];

// Aceptamos cualquier content-type (el archivo viene como body crudo); validamos por ?ext=
const rawFile = express.raw({ type: () => true, limit: '20mb' });

function runExtract(file, ext) {
    return new Promise((resolve, reject) => {
        let py;
        try {
            py = spawn(PYTHON, [SCRIPT, file, ext], {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            });
            py.stdout.setEncoding('utf8');
            py.stderr.setEncoding('utf8');
        } catch (e) {
            return reject(new Error('No se pudo ejecutar Python'));
        }
        let out = '', err = '';
        py.stdout.on('data', d => { out += d; });
        py.stderr.on('data', d => { err += d; });
        py.on('error', () => reject(new Error('No se pudo ejecutar Python (¿está instalado?)')));
        py.on('close', (code) => {
            const line = out.trim().split('\n').filter(Boolean).pop();
            if (!line) return reject(new Error(err.slice(0, 300) || `El lector terminó con código ${code}`));
            try { resolve(JSON.parse(line)); }
            catch { reject(new Error('Respuesta inválida del lector de archivos')); }
        });
    });
}

function normItems(arr) {
    return (Array.isArray(arr) ? arr : []).slice(0, 300).map(i => ({
        name: String(i.name || '').slice(0, 200),
        detail: String(i.detail || '').slice(0, 1000),
        quantity: Number(i.quantity) || 1,
        unit: String(i.unit || 'un.').slice(0, 20) || 'un.',
        unit_price: Number(i.unit_price) || 0,
    })).filter(i => i.name.trim());
}

router.post('/', rawFile, async (req, res) => {
    const ext = String(req.query.ext || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!ALLOWED.includes(ext)) {
        return res.status(400).json({ error: 'Subí un archivo PDF, Excel (.xlsx) o CSV' });
    }
    if (!req.body || !req.body.length) {
        return res.status(400).json({ error: 'No llegó el archivo' });
    }

    const tmp = path.join(os.tmpdir(), `presu_import_${Date.now()}_${Math.random().toString(36).slice(2)}.${ext}`);
    try {
        fs.writeFileSync(tmp, req.body);
        const out = await runExtract(tmp, ext);
        if (out.error) return res.status(422).json({ error: out.error });

        let items = [];
        if (out.source === 'table') {
            items = normItems(out.items);
        } else if (out.source === 'text' && String(out.text || '').trim()) {
            // No detectamos columnas claras → que la IA interprete el contenido
            items = await parseItemsFromText(out.text);
        }
        items = items.filter(i => i.name && i.name.trim());
        res.json({ items });
    } catch (err) {
        console.error('[import]', err.message);
        const limite = /\b429\b|rate_limit/i.test(err.message);
        res.status(502).json({ error: limite
            ? 'Se alcanzó el límite diario de IA. Probá de nuevo más tarde.'
            : 'No se pudo procesar el archivo. Probá con otro o revisá el formato.' });
    } finally {
        fs.unlink(tmp, () => {});
    }
});

export default router;
