// Validación de las operaciones que propone la IA sobre un presupuesto.
//
// Todo lo que un modelo quiera cambiar pasa por acá antes de llegar a la pantalla
// de confirmación: comandos de voz o texto, la lectura de una hoja de cambios y,
// más adelante, el chat. Lo que no se reconoce se descarta — la red de seguridad
// es esta validación, no el prompt.
//
// Las cuatro operaciones:
//   add     → { action:'add', item:{...} }
//   update  → { action:'update', num, ...campos que cambian }
//   remove  → { action:'remove', num }
//   convert → { action:'convert', target_unit, num | nums:[...] | all:true, medidas }
//
// convert es la única que se expande: puede tocar varios items de una, y siempre
// termina traducida a operaciones 'update' con la cuenta ya hecha por units.js.

import { conversionPlan, convertItem, canonicalLabel, DEFAULT_UNITS } from './units.js';
import { aVenta, DEFAULTS as MARKUP_DEFAULTS } from './markup.js';

const clampMoney = (n) => Math.round((Number(n) || 0) * 100) / 100;

function normalizeItem(raw, catalog, markup) {
    // Cuando la IA estima un precio, lo que estima es el costo directo: material
    // más mano de obra. El precio de venta sale de aplicarle el coeficiente de la
    // empresa (gastos generales, utilidad, impuestos), y esa cuenta la hace acá,
    // no el modelo. Los precios que vienen del tarifario ya son de venta y pasan
    // sin tocar.
    const precio = Number(raw?.unit_price) || 0;
    const esCosto = raw?.es_costo_directo === true || raw?.costo_directo === true;

    return {
        name:       String(raw?.name || '').slice(0, 200) || 'Item',
        detail:     String(raw?.detail || '').slice(0, 1000),
        quantity:   Number(raw?.quantity) || 1,
        unit:       canonicalLabel(raw?.unit || 'un.', catalog),
        unit_price: esCosto ? aVenta(precio, markup || MARKUP_DEFAULTS) : clampMoney(precio),
        // Se guarda para poder mostrarle de dónde salió el número.
        ...(esCosto ? { _costo_directo: clampMoney(precio) } : {}),
    };
}

/**
 * Qué items apunta una operación de conversión: uno suelto, una lista, o todos.
 * Devuelve índices 1-based ya filtrados contra el largo real del presupuesto.
 */
function targetNumbers(op, itemCount) {
    if (op.all === true) {
        return Array.from({ length: itemCount }, (_, i) => i + 1);
    }
    const raw = Array.isArray(op.nums) ? op.nums : [op.num];
    const valid = raw.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= itemCount);
    return [...new Set(valid)];
}

/**
 * Convierte uno o varios items a otra unidad. La IA solo aporta la unidad destino
 * y las medidas que leyó; la aritmética la hace units.js.
 *
 * Devuelve { ops, warnings }: los items que no se pueden convertir no se tocan y
 * salen listados en warnings, nunca se les inventa una medida.
 */
function resolveConvert(op, items, catalog) {
    const target = String(op.target_unit || op.unit || '').trim();
    const ops = [];
    const warnings = [];

    if (!target) return { ops, warnings: ['No quedó claro a qué unidad convertir.'] };

    const measures = {
        ancho: Number(op.ancho) || 0,
        alto:  Number(op.alto) || Number(op.espesor) || 0,
        largo: Number(op.largo) || 0,
    };
    const geometry = {
        pieces: Number(op.pieces) || 0,
        largo:  measures.largo,
        ancho:  measures.ancho,
        alto:   measures.alto,
    };

    for (const num of targetNumbers(op, items.length)) {
        const item = items[num - 1];
        const etiqueta = `item ${num}${item?.name ? ` (${item.name})` : ''}`;

        // Camino A: convertir la cantidad que ya tiene, con una o dos medidas.
        let result = convertItem(item, target, { measures, catalog });

        // Camino B: si las unidades no son compatibles (típico "un." → m³), se
        // intenta con la geometría de la pieza, si la IA la encontró.
        if (!result.ok && geometry.pieces > 0) {
            const porGeometria = convertItem(item, target, { geometry, catalog });
            if (porGeometria.ok) result = porGeometria;
        }

        if (!result.ok) {
            warnings.push(`No se pudo convertir el ${etiqueta}: ${result.reason}`);
            continue;
        }
        ops.push({ action: 'update', num, fields: result.fields, convert: {
            from: item.unit,
            to: result.fields.unit,
            total: result.total,
            newTotal: result.newTotal,
        } });
    }

    return { ops, warnings };
}

