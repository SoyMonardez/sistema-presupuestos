// Catálogo de unidades y motor de conversión.
//
// Regla de oro del proyecto: la IA extrae medidas, este módulo hace las cuentas.
// Ningún modelo calcula cantidades ni precios — solo dice qué números leyó en el
// texto, en la foto o en el archivo. Acá se hace la aritmética, exacta.
//
// La conversión SIEMPRE preserva el total del item: se recalculan cantidad y
// precio unitario para que el trabajo siga costando lo mismo, expresado en otra
// unidad. Lo que cambia para el cliente es la presentación, no la plata.
// (Mismo criterio que el conversor manual que ya usaba el usuario.)

// ---------------------------------------------------------------------------
// Familias de unidades
// ---------------------------------------------------------------------------
// Dos unidades se pueden convertir entre sí de dos maneras:
//
//   1. Por escala, dentro de la misma familia (litros ↔ m³). Es exacta y no
//      necesita ningún dato extra.
//   2. Por dimensión, subiendo o bajando la escalera largo → área → volumen
//      (m² → m³). Necesita UNA medida por escalón: el ancho o el espesor.
//
// Cualquier otro par (horas → m², kg → m³) NO se puede convertir sin inventar
// un factor, así que se rechaza. Este es justo el lugar donde un modelo sin
// frenos hace desastres, por eso la decisión vive acá y no en un prompt.

export const KIND = {
    LENGTH: 'length',
    AREA:   'area',
    VOLUME: 'volume',
    COUNT:  'count',
    WEIGHT: 'weight',
    TIME:   'time',
    OTHER:  'other',
};

// Escalera dimensional. El número es cuántas dimensiones de largo tiene la unidad.
const LADDER = { [KIND.LENGTH]: 1, [KIND.AREA]: 2, [KIND.VOLUME]: 3 };

// Qué medida hace falta para subir a cada escalón.
const STEP_MEASURE = { 2: 'ancho', 3: 'alto' };

// Etiqueta amigable de cada medida, para pedírsela al usuario.
export const MEASURE_LABEL = {
    largo: 'Largo (m)',
    ancho: 'Ancho (m)',
    alto:  'Alto o espesor (m)',
};

// ---------------------------------------------------------------------------
// Catálogo por defecto
// ---------------------------------------------------------------------------
// `code`   → clave interna, nunca se muestra.
// `label`  → lo que se ve en pantalla y se imprime en el PDF. Es lo que se
//            guarda en items.unit (así los presupuestos viejos siguen andando).
// `kind`   → familia.
// `factor` → cuánto vale en la unidad base de su familia (m, m², m³, kg).
//            null = no se puede convertir por escala. Ej: un "día" de trabajo no
//            son 8 horas fijas, así que no le ponemos factor y listo.
// `dims`   → medidas necesarias para derivar la cantidad desde piezas sueltas
//            (el camino de geometría completa: 12 plateas de 1.10 × 2 × 0.15).

export const DEFAULT_UNITS = [
    { code: 'ml',     label: 'm',      kind: KIND.LENGTH, factor: 1,     dims: ['largo'] },
    { code: 'm2',     label: 'm²',     kind: KIND.AREA,   factor: 1,     dims: ['largo', 'ancho'] },
    { code: 'm3',     label: 'm³',     kind: KIND.VOLUME, factor: 1,     dims: ['largo', 'ancho', 'alto'] },
    { code: 'un',     label: 'un.',    kind: KIND.COUNT,  factor: null,  dims: [] },
    { code: 'kg',     label: 'kg',     kind: KIND.WEIGHT, factor: 1,     dims: [] },
    { code: 'tn',     label: 'tn',     kind: KIND.WEIGHT, factor: 1000,  dims: [] },
    { code: 'lt',     label: 'lt',     kind: KIND.VOLUME, factor: 0.001, dims: [] },
    { code: 'hs',     label: 'hs',     kind: KIND.TIME,   factor: null,  dims: [] },
    { code: 'dia',    label: 'día',    kind: KIND.TIME,   factor: null,  dims: [] },
    { code: 'saco',   label: 'saco',   kind: KIND.COUNT,  factor: null,  dims: [] },
    { code: 'global', label: 'global', kind: KIND.OTHER,  factor: null,  dims: [] },
];

// ---------------------------------------------------------------------------
// Normalización de lo que ya está escrito a mano
// ---------------------------------------------------------------------------
// Hasta ahora la unidad era un campo de texto libre, así que en la base conviven
// "m2", "M²", "mts2" y "metros cuadrados". Todo eso tiene que caer en la misma
// unidad o ninguna conversión es confiable.

// NFKD nos regala parte del trabajo: "m²" se descompone a "m2" y "día" a "dia".
function norm(raw) {
    return String(raw ?? '')
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')   // saca tildes sueltas
        .toLowerCase()
        .replace(/[^a-z0-9]/g, '');
}

