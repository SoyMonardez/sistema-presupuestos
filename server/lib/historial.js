// El historial de cambios de cada presupuesto.
//
// Para qué: que se pueda volver atrás de verdad. "Deshacé" en la pantalla solo
// recordaba la última tanda de la sesión y se perdía al recargar; y cuando él
// pedía "dejá el contrapiso con el precio que tenía", la IA no tenía de dónde
// sacar ese precio y contestaba que no sabía a qué se refería.
//
// Cómo: cada vez que se guardan los items queda una versión (la foto completa
// de la lista). Cada item tiene un `uid` que no cambia aunque se lo renombre o
// se lo mueva, así se puede seguir su historia versión a versión. A la IA se le
// pasa un resumen: los últimos cambios y los valores anteriores de cada item.
//
// Las tablas se crean acá y no en db.js a propósito: con los accesos, cada uno
// tiene su propia base, y esto se asegura en la que esté activa al usarse.

import { randomUUID } from 'node:crypto';
import db from '../db.js';

const MAX_VERSIONES = 300;          // por presupuesto; las más viejas se borran
const JUNTAR_MANUAL_MS = 20000;     // tipear un precio no deja una versión por tecla

// ---------------------------------------------------------------------------
// Esquema
// ---------------------------------------------------------------------------
export function asegurarEsquema() {
    db.exec(`
        CREATE TABLE IF NOT EXISTS budget_history (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            budget_id  INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
            ms         INTEGER NOT NULL,
            origen     TEXT    NOT NULL DEFAULT 'manual',
            items_json TEXT    NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_budget_history_budget ON budget_history(budget_id, id);
    `);
    const columnas = db.prepare('PRAGMA table_info(items)').all();
    if (!columnas.some(c => c.name === 'uid')) {
        db.exec(`ALTER TABLE items ADD COLUMN uid TEXT NOT NULL DEFAULT ''`);
    }
}

const UID_VALIDO = /^[A-Za-z0-9_-]{6,48}$/;
export const uidValido = (uid) => UID_VALIDO.test(String(uid || ''));
export const nuevoUid = () => randomUUID();

/** Lo que se guarda de cada item en una versión. */
export function foto(items) {
    return (items || []).map(i => ({
        uid: String(i.uid || ''),
        name: String(i.name || ''),
        detail: String(i.detail || ''),
        quantity: Number(i.quantity) || 0,
        unit: String(i.unit || ''),
        unit_price: Number(i.unit_price) || 0,
    }));
}

// ---------------------------------------------------------------------------
// Registrar versiones
// ---------------------------------------------------------------------------
/**
 * Qué hacer con un guardado nuevo, mirando la última versión:
 *   'igual'  → no cambió nada (se guardó por el encabezado, por ejemplo)
 *   'juntar' → sigue tipeando a mano: se pisa la última en vez de sumar otra
 *   'nueva'  → queda una versión más
 * Separado para poder probarlo sin base.
 */
export function decidirVersion(ultima, json, origen, ahora) {
    if (!ultima) return 'nueva';
    if (ultima.items_json === json) return 'igual';
    if (origen === 'manual' && ultima.origen === 'manual' && ahora - ultima.ms < JUNTAR_MANUAL_MS) return 'juntar';
    return 'nueva';
}

export function registrarVersion(budgetId, items, origen = 'manual', ahora = Date.now()) {
    asegurarEsquema();
    const json = JSON.stringify(foto(items));
    const ultima = db.prepare('SELECT id, ms, origen, items_json FROM budget_history WHERE budget_id = ? ORDER BY id DESC LIMIT 1').get(budgetId);
    const decision = decidirVersion(ultima, json, origen, ahora);
    if (decision === 'igual') return decision;
    if (decision === 'juntar') {
        db.prepare('UPDATE budget_history SET items_json = ?, ms = ? WHERE id = ?').run(json, ahora, ultima.id);
        return decision;
    }
    db.prepare('INSERT INTO budget_history (budget_id, ms, origen, items_json) VALUES (?, ?, ?, ?)').run(budgetId, ahora, origen, json);
    db.prepare(`DELETE FROM budget_history WHERE budget_id = ? AND id NOT IN (
        SELECT id FROM budget_history WHERE budget_id = ? ORDER BY id DESC LIMIT ?)`).run(budgetId, budgetId, MAX_VERSIONES);
    return decision;
}

