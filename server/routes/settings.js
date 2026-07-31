// Parámetros del negocio: qué se le suma al costo directo para llegar al precio
// que se le cobra al cliente.
//
// Vive acá y no en el prompt porque cada empresa tiene los suyos, y porque la
// cuenta la tiene que hacer el servidor: si la IA multiplica márgenes a ojo, el
// presupuesto sale mal y se factura mal.

import { Router } from 'express';
import db from '../db.js';
import { coeficiente, desglose, DEFAULTS } from '../lib/markup.js';

const router = Router();

const getStmt = db.prepare('SELECT * FROM business_settings WHERE id = 1');

/** Los parámetros vigentes. Si la fila no está, se cae a los valores por defecto. */
export function loadSettings() {
    return getStmt.get() || { ...DEFAULTS };
}

router.get('/', (_req, res) => {
    const cfg = loadSettings();
    res.json({
        settings: cfg,
        coeficiente: coeficiente(cfg),
        // Un ejemplo concreto se entiende mucho mejor que el coeficiente pelado.
        ejemplo: desglose(100000, cfg),
    });
});

const limitar = (valor, actual, max) => {
    const n = Number(valor);
    if (!Number.isFinite(n)) return actual;
    return Math.min(Math.max(n, 0), max);
};

router.put('/', (req, res) => {
    const actual = loadSettings();
    const body = req.body || {};

    // Los topes son generosos a propósito (cada rubro maneja lo suyo), pero
    // impiden un 5000% por un cero de más.
    const cfg = {
        gastos_pct:   limitar(body.gastos_pct,   actual.gastos_pct,   200),
        utilidad_pct: limitar(body.utilidad_pct, actual.utilidad_pct, 200),
        // Ingresos brutos se divide, así que un valor cerca de 100 haría explotar
        // el precio. Se corta bien antes.
        iibb_pct:     limitar(body.iibb_pct,     actual.iibb_pct,     50),
        iva_pct:      limitar(body.iva_pct,      actual.iva_pct,      100),
        aplica_iva:   body.aplica_iva === undefined ? actual.aplica_iva : (body.aplica_iva ? 1 : 0),
    };

    db.prepare(`
        UPDATE business_settings
        SET gastos_pct = ?, utilidad_pct = ?, iibb_pct = ?, iva_pct = ?, aplica_iva = ?,
            updated_at = datetime('now')
        WHERE id = 1
    `).run(cfg.gastos_pct, cfg.utilidad_pct, cfg.iibb_pct, cfg.iva_pct, cfg.aplica_iva);

    const guardado = loadSettings();
    res.json({
        settings: guardado,
        coeficiente: coeficiente(guardado),
        ejemplo: desglose(100000, guardado),
    });
});

export default router;