// Variantes que vimos o que son razonables de tipear. La clave ya está normalizada.
const ALIASES = {
    ml:     ['m', 'ml', 'mt', 'mts', 'metro', 'metros', 'metrolineal', 'metroslineales', 'lineal'],
    m2:     ['m2', 'mt2', 'mts2', 'metro2', 'metros2', 'metrocuadrado', 'metroscuadrados', 'mtscuadrados'],
    m3:     ['m3', 'mt3', 'mts3', 'metro3', 'metros3', 'metrocubico', 'metroscubicos', 'mtscubicos'],
    un:     ['un', 'u', 'uni', 'unid', 'unidad', 'unidades', 'cu', 'pza', 'pzas', 'pieza', 'piezas'],
    kg:     ['kg', 'kgs', 'k', 'kilo', 'kilos', 'kilogramo', 'kilogramos'],
    tn:     ['tn', 't', 'ton', 'tons', 'tonelada', 'toneladas'],
    lt:     ['lt', 'l', 'lts', 'litro', 'litros'],
    hs:     ['hs', 'h', 'hr', 'hrs', 'hora', 'horas'],
    dia:    ['dia', 'dias', 'jornada', 'jornadas'],
    saco:   ['saco', 'sacos', 'bolsa', 'bolsas'],
    global: ['global', 'glob', 'gl', 'sumaglobal', 'porelglobal'],
};

const ALIAS_TO_CODE = (() => {
    const map = new Map();
    for (const [code, variants] of Object.entries(ALIASES)) {
        for (const v of variants) map.set(v, code);
    }
    return map;
})();

/**
 * Busca una unidad del catálogo a partir de cualquier cosa que haya escrito
 * el usuario o devuelto la IA. Devuelve la entrada del catálogo o null.
 */
export function findUnit(raw, catalog = DEFAULT_UNITS) {
    const key = norm(raw);
    if (!key) return null;

    // 1. ¿Coincide con el code o el label de alguna unidad del catálogo?
    //    Esto es lo que hace que las unidades propias del usuario funcionen.
    const direct = catalog.find(u => norm(u.code) === key || norm(u.label) === key);
    if (direct) return direct;

    // 2. ¿Es una variante conocida de una unidad estándar?
    const code = ALIAS_TO_CODE.get(key);
    return code ? (catalog.find(u => u.code === code) || null) : null;
}

/**
 * Devuelve la etiqueta canónica para guardar en items.unit.
 * Si no reconoce la unidad la deja como vino (recortada): puede ser una unidad
 * propia que el usuario todavía no dio de alta, y no queremos perderle el dato.
 */
export function canonicalLabel(raw, catalog = DEFAULT_UNITS) {
    const unit = findUnit(raw, catalog);
    if (unit) return unit.label;
    const fallback = String(raw ?? '').trim().slice(0, 20);
    return fallback || 'un.';
}

// ---------------------------------------------------------------------------
// Plan de conversión
// ---------------------------------------------------------------------------

/**
 * Decide si dos unidades se pueden convertir y qué hace falta para hacerlo.
 *
 * Devuelve { ok: true, kind, needs, op } donde:
 *   kind  → 'identity' | 'scale' | 'dimensional'
 *   needs → medidas que hay que pedir ('ancho', 'alto'); vacío si no hace falta
 *   op    → 'multiply' | 'divide' | 'none' (cómo se aplican esas medidas)
 *
 * O { ok: false, reason } con un motivo en castellano listo para mostrar.
 */
export function conversionPlan(fromRaw, toRaw, catalog = DEFAULT_UNITS) {
    const from = findUnit(fromRaw, catalog);
    const to   = findUnit(toRaw, catalog);

    if (!from) return { ok: false, reason: `No conozco la unidad "${fromRaw}". Dala de alta en Precios base para poder convertirla.` };
    if (!to)   return { ok: false, reason: `No conozco la unidad "${toRaw}". Dala de alta en Precios base para poder convertirla.` };
    if (from.code === to.code) return { ok: true, kind: 'identity', needs: [], op: 'none', from, to };

    // Misma familia: alcanza con la escala, si ambas la tienen definida.
    if (from.kind === to.kind) {
        if (from.factor == null || to.factor == null) {
            return { ok: false, reason: `No hay una equivalencia fija entre ${from.label} y ${to.label}.` };
        }
        return { ok: true, kind: 'scale', needs: [], op: 'none', from, to };
    }

    // Distinta familia: solo sirve si ambas están en la escalera dimensional.
    const rankFrom = LADDER[from.kind];
    const rankTo   = LADDER[to.kind];
    if (!rankFrom || !rankTo || from.factor == null || to.factor == null) {
        return { ok: false, reason: `No se puede convertir ${from.label} a ${to.label}: no son medidas compatibles.` };
    }

    const lo = Math.min(rankFrom, rankTo);
    const hi = Math.max(rankFrom, rankTo);
    const needs = [];
    for (let step = lo + 1; step <= hi; step++) needs.push(STEP_MEASURE[step]);

    return {
        ok: true,
        kind: 'dimensional',
        needs,
        op: rankTo > rankFrom ? 'multiply' : 'divide',
        from,
        to,
    };
}

// ---------------------------------------------------------------------------
// Cálculo
// ---------------------------------------------------------------------------