/**
 * Al abrir un presupuesto: los items viejos no tenían uid (se les pone uno) y
 * si todavía no hay historial se guarda cómo está ahora, para que el primer
 * cambio tenga un "antes" al que volver.
 */
export function prepararPresupuesto(budgetId) {
    asegurarEsquema();
    const sinUid = db.prepare(`SELECT id FROM items WHERE budget_id = ? AND uid = ''`).all(budgetId);
    if (sinUid.length) {
        const poner = db.prepare('UPDATE items SET uid = ? WHERE id = ?');
        db.transaction(() => sinUid.forEach(r => poner.run(nuevoUid(), r.id)))();
    }
    const hay = db.prepare('SELECT 1 FROM budget_history WHERE budget_id = ? LIMIT 1').get(budgetId);
    if (!hay) {
        const items = db.prepare('SELECT * FROM items WHERE budget_id = ? ORDER BY position, id').all(budgetId);
        if (items.length) registrarVersion(budgetId, items, 'inicio');
    }
}

/** Las últimas versiones, de la más vieja a la más nueva. */
export function versiones(budgetId, cuantas = 40) {
    asegurarEsquema();
    return db.prepare('SELECT ms, origen, items_json FROM budget_history WHERE budget_id = ? ORDER BY id DESC LIMIT ?')
        .all(budgetId, cuantas)
        .reverse()
        .map(v => ({ ms: v.ms, origen: v.origen, items: JSON.parse(v.items_json) }));
}

// ---------------------------------------------------------------------------
// Lo que ve la IA
// ---------------------------------------------------------------------------
const CAMPOS = ['name', 'quantity', 'unit', 'unit_price', 'detail'];