/**
 * Valida una operación cruda de la IA. Devuelve { ops, warnings } porque una sola
 * operación de conversión puede expandirse en varias.
 */
export function normalizeOp(rawOp, items, catalog = DEFAULT_UNITS, markup = MARKUP_DEFAULTS) {
    const action = String(rawOp?.action || '').toLowerCase();
    const itemCount = items.length;

    if (action === 'add') {
        return { ops: [{ action: 'add', item: normalizeItem(rawOp.item, catalog, markup) }], warnings: [] };
    }

    if (action === 'convert') {
        return resolveConvert(rawOp, items, catalog);
    }

    if (action === 'update') {
        const num = Number(rawOp.num);
        if (!Number.isInteger(num) || num < 1 || num > itemCount) return { ops: [], warnings: [] };

        // Importante: solo se tocan los campos que vinieron. Un pedido de cambiar
        // el precio no tiene que borrar el nombre.
        const fields = {};
        if (rawOp.name       !== undefined) fields.name       = String(rawOp.name).slice(0, 200);
        if (rawOp.detail     !== undefined) fields.detail     = String(rawOp.detail).slice(0, 1000);
        if (rawOp.quantity   !== undefined) fields.quantity   = Number(rawOp.quantity) || 0;
        if (rawOp.unit       !== undefined) fields.unit       = canonicalLabel(rawOp.unit, catalog);
        if (rawOp.unit_price !== undefined) fields.unit_price = clampMoney(rawOp.unit_price);

        if (!Object.keys(fields).length) return { ops: [], warnings: [] };
        return { ops: [{ action: 'update', num, fields }], warnings: [] };
    }

    if (action === 'remove') {
        const num = Number(rawOp.num);
        if (!Number.isInteger(num) || num < 1 || num > itemCount) return { ops: [], warnings: [] };
        return { ops: [{ action: 'remove', num }], warnings: [] };
    }

    return { ops: [], warnings: [] };
}

/**
 * Valida una tanda completa de operaciones.
 * `maxOps` acota lo que puede pedir un solo mensaje; convertir todo un presupuesto
 * grande es legítimo, así que el tope es generoso.
 */
export function normalizeOps(rawOps, items, catalog = DEFAULT_UNITS, maxOps = 200, markup = MARKUP_DEFAULTS) {
    const source = Array.isArray(rawOps) ? rawOps.slice(0, 60) : [];
    const ops = [];
    const warnings = [];

    for (const rawOp of source) {
        const result = normalizeOp(rawOp, items, catalog, markup);
        ops.push(...result.ops);
        warnings.push(...result.warnings);
        if (ops.length >= maxOps) break;
    }

    return { ops: ops.slice(0, maxOps), warnings };
}

/**
 * Aplica las operaciones ya validadas sobre una copia de los items.
 * El orden importa y es el mismo que usa el frontend: primero editar (los índices
 * siguen intactos), después borrar de mayor a menor, y recién al final agregar.
 */
export function applyOps(items, ops) {
    const out = items.map(i => ({ ...i }));

    ops.filter(o => o.action === 'update').forEach(op => {
        if (out[op.num - 1]) Object.assign(out[op.num - 1], op.fields);
    });
    ops.filter(o => o.action === 'remove')
        .map(o => o.num)
        .sort((a, b) => b - a)
        .forEach(num => out.splice(num - 1, 1));
    ops.filter(o => o.action === 'add').forEach(op => out.push({ ...op.item }));

    return out;
}
