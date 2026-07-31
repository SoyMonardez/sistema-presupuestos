// Revisión del presupuesto antes de mostrárselo.
//
// Por qué existe: ninguna IA se relee. Le pedís una pared y te devuelve tres
// items en m² a costo, sin mano de obra desglosada y con la cantidad redondeada,
// y lo dice con total seguridad. El presupuesto de $600.000 que no dejaba
// ganancia pasó porque NADIE lo miró después de que el modelo lo escribió.
//
// Esto lo mira. Es determinístico, no cuesta un token y agarra justo la clase de
// error que el modelo no ve solo, porque son errores de omisión: lo que falta no
// está en el texto que él generó.
//
// Los avisos NO bloquean nada: se le muestran junto a la propuesta y él decide.
// Un presupuesto raro puede ser correcto —a veces se cotiza solo material— y el
// que sabe es él, no nosotros.

const $ = (n) => '$' + Math.round(n).toLocaleString('es-AR');

// Cómo reconocer mano de obra y materiales por el nombre del item. Es heurística
// y está bien que lo sea: se usa solo para avisar, nunca para cambiar números.
const RE_MANO_OBRA = /\b(mano de obra|manodeobra|oficial|ayudante|alba[ñn]il|jornal|jornada|cuadrilla|colocaci[óo]n|instalaci[óo]n|montaje|ejecuci[óo]n|hora|hs)\b/i;
const RE_MATERIAL  = /\b(material|ladrillo|cemento|arena|cal|hormig[óo]n|hierro|malla|pintura|ceramic|membrana|caño|ca[ñn]o|chapa|madera|árido|arido|piedra|bolsa|saco)\b/i;

// Unidades que no son medida: no se les puede pedir que salgan de un cómputo.
const UNIDADES_SIN_MEDIDA = new Set(['un.', 'global', 'saco', 'hs', 'día', 'días']);

/**
 * Revisa cómo quedaría el presupuesto y devuelve avisos en castellano.
 *
 * @param {Array}  itemsFinales  el presupuesto ya con los cambios aplicados
 * @param {object} opts
 * @param {Array}  opts.propuestos  las ops que se están proponiendo
 * @param {Array}  opts.tarifario   [{name, unit, price}] para comparar magnitudes
 * @param {object} opts.markup      parámetros de la empresa
 * @returns {string[]} avisos, ya listos para mostrar
 */
