// Catálogo de unidades: lectura para el selector del frontend, y alta/baja de las
// unidades propias del usuario desde Precios base.
//
// (El plan lo ubicaba dentro de prices.js, pero quedó en su propio archivo: son
// dos recursos distintos y prices.js ya tiene su responsabilidad.)

import { Router } from 'express';
import db, { loadUnitCatalog } from '../db.js';
import { KIND, conversionPlan } from '../lib/units.js';
import { normalizeOp } from '../lib/ops.js';

const router = Router();

const VALID_KINDS = new Set(Object.values(KIND));
// Solo las familias de la escalera dimensional pueden pedir medidas.
const VALID_DIMS = new Set(['largo', 'ancho', 'alto']);

router.get('/', (_req, res) => {
    res.json({ units: loadUnitCatalog() });
});

// ---------------------------------------------------------------------------
// Conversión desde el presupuesto
// ---------------------------------------------------------------------------
// El botón "Convertir" del item y el de "Convertir todo" pegan acá. La cuenta la
// hace el servidor y no el navegador a propósito: si la aritmética viviera en el
// frontend habría dos implementaciones (la del chat y la del botón) que se
// pueden desincronizar, que es justo lo que este plan vino a terminar.

/**
 * Qué se puede hacer con esta unidad de origen: a qué unidades llega y qué
 * medida le falta para cada una. Es lo que dibuja el selector de destino, para
 * no ofrecer conversiones que después van a fallar.
 */
router.post('/plan', (req, res) => {
    const from = String(req.body?.from || '').trim();
    if (!from) return res.status(400).json({ error: 'Falta la unidad de origen' });

    const catalog = loadUnitCatalog();
    const options = catalog
        .map(u => {
            const plan = conversionPlan(from, u.label, catalog);
            if (!plan.ok || plan.kind === 'identity') return null;
            return { code: u.code, label: u.label, kind: plan.kind, needs: plan.needs };
        })
        .filter(Boolean);

    res.json({ options });
});

/**
 * Convierte uno, varios o todos los items. Reusa la misma validación que usan
 * los comandos de la IA (`normalizeOp` con action 'convert'), así el botón manual
 * y el pedido hablado dan exactamente el mismo resultado.
 *
 * Devuelve las ops listas para el panel de confirmación — no escribe nada: el
 * guardado sigue pasando por PUT /api/budgets/:id/items cuando el usuario acepta.
 */
router.post('/convert', (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : null;
    if (!items) return res.status(400).json({ error: 'Faltan los items' });
    if (items.length > 300) return res.status(400).json({ error: 'Demasiados items' });

    const target = String(req.body?.target_unit || '').trim();
    if (!target) return res.status(400).json({ error: 'Falta la unidad destino' });

    const { ops, warnings } = normalizeOp(
        {
            action: 'convert',
            target_unit: target,
            num:    req.body?.num,
            nums:   req.body?.nums,
            all:    req.body?.all === true,
            largo:  req.body?.largo,
            ancho:  req.body?.ancho,
            alto:   req.body?.alto,
            pieces: req.body?.pieces,
        },
        items,
        loadUnitCatalog(),
    );

    res.json({ ops, warnings });
});

// Mismo criterio que el tarifario: el frontend manda la lista completa y se
// reemplaza. Las unidades de fábrica no se pueden editar ni borrar — si se
// pudieran, una conversión que ayer andaba dejaría de andar sin aviso.
const replaceCustom = db.transaction((customUnits) => {
    db.prepare('DELETE FROM units WHERE is_custom = 1').run();
    const insert = db.prepare(
        `INSERT INTO units (code, label, kind, factor, dims, is_custom, position)
         VALUES (?, ?, ?, NULL, ?, 1, ?)`
    );
    const base = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM units WHERE is_custom = 0').get().p;

    customUnits.forEach((u, i) => {
        insert.run(u.code, u.label, u.kind, JSON.stringify(u.dims), base + 1 + i);
    });
});

router.put('/', (req, res) => {
    const incoming = Array.isArray(req.body?.units) ? req.body.units : null;
    if (!incoming) return res.status(400).json({ error: 'Falta units[]' });
    if (incoming.length > 60) return res.status(400).json({ error: 'Demasiadas unidades' });

    const reserved = new Set(
        db.prepare('SELECT code FROM units WHERE is_custom = 0').all().map(u => u.code)
    );

    const seen = new Set();
    const clean = [];

    for (const raw of incoming) {
        const label = String(raw?.label || '').trim().slice(0, 20);
        if (!label) continue;

        // El code se deriva de la etiqueta: el usuario escribe "viaje de arena" y
        // no tiene por qué saber que existe una clave interna.
        const code = (String(raw?.code || label)
            .normalize('NFKD')
            .toLowerCase()
            .replace(/[^a-z0-9]/g, '')
            .slice(0, 20)) || null;

        if (!code || reserved.has(code) || seen.has(code)) continue;
        seen.add(code);

        const kind = VALID_KINDS.has(raw?.kind) ? raw.kind : KIND.OTHER;
        const dims = Array.isArray(raw?.dims) ? raw.dims.filter(d => VALID_DIMS.has(d)) : [];

        clean.push({ code, label, kind, dims });
    }

    replaceCustom(clean);
    res.json({ units: loadUnitCatalog() });
});

export default router;

/**
 * Bloque de contexto para los prompts de IA, con las unidades que existen de
 * verdad en esta instalación. Reemplaza las listas que antes estaban escritas a
 * mano en tres prompts distintos y que se desincronizaban entre sí.
 */
export function unitsPromptBlock() {
    const units = loadUnitCatalog();
    if (!units.length) return '';

    const listado = units.map(u => `"${u.label}"`).join(', ');
    const convertibles = units
        .filter(u => u.factor !== null && ['length', 'area', 'volume', 'weight'].includes(u.kind))
        .map(u => `"${u.label}"`)
        .join(', ');

    return `\n\nUNIDADES DISPONIBLES (usá EXACTAMENTE una de estas etiquetas, nunca inventes ni escribas variantes como "m2" o "metros cuadrados"):\n${listado}\n\nSobre conversiones de unidad:\n- Solo se pueden convertir entre sí las unidades de medida: ${convertibles || '(ninguna)'}.\n- Para pasar de m² a m³ hace falta el espesor; de m a m², el ancho. Si esa medida no está en el item ni te la dieron, NO la inventes: omití ese item y explicá qué falta.\n- Nunca conviertas horas, días, unidades sueltas ni montos globales a una medida: no son compatibles.\n- Vos NO hacés la cuenta de la conversión. Solo indicás la unidad destino y las medidas que leíste; el sistema calcula la cantidad y el precio con matemática exacta.`;
}
