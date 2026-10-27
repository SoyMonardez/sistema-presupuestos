// Pruebas del historial de cambios: cuándo se guarda una versión, qué cambió
// entre una y otra, y qué ve la IA para poder deshacer o volver a un valor
// anterior. Solo funciones puras: no toca la base.

import { decidirVersion, cambiosEntre, contextoHistorial, haceCuanto, foto } from './historial.js';

let ok = 0, total = 0;
function prueba(nombre, condicion) {
    total++;
    if (condicion) { ok++; console.log(`OK   ${nombre}`); }
    else console.log(`FALLA  ${nombre}`);
}

const it = (uid, name, unit_price, quantity = 1, unit = 'm²') => ({ uid, name, detail: '', quantity, unit, unit_price });
const json = (items) => JSON.stringify(foto(items));
const AHORA = 1_800_000_000_000;

// ---- decidirVersion ----
{
    const ultima = { items_json: json([it('a', 'Contrapiso', 15000)]), origen: 'manual', ms: AHORA - 5000 };
    prueba('versión: sin historial, se guarda', decidirVersion(null, '[]', 'manual', AHORA) === 'nueva');
    prueba('versión: si no cambió nada, no se guarda', decidirVersion(ultima, ultima.items_json, 'manual', AHORA) === 'igual');
    prueba('versión: tipeando a mano seguido, se junta', decidirVersion(ultima, json([it('a', 'Contrapiso', 18000)]), 'manual', AHORA) === 'juntar');
    prueba('versión: a mano pero mucho después, una nueva', decidirVersion({ ...ultima, ms: AHORA - 60000 }, json([it('a', 'Contrapiso', 18000)]), 'manual', AHORA) === 'nueva');
    prueba('versión: un cambio por voz nunca se junta', decidirVersion(ultima, json([it('a', 'Contrapiso', 18000)]), 'voz', AHORA) === 'nueva');
    prueba('versión: a mano después de la voz, no pisa lo de la voz', decidirVersion({ ...ultima, origen: 'voz' }, json([it('a', 'Contrapiso', 18000)]), 'manual', AHORA) === 'nueva');
}

// ---- cambiosEntre ----
{
    const antes = [it('a', 'Contrapiso', 15000), it('b', 'Demolición', 320000), it('c', 'Pintura', 9000)];
    const despues = [it('a', 'Contrapiso de 8 cm', 18000), it('c', 'Pintura', 9000), it('d', 'Revoque', 12000)];
    const c = cambiosEntre(antes, despues);
    const cambio = c.find(x => x.uid === 'a');
    prueba('cambios: renombrado y precio, por uid', cambio?.tipo === 'modificado' && cambio.campos.unit_price.antes === 15000 && cambio.campos.name.antes === 'Contrapiso');
    prueba('cambios: agregado', c.some(x => x.uid === 'd' && x.tipo === 'agregado'));
    prueba('cambios: borrado con sus valores', c.some(x => x.uid === 'b' && x.tipo === 'borrado' && x.valores.unit_price === 320000));
    prueba('cambios: lo que no cambió no aparece', !c.some(x => x.uid === 'c'));
}

// ---- contextoHistorial ----
{
    const v = [
        { ms: AHORA - 30 * 60000, origen: 'inicio', items: foto([it('a', 'Contrapiso', 15000), it('b', 'Demolición', 320000)]) },
        { ms: AHORA - 10 * 60000, origen: 'voz',    items: foto([it('a', 'Contrapiso', 18000), it('b', 'Demolición', 320000)]) },
        { ms: AHORA - 2 * 60000,  origen: 'voz',    items: foto([it('a', 'Contrapiso', 18000)]) },
    ];
    const actuales = [it('a', 'Contrapiso', 21000)];
    const ctx = contextoHistorial(v, actuales, AHORA);
    prueba('contexto: el último cambio es lo que todavía no se guardó', ctx.ultimos_cambios[0].origen === 'pantalla'
        && ctx.ultimos_cambios[0].cambios[0].campos.unit_price.antes === 18000);
    prueba('contexto: después, el borrado de la demolición', ctx.ultimos_cambios[1].cambios.some(c => c.tipo === 'borrado' && c.item === 'Demolición'));
    prueba('contexto: el primero dice que es el más reciente', ctx.ultimos_cambios[0].orden === 'el más reciente');
    const ant = ctx.anteriores.find(a => a.item === 'Contrapiso');
    prueba('contexto: valores anteriores del item, el más reciente primero',
        ant?.num === 1 && ant.valores_anteriores[0].unit_price === 18000 && ant.valores_anteriores[1].unit_price === 15000);
    prueba('contexto: no repite el valor actual como anterior', !ant.valores_anteriores.some(x => x.unit_price === 21000));
    prueba('contexto: el borrado se puede recuperar', ctx.borrados.length === 1 && ctx.borrados[0].unit_price === 320000);
    prueba('contexto: los cambios llevan el número de item que ve él', ctx.ultimos_cambios[0].cambios[0].num === 1);
    prueba('contexto: no le muestra los uid a la IA', !JSON.stringify(ctx.ultimos_cambios).includes('"uid"'));
    prueba('contexto: sin historial, nada', contextoHistorial([], actuales, AHORA) === null);
}

// ---- haceCuanto ----
prueba('tiempo: recién', haceCuanto(AHORA - 20000, AHORA) === 'recién');
prueba('tiempo: minutos', haceCuanto(AHORA - 5 * 60000, AHORA) === 'hace 5 min');
prueba('tiempo: horas', haceCuanto(AHORA - 3 * 3600000, AHORA) === 'hace 3 h');

console.log(`\n${ok}/${total}`);
process.exit(ok === total ? 0 : 1);
