// Simulaciones sobre un presupuesto: "¿cuánto me daría si…?"
//
// Es la capacidad nueva más importante del chat. La diferencia con una operación
// normal es que acá NO se toca nada: se calculan los números y se muestran para
// que él decida. Recién si dice que sí, se convierte en cambios de verdad.
//
// Igual que en todo el resto del proyecto: la IA dice QUÉ simular, la aritmética
// la hace este módulo. Un modelo calculando descuentos sobre plata real es
// exactamente la clase de error que después se factura mal.

import { convertItem } from './units.js';

const money = (n) => Math.round((Number(n) || 0) * 100) / 100;
const qty   = (n) => Math.round((Number(n) || 0) * 1e6) / 1e6;

const totalDe = (items) =>
    money(items.reduce((s, i) => s + (Number(i.quantity) || 0) * (Number(i.unit_price) || 0), 0));

/** Índices 1-based válidos que apunta la simulación: uno, varios o todos. */
function objetivos(spec, cantidad) {
    if (spec.all === true || (!spec.num && !Array.isArray(spec.nums))) {
        return Array.from({ length: cantidad }, (_, i) => i + 1);
    }
    const crudos = Array.isArray(spec.nums) ? spec.nums : [spec.num];
    return [...new Set(crudos.map(Number).filter(n => Number.isInteger(n) && n >= 1 && n <= cantidad))];
}

/**
 * Corre una simulación y devuelve el antes y el después, sin modificar nada.
 *
 * Tipos soportados:
 *   discount    → bajar (o subir) un porcentaje: { pct: 10, num|nums|all }
 *   set_price   → poner un precio unitario: { num, unit_price }
 *   set_qty     → cambiar la cantidad: { num, quantity }
 *   remove      → sacar items: { num|nums }
 *   add         → agregar un item hipotético: { item: {...} }
 *   convert     → pasar a otra unidad: { num|nums|all, target_unit, alto|ancho|largo }
 *   round_total → redondear el total final a un número lindo: { to: 500000 }
 *
 * @returns {{ ok: true, before, after, delta, lines[], label }} | { ok:false, reason }
 */