export function revisarPresupuesto(itemsFinales, { propuestos = [], tarifario = [], markup = {} } = {}) {
    const avisos = [];
    const items = Array.isArray(itemsFinales) ? itemsFinales : [];
    if (!items.length) return avisos;

    const agregados = propuestos.filter(o => o.action === 'add').map(o => o.item);

    // ---- 1. ¿Está presupuestando a costo? -------------------------------------
    // El error que motivó todo esto. Si los items nuevos traen precio pero
    // ninguno pasó por el coeficiente, lo más probable es que sean costos
    // directos que se colaron como precio de venta.
    const conPrecio = agregados.filter(i => (Number(i.unit_price) || 0) > 0);
    const conMargen = conPrecio.filter(i => i._costo_directo !== undefined);
    if (conPrecio.length >= 2 && conMargen.length === 0) {
        avisos.push(
            'Ojo: ninguno de estos precios pasó por el margen de la empresa. ' +
            'Si son estimaciones (material + mano de obra), te están quedando a costo: sin gastos generales, sin utilidad y sin impuestos. ' +
            'Si salieron de tu tarifario está bien, porque esos ya son precios de venta.'
        );
    }

    // ---- 2. ¿Falta la mano de obra? -------------------------------------------
    // Un presupuesto de obra sin mano de obra casi siempre es un olvido: se
    // computó el material y se dio por hecho que alguien lo va a colocar gratis.
    const hayMaterial = items.some(i => RE_MATERIAL.test(i.name || ''));
    const hayManoObra = items.some(i => RE_MANO_OBRA.test(i.name || '') || RE_MANO_OBRA.test(i.detail || ''));
    if (hayMaterial && !hayManoObra) {
        avisos.push('No veo mano de obra en el presupuesto, solo materiales. ¿Va aparte o falta cargarla?');
    }

    // ---- 3. Cantidades que no salen de ninguna cuenta --------------------------
    // Si el item está en una unidad de medida (m, m², m³) y no dice de dónde sale
    // la cantidad, no hay forma de defenderlo cuando el cliente lo discuta.
    for (const it of agregados) {
        const unidad = String(it.unit || '');
        if (UNIDADES_SIN_MEDIDA.has(unidad)) continue;
        const detalle = String(it.detail || '');
        // Sirve una cuenta ("9 x 1.10 = 9.9") o una medida nombrada
        // ("Perímetro: 45 m"): las dos se pueden verificar con el metro en la mano.
        const explicaLaCuenta = /\d\s*[x×]\s*\d|=|desperdicio|seg[úu]n plano|medid|rendimiento|(per[íi]metro|superficie|largo|ancho|alto|espesor|profundidad)\s*:?\s*\d/i.test(detalle);
        if (!explicaLaCuenta) {
            avisos.push(`El item "${it.name}" está en ${unidad} pero no dice de dónde sale la cantidad. Conviene anotar la cuenta en el detalle para poder defenderla.`);
            break;   // con avisar una vez alcanza; no hace falta repetirlo por item
        }
    }

    // ---- 4. Precios muy lejos del tarifario ------------------------------------
    // Compara contra lo que él mismo cargó. Es la única referencia de verdad que
    // tenemos: si dice que la hora de albañil son $9.500 y el modelo puso
    // $80.000, alguno de los dos está mal y vale la pena que lo mire.
    for (const it of agregados) {
        const ref = buscarEnTarifario(it, tarifario);
        if (!ref) continue;
        const precio = Number(it.unit_price) || 0;
        if (!precio || !ref.price) continue;
        const razon = precio / ref.price;
        if (razon >= 3 || razon <= 1 / 3) {
            avisos.push(
                `"${it.name}" quedó en ${$(precio)} por ${it.unit}, y en tu tarifario "${ref.name}" está ${$(ref.price)} por ${ref.unit}. ` +
                `Es ${razon >= 3 ? razon.toFixed(1) + ' veces más caro' : 'bastante más barato'}: fijate si es el mismo trabajo.`
            );
            break;
        }
    }

    // ---- 5. Items en cero ------------------------------------------------------
    const enCero = agregados.filter(i => !(Number(i.unit_price) > 0));
    if (enCero.length) {
        avisos.push(`Quedaron ${enCero.length} item(s) en $0 (${enCero.slice(0, 2).map(i => `"${i.name}"`).join(', ')}). Cargales el precio antes de mandar el presupuesto.`);
    }

    // Nota: acá vivía una línea informativa con cuánto del presupuesto era costo
    // directo. Se sacó a propósito. Estos avisos se muestran en naranja, como
    // problemas, y mezclar información con problemas enseña a ignorarlos a todos.
    // Si hace falta mostrar costo contra venta, va en la tarjeta y no acá.

    return avisos.slice(0, 4);
}

/**
 * Busca el item más parecido del tarifario, exigiendo que compartan la unidad
 * (comparar un m² contra una hora no dice nada) y al menos una palabra fuerte.
 */
function buscarEnTarifario(item, tarifario) {
    const palabras = String(item.name || '')
        .toLowerCase()
        .replace(/[^a-záéíóúñ0-9\s]/gi, ' ')
        .split(/\s+/)
        .filter(p => p.length > 4);
    if (!palabras.length) return null;

    for (const ref of tarifario) {
        if (String(ref.unit) !== String(item.unit)) continue;
        const nombreRef = String(ref.name || '').toLowerCase();
        if (palabras.some(p => nombreRef.includes(p))) return ref;
    }
    return null;
}