const roundQty   = (n) => Math.round(n * 1e6) / 1e6;    // corta el ruido de coma flotante
const roundMoney = (n) => Math.round(n * 100) / 100;

/**
 * Camino A — el común: convierte una cantidad ya expresada en una unidad.
 * Para pasar 20 m² a m³ alcanza con el espesor: 20 × 0.15 = 3 m³.
 *
 * `measures` es un objeto { ancho, alto } en metros. Solo se leen las que el
 * plan haya pedido.
 */
export function convertQuantity(quantity, fromRaw, toRaw, measures = {}, catalog = DEFAULT_UNITS) {
    const plan = conversionPlan(fromRaw, toRaw, catalog);
    if (!plan.ok) return plan;

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
        return { ok: false, reason: 'La cantidad actual del item no es un número válido.' };
    }

    const missing = plan.needs.filter(m => !(Number(measures[m]) > 0));
    if (missing.length) {
        return {
            ok: false,
            reason: `Falta ${missing.map(m => MEASURE_LABEL[m].toLowerCase()).join(' y ')} para pasar de ${plan.from.label} a ${plan.to.label}.`,
            needs: missing,
        };
    }

    // Se pasa a la unidad base de la familia, se camina la escalera, y se vuelve
    // a la unidad destino. Así la escala y la dimensión se combinan sin casos especiales.
    let value = qty * plan.from.factor;
    for (const m of plan.needs) {
        const measure = Number(measures[m]);
        value = plan.op === 'multiply' ? value * measure : value / measure;
    }
    value = value / plan.to.factor;

    const result = roundQty(value);
    if (!Number.isFinite(result) || result <= 0) {
        return { ok: false, reason: 'La conversión da una cantidad inválida. Revisá las medidas.' };
    }
    return { ok: true, quantity: result, unit: plan.to.label, plan };
}

/**
 * Camino B — geometría completa: deriva la cantidad desde piezas sueltas y sus
 * medidas. Sirve cuando el item está en "un." y hay que expresarlo en m³
 * ("12 plateas de 1.10 × 2 × 0.15").
 */
export function quantityFromGeometry({ pieces = 1, largo = 0, ancho = 0, alto = 0 }, toRaw, catalog = DEFAULT_UNITS) {
    const to = findUnit(toRaw, catalog);
    if (!to) return { ok: false, reason: `No conozco la unidad "${toRaw}".` };

    const dims = { largo: Number(largo) || 0, ancho: Number(ancho) || 0, alto: Number(alto) || 0 };
    const n = Number(pieces) || 0;
    if (n <= 0) return { ok: false, reason: 'La cantidad de piezas tiene que ser mayor a cero.' };

    const missing = (to.dims || []).filter(d => !(dims[d] > 0));
    if (missing.length) {
        return {
            ok: false,
            reason: `Faltan medidas para calcular ${to.label}: ${missing.map(m => MEASURE_LABEL[m].toLowerCase()).join(', ')}.`,
            needs: missing,
        };
    }

    let qty = n;
    for (const d of (to.dims || [])) qty *= dims[d];

    const result = roundQty(qty);
    if (!Number.isFinite(result) || result <= 0) {
        return { ok: false, reason: 'Las medidas dan una cantidad inválida.' };
    }
    return { ok: true, quantity: result, unit: to.label };
}

/**
 * Convierte un item completo manteniendo su total.
 *
 * Acepta los dos caminos:
 *   - measures  → camino A (una o dos medidas sobre la cantidad actual)
 *   - geometry  → camino B ({ pieces, largo, ancho, alto })
 *
 * Devuelve los campos listos para aplicar como una op de tipo 'update'.
 */
export function convertItem(item, toRaw, { measures, geometry, catalog = DEFAULT_UNITS } = {}) {
    const quantity   = Number(item?.quantity) || 0;
    const unit_price = Number(item?.unit_price) || 0;
    const total = roundMoney(quantity * unit_price);

    const res = geometry
        ? quantityFromGeometry(geometry, toRaw, catalog)
        : convertQuantity(quantity, item?.unit, toRaw, measures || {}, catalog);

    if (!res.ok) return res;

    // El total manda: el precio unitario sale de dividirlo por la cantidad nueva.
    // Si el item todavía no tiene precio, la conversión igual vale (queda en 0).
    const newPrice = total > 0 ? roundMoney(total / res.quantity) : 0;

    // El precio unitario se redondea a centavos a propósito: el PDF lo imprime y
    // la cuenta tiene que cerrar contra ese número (un municipio la audita). Como
    // no todo total se divide exacto — $1.000.000 en 3 m³ da $333.333,33 — el
    // total puede moverse unos centavos. En vez de esconderlo devolvemos el total
    // resultante para que el panel de confirmación lo muestre tal cual va a quedar.
    const newTotal = roundMoney(res.quantity * newPrice);

    return {
        ok: true,
        fields: { quantity: res.quantity, unit: res.unit, unit_price: newPrice },
        total,
        newTotal,
        drift: roundMoney(newTotal - total),
    };
}