export function simulate(items, spec, catalog) {
    const base = (Array.isArray(items) ? items : []).map(i => ({ ...i }));
    if (!base.length) return { ok: false, reason: 'El presupuesto no tiene items para simular.' };

    const tipo = String(spec?.type || '').toLowerCase();
    const before = totalDe(base);
    let after = base.map(i => ({ ...i }));
    const lines = [];
    let label = '';

    switch (tipo) {
        case 'discount': {
            const pct = Number(spec.pct);
            if (!Number.isFinite(pct) || pct === 0) return { ok: false, reason: 'No entendí de cuánto es el ajuste.' };
            const nums = objetivos(spec, base.length);
            const factor = 1 - pct / 100;
            if (factor < 0) return { ok: false, reason: 'Un descuento mayor al 100% no tiene sentido.' };
            for (const n of nums) {
                const it = after[n - 1];
                const antes = money(it.quantity * it.unit_price);
                it.unit_price = money(it.unit_price * factor);
                lines.push(linea(n, it, antes));
            }
            label = pct > 0
                ? `Bajando un ${pct}%${nums.length === base.length ? ' a todo' : ` a ${nums.length} item(s)`}`
                : `Subiendo un ${Math.abs(pct)}%${nums.length === base.length ? ' a todo' : ` a ${nums.length} item(s)`}`;
            break;
        }

        case 'set_price': {
            const n = Number(spec.num);
            if (!after[n - 1]) return { ok: false, reason: 'No encontré ese item.' };
            const precio = Number(spec.unit_price);
            if (!Number.isFinite(precio) || precio < 0) return { ok: false, reason: 'Ese precio no es un número válido.' };
            const it = after[n - 1];
            const antes = money(it.quantity * it.unit_price);
            it.unit_price = money(precio);
            lines.push(linea(n, it, antes));
            label = `Poniendo el item ${n} a $${money(precio).toLocaleString('es-AR')}`;
            break;
        }

        case 'set_qty': {
            const n = Number(spec.num);
            if (!after[n - 1]) return { ok: false, reason: 'No encontré ese item.' };
            const cant = Number(spec.quantity);
            if (!Number.isFinite(cant) || cant < 0) return { ok: false, reason: 'Esa cantidad no es un número válido.' };
            const it = after[n - 1];
            const antes = money(it.quantity * it.unit_price);
            it.quantity = qty(cant);
            lines.push(linea(n, it, antes));
            label = `Poniendo el item ${n} en ${qty(cant)} ${it.unit}`;
            break;
        }

        case 'remove': {
            const nums = objetivos(spec, base.length);
            if (!nums.length) return { ok: false, reason: 'No me quedó claro qué item sacar.' };
            for (const n of nums) {
                const it = after[n - 1];
                lines.push({ num: n, name: it.name, detalle: 'se saca', antes: money(it.quantity * it.unit_price), despues: 0 });
            }
            after = after.filter((_, i) => !nums.includes(i + 1));
            label = `Sacando ${nums.length} item(s)`;
            break;
        }

        case 'add': {
            const it = spec.item || {};
            const nuevo = {
                name: String(it.name || 'Item nuevo').slice(0, 200),
                quantity: Number(it.quantity) || 1,
                unit: String(it.unit || 'un.'),
                unit_price: money(it.unit_price),
            };
            after.push(nuevo);
            lines.push({
                num: after.length, name: nuevo.name,
                detalle: `${nuevo.quantity} ${nuevo.unit} × $${nuevo.unit_price.toLocaleString('es-AR')}`,
                antes: 0, despues: money(nuevo.quantity * nuevo.unit_price),
            });
            label = `Agregando "${nuevo.name}"`;
            break;
        }

        case 'convert': {
            const destino = String(spec.target_unit || '').trim();
            if (!destino) return { ok: false, reason: 'No me quedó claro a qué unidad convertir.' };
            const medidas = {
                largo: Number(spec.largo) || 0,
                ancho: Number(spec.ancho) || 0,
                alto:  Number(spec.alto) || Number(spec.espesor) || 0,
            };
            const nums = objetivos(spec, base.length);
            const fallos = [];
            for (const n of nums) {
                const it = after[n - 1];
                const antes = money(it.quantity * it.unit_price);
                const r = convertItem(it, destino, { measures: medidas, catalog });
                if (!r.ok) { fallos.push(`item ${n}: ${r.reason}`); continue; }
                Object.assign(it, r.fields);
                lines.push(linea(n, it, antes));
            }
            if (!lines.length) return { ok: false, reason: fallos[0] || 'No se pudo convertir ningún item.' };
            label = `Pasando a ${destino}`;
            if (fallos.length) label += ` (${fallos.length} item(s) no se pueden convertir)`;
            break;
        }

        // Redondear el total es una cuenta que se hace seguido a mano: cuánto hay
        // que tocar cada item para que el total quede en un número redondo.
        case 'round_total': {
            const objetivo = Number(spec.to);
            if (!Number.isFinite(objetivo) || objetivo <= 0) return { ok: false, reason: 'No entendí a qué número redondear.' };
            if (!before) return { ok: false, reason: 'El presupuesto está en cero, no hay nada que redondear.' };
            const factor = objetivo / before;
            for (let n = 1; n <= after.length; n++) {
                const it = after[n - 1];
                const antes = money(it.quantity * it.unit_price);
                it.unit_price = money(it.unit_price * factor);
                lines.push(linea(n, it, antes));
            }
            label = `Llevando el total a $${money(objetivo).toLocaleString('es-AR')}`;
            break;
        }

        default:
            // "unknownType" distingue "pidió simular algo imposible" (hay que
            // avisarle) de "el modelo mandó un simulate que no venía al caso"
            // (pasa cuando la pregunta era de otra cosa; se descarta en silencio).
            return { ok: false, unknownType: true, reason: 'No entendí qué querés simular.' };
    }

    const despues = totalDe(after);
    return {
        ok: true,
        label,
        before,
        after: despues,
        delta: money(despues - before),
        // Se acotan las líneas: en un presupuesto de 80 items el detalle completo
        // no se lee, y lo que importa es el total.
        lines: lines.slice(0, 8),
        truncated: Math.max(0, lines.length - 8),
        items: after,
    };
}

function linea(num, it, antes) {
    return {
        num,
        name: it.name,
        detalle: `${qty(it.quantity)} ${it.unit} × $${money(it.unit_price).toLocaleString('es-AR')}`,
        antes,
        despues: money(it.quantity * it.unit_price),
    };
}

/**
 * Traduce una simulación aceptada a operaciones de las que ya entiende el resto
 * del sistema, para aplicarla por el mismo camino que todo lo demás.
 */
export function simulationToOps(items, resultado) {
    if (!resultado?.ok) return [];
    const ops = [];
    const originales = items.length;

    // Los items que sobreviven y cambiaron → update; los que faltan → remove;
    // los que aparecieron al final → add.
    const finales = resultado.items;
    for (let i = 0; i < Math.min(originales, finales.length); i++) {
        const a = items[i], b = finales[i];
        if (!b) continue;
        const fields = {};
        if (qty(a.quantity)    !== qty(b.quantity))    fields.quantity   = qty(b.quantity);
        if (String(a.unit)     !== String(b.unit))     fields.unit       = b.unit;
        if (money(a.unit_price) !== money(b.unit_price)) fields.unit_price = money(b.unit_price);
        if (Object.keys(fields).length) ops.push({ action: 'update', num: i + 1, fields });
    }
    if (finales.length < originales) {
        // Se sacaron items: se identifican por diferencia de nombres.
        const nombresFinales = finales.map(f => f.name);
        for (let i = originales - 1; i >= 0; i--) {
            const idx = nombresFinales.indexOf(items[i].name);
            if (idx === -1) ops.push({ action: 'remove', num: i + 1 });
            else nombresFinales.splice(idx, 1);
        }
    }
    for (let i = originales; i < finales.length; i++) {
        ops.push({ action: 'add', item: finales[i] });
    }
    return ops;
}
