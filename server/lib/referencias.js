// ¿Habló de ese item? Red de seguridad de la conversación por voz.
//
// Dictando una planilla de corrido pasó esto: "limpieza periódica y final,
// global, uno, 650 mil" llegó partido, y el precio terminó en los cordones,
// un item que él no nombró. Por voz no lo ve hasta mucho después: dicta con
// la vista en el papel. El prompt ya pide no hacerlo, pero la regla de oro es
// que lo que importa no se le deja al modelo.
//
// Así que un cambio o una baja sobre un item existente pasa solo si hay algo
// que lo ate a lo que dijo: el nombre del item (o una palabra suya) en lo que
// dictó o en lo último que se habló, su número ("el item 3"), "el último", o
// "todos". Si no, no se toca y se le pregunta a cuál iba.

const NUMEROS = ['cero', 'uno', 'dos', 'tres', 'cuatro', 'cinco', 'seis', 'siete', 'ocho', 'nueve', 'diez',
    'once', 'doce', 'trece', 'catorce', 'quince', 'dieciseis', 'diecisiete', 'dieciocho', 'diecinueve', 'veinte'];

// Palabras que no identifican a ningún item.
const VACIAS = new Set(['para', 'como', 'item', 'items', 'todo', 'toda', 'todos', 'todas', 'esta', 'este', 'esto',
    'otro', 'otra', 'cada', 'unidad', 'global', 'metro', 'metros', 'cuadrado', 'cuadrados', 'cubico', 'cubicos',
    'lineal', 'lineales', 'precio', 'cantidad', 'total', 'final', 'trabajo', 'trabajos', 'obra', 'general',
    'material', 'materiales', 'mano', 'tipo', 'sobre', 'entre', 'desde', 'hasta', 'segun', 'incluye']);

function palabras(texto) {
    return String(texto || '').toLowerCase()
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .split(/[^a-z0-9ñ]+/)
        .filter(p => p.length >= 4 && !VACIAS.has(p) && !/^\d+$/.test(p));
}

// "cordón"/"cordones", "piso"/"contrapiso", "revoque"/"revoques".
function seParecen(a, b) {
    if (a === b) return true;
    const corta = a.length <= b.length ? a : b;
    const larga = corta === a ? b : a;
    if (larga.includes(corta)) return true;
    const n = Math.min(5, corta.length);
    return a.slice(0, n) === b.slice(0, n);
}

function nombraAlItem(item, dichas) {
    const delItem = palabras(`${item?.name || ''} ${item?.detail || ''}`);
    return delItem.some(p => dichas.some(d => seParecen(p, d)));
}

function nombraElNumero(num, texto) {
    const formas = [String(num), NUMEROS[num]].filter(Boolean).join('|');
    return new RegExp(`\\b(item|ítem|numero|número|renglon|renglón|fila|linea|línea)\\s+(${formas})\\b`, 'i').test(texto);
}

/**
 * Separa las ops que tocan un item que él no nombró.
 *
 * `ops` ya validadas (normalizeOps), `items` la lista sobre la que se pensó,
 * `pedidos` lo que dictó en este turno y `recientes` lo último que se habló.
 * Las altas y las conversiones no se revisan: las primeras no apuntan a nada
 * existente y las segundas se piden para varios a la vez ("pasá todo a m³").
 *
 * Lo último que se habló cuenta solo si en este turno no se cargó nada nuevo:
 * "ponele 650 mil" después de cargar la limpieza en $0 va a la limpieza. Pero
 * si el turno trae un item nuevo, los datos sueltos son de ese item y no del
 * que se dictó antes: justamente el caso de la limpieza y los cordones, que
 * venían uno detrás del otro en la planilla.
 *
 * Devuelve { ops, dudosos } con los nombres de los items que no se tocaron.
 */
export function separarSinReferencia(ops, items, { pedidos = [], recientes = [] } = {}) {
    const lista = Array.isArray(ops) ? ops : [];
    const texto = [].concat(pedidos).filter(Boolean).join(' ');
    const sinTildes = texto.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const hayAltas = lista.some(op => op.action === 'add');
    const dichas = palabras(texto);
    const antes = hayAltas ? [] : palabras([].concat(recientes).filter(Boolean).join(' '));
    const todos = /\b(todos|todas|todo el presupuesto|cada uno|cada item)\b/.test(sinTildes);
    const ultimo = /\b(ultim[oa]s?|anterior|penultim[oa])\b/.test(sinTildes);

    const quedan = [];
    const dudosos = [];
    for (const op of lista) {
        const tocaExistente = (op.action === 'update' && !op.convert) || op.action === 'remove';
        if (!tocaExistente || todos) { quedan.push(op); continue; }

        const item = items[op.num - 1];
        const ok = !item
            || nombraAlItem(item, dichas)
            || nombraAlItem(item, antes)
            || nombraElNumero(op.num, sinTildes)
            || (ultimo && op.num >= items.length - 1);
        if (ok) quedan.push(op);
        else dudosos.push(String(item.name || `item ${op.num}`));
    }
    return { ops: quedan, dudosos: [...new Set(dudosos)] };
}