export function haceCuanto(ms, ahora = Date.now()) {
    const s = Math.max(0, Math.round((ahora - ms) / 1000));
    if (s < 60) return 'recién';
    const m = Math.round(s / 60);
    if (m < 60) return `hace ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `hace ${h} h`;
    return `hace ${Math.round(h / 24)} días`;
}

/**
 * Qué cambió de una lista a otra, item por item (por uid).
 *
 * Los tipos son 'modificado', 'agregado' y 'borrado' y no 'cambio'/'alta'/
 * 'baja': probado, ante "deshacé el último cambio" la IA buscaba el último de
 * tipo "cambio" y se salteaba un borrado más reciente.
 */
export function cambiosEntre(antes, despues) {
    const previos = new Map(antes.filter(i => i.uid).map(i => [i.uid, i]));
    const actuales = new Map(despues.filter(i => i.uid).map(i => [i.uid, i]));
    const out = [];
    for (const it of despues) {
        if (!it.uid) continue;
        const prev = previos.get(it.uid);
        if (!prev) { out.push({ tipo: 'agregado', uid: it.uid, item: it.name, valores: soloValores(it) }); continue; }
        const campos = {};
        for (const c of CAMPOS) if (prev[c] !== it[c]) campos[c] = { antes: prev[c], despues: it[c] };
        if (Object.keys(campos).length) out.push({ tipo: 'modificado', uid: it.uid, item: it.name, campos });
    }
    for (const prev of antes) {
        if (prev.uid && !actuales.has(prev.uid)) out.push({ tipo: 'borrado', uid: prev.uid, item: prev.name, valores: soloValores(prev) });
    }
    return out;
}

function soloValores(i) {
    return { name: i.name, quantity: i.quantity, unit: i.unit, unit_price: i.unit_price, ...(i.detail ? { detail: i.detail } : {}) };
}

/**
 * El resumen que va en el prompt.
 *
 * @param {Array} lista       versiones (de versiones()), de la más vieja a la más nueva
 * @param {Array} actuales    los items como están en pantalla, con uid
 * @returns {{ultimos_cambios, anteriores, borrados}|null}  null si no hay nada que contar
 */
export function contextoHistorial(lista, actuales, ahora = Date.now()) {
    if (!Array.isArray(lista) || !lista.length) return null;
    const numDe = new Map(actuales.filter(i => i.uid).map((i, k) => [i.uid, k + 1]));
    const conNum = (c) => (numDe.has(c.uid) ? { num: numDe.get(c.uid), ...c } : c);
    const sinUid = ({ uid, ...resto }) => resto;

    // Los pasos, incluyendo el último: de la versión guardada a lo que hay ahora.
    const pasos = [];
    const estados = [...lista, { ms: ahora, origen: 'pantalla', items: actuales }];
    for (let k = 1; k < estados.length; k++) {
        const cambios = cambiosEntre(estados[k - 1].items, estados[k].items);
        if (cambios.length) pasos.push({ ms: estados[k].ms, origen: estados[k].origen, cambios });
    }
    const ultimos_cambios = pasos.slice(-6).reverse().map((p, k) => ({
        orden: k === 0 ? 'el más reciente' : `${k + 1}º más reciente`,
        hace: haceCuanto(p.ms, ahora),
        origen: p.origen,
        cambios: p.cambios.slice(0, 12).map(c => sinUid(conNum(c))),
    }));

    // Valores anteriores de cada item que está ahora en la lista.
    const anteriores = [];
    for (const it of actuales) {
        if (!it.uid) continue;
        const vistos = [];
        const clave = (v) => CAMPOS.map(c => v[c]).join('|');
        const actual = clave(it);
        for (let k = lista.length - 1; k >= 0 && vistos.length < 4; k--) {
            const v = lista[k].items.find(x => x.uid === it.uid);
            if (!v) continue;
            const c = clave(v);
            if (c === actual || vistos.some(x => x.c === c)) continue;
            vistos.push({ c, valores: { hace: haceCuanto(lista[k].ms, ahora), ...soloValores(v) } });
        }
        if (vistos.length) anteriores.push({ num: numDe.get(it.uid), item: it.name, valores_anteriores: vistos.map(x => x.valores) });
    }

    // Lo que se borró: la última vez que se lo vio.
    const borrados = [];
    const yaVisto = new Set(actuales.map(i => i.uid));
    for (let k = lista.length - 1; k >= 0 && borrados.length < 8; k--) {
        for (const v of lista[k].items) {
            if (!v.uid || yaVisto.has(v.uid)) continue;
            yaVisto.add(v.uid);
            borrados.push({ visto: haceCuanto(lista[k].ms, ahora), ...soloValores(v) });
        }
    }

    if (!ultimos_cambios.length && !anteriores.length && !borrados.length) return null;
    return { ultimos_cambios, anteriores, borrados };
}

/** Lo mismo, listo para pegar en un prompt ('' si no hay historial). */
export function historialPromptBlock(budgetId, actuales) {
    if (!Number.isInteger(budgetId) || budgetId <= 0) return '';
    try {
        const ctx = contextoHistorial(versiones(budgetId), foto(actuales));
        if (!ctx) return '';
        return `\n\nHISTORIAL DE CAMBIOS DE ESTE PRESUPUESTO (para deshacer o volver a un valor anterior):\n${JSON.stringify(ctx).slice(0, 6000)}`;
    } catch (err) {
        console.warn('[historial]', err.message);
        return '';
    }
}

export const REGLAS_DESHACER = `
DESHACER Y VOLVER ATRÁS (usando el HISTORIAL DE CAMBIOS que te paso):
- Si pide deshacer, volver atrás, "dejalo como estaba", "volvé al precio anterior", "el item 3 como antes" o recuperar algo que se borró, armá las ops con los valores ANTERIORES sacados del historial:
  · tipo "modificado" → {"action":"update","num":N, ...los campos con el valor "antes"}
  · tipo "borrado" → {"action":"add","item":{...los valores que tenía}}
  · tipo "agregado" (se agregó por error) → {"action":"remove","num":N}
- "Volvé al cambio anterior" / "deshacé lo último" sin decir cuál: revertí el PRIMER paso de "ultimos_cambios" (orden "el más reciente"), sea del tipo que sea —modificado, agregado o borrado—, y todo lo que tocó ese paso. "Cambio" en lo que dice él es cualquier paso, no solo los modificados.
- Si nombra un item, buscalo en "anteriores" y usá su valor anterior más reciente; si dice "el de antes de eso", el siguiente.
- NUNCA contestes que no sabés a qué se refiere si hay historial: elegí lo más reciente que encaje y decí en "pensamiento" qué vas a restaurar y a qué valores.
- Si no hay historial o no hay nada que encaje, decíselo corto.`;
