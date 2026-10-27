// Pruebas de la lógica de la conversación por voz.
//
// Lo que se prueba acá son las reglas que, si fallan, corrompen un presupuesto
// sin que se note: a qué item apunta un cambio cuando hay otros esperando el
// "sí", qué pasa con los que dependían de uno que se rechazó, qué tarjeta se
// anima después de borrar, y cuándo el asistente puede hablar sin pisarlo.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'conversacion.js'), 'utf8');

// Archivo de navegador: sin window, solo se define la parte de lógica.
const { ConversacionLogica: L } = new Function(`
    const module = { exports: {} };
    ${src}
    return module.exports;
`)();

let ok = 0, total = 0;
function prueba(nombre, condicion) {
    total++;
    if (condicion) { ok++; console.log(`OK   ${nombre}`); }
    else console.log(`FALLA  ${nombre}`);
}

const it = (name, unit_price = 100) => ({ name, detail: '', quantity: 1, unit: 'un.', unit_price });
const add = (name) => ({ action: 'add', item: it(name) });
const upd = (num, fields) => ({ action: 'update', num, fields });
const rem = (num) => ({ action: 'remove', num });

// ---- proyectar ----
{
    const items = [it('A'), it('B')];
    const tandas = [{ ops: [add('C')] }, { ops: [upd(3, { unit_price: 999 })] }];
    const p = L.proyectar(items, tandas);
    prueba('proyectar: un cambio sobre un item pendiente apunta al pendiente',
        p.length === 3 && p[2].name === 'C' && p[2].unit_price === 999);
    prueba('proyectar: no toca la lista original', items.length === 2 && items[0].unit_price === 100);
}

// ---- rechazar ----
{
    const tandas = [
        { ops: [rem(1)], tarjeta: 't1' },
        { ops: [add('X'), upd(1, { name: 'Y' })], tarjeta: 't2' },
        { ops: [upd(2, { quantity: 3 })], tarjeta: 't3' },
    ];
    const r = L.rechazar(tandas, 0);
    prueba('rechazar: saca la tanda rechazada', !r.some(t => t.tarjeta === 't1'));
    prueba('rechazar: de las siguientes conserva las altas', r.find(t => t.tarjeta === 't2')?.ops.length === 1
        && r.find(t => t.tarjeta === 't2').ops[0].action === 'add');
    prueba('rechazar: marca la recortada', r.find(t => t.tarjeta === 't2')?.recortada === true);
    prueba('rechazar: descarta la que se quedó sin cambios', !r.some(t => t.tarjeta === 't3'));

    const previas = L.rechazar(tandas, 2);
    prueba('rechazar: las anteriores no se tocan', previas.length === 2 && previas[0] === tandas[0] && previas[1] === tandas[1]);

    const conEncabezado = L.rechazar([{ ops: [], encabezado: {} }, { ops: [upd(1, { name: 'Z' })], encabezado: { name: 'Obra' } }], 0);
    prueba('rechazar: una tanda que solo cambia el encabezado sigue viva', conEncabezado.length === 1 && conEncabezado[0].ops.length === 0);
}

// ---- indicesTocados ----
{
    // 5 items; se borran el 2 y el 4, se cambia el 5, se agregan dos.
    const ops = [rem(2), rem(4), upd(5, { unit_price: 1 }), add('N1'), add('N2')];
    const { altas, cambios, bajas } = L.indicesTocados(ops, 5);
    prueba('indices: las bajas van en índices de antes', bajas.join() === '1,3');
    prueba('indices: el cambio se corre por las bajas de antes', cambios.length === 1 && cambios[0].idx === 2);
    prueba('indices: las altas quedan al final de la lista nueva', altas.join() === '3,4');

    const mismo = L.indicesTocados([upd(2, { name: 'x' }), rem(2)], 3);
    prueba('indices: no anima un cambio sobre un item que se borra', mismo.cambios.length === 0);

    // Lo mismo que hace Estado.aplicarOps, para confirmar que los índices coinciden.
    const lista = L.aplicarCopia([it('a'), it('b'), it('c'), it('d'), it('e')], ops);
    prueba('indices: coinciden con la lista aplicada', lista[2].name === 'e' && lista[3].name === 'N1' && lista[4].name === 'N2');
}

// ---- armarResumen ----
prueba('resumen: una sola respuesta se dice tal cual', L.armarResumen(['Listo, agregué la demolición.'], {}) === 'Listo, agregué la demolición.');
prueba('resumen: nada que decir', L.armarResumen([], {}) === '');
{
    const r = L.armarResumen(['a', 'b', 'c'], { altas: ['Demolición', 'Contrapiso', 'Revoque', 'Pintura'], cambios: 1, bajas: 0 });
    prueba('resumen: varias se resumen con la cantidad', /4 items/.test(r) && /Demolición/.test(r) && /cambié uno/.test(r) && /seguimos/.test(r));
    prueba('resumen: no nombra más de tres', !/Pintura/.test(r));
}
prueba('resumen: avisa los que quedaron sin precio',
    /3 quedaron sin precio/.test(L.armarResumen(['a', 'b'], { altas: ['A', 'B', 'C', 'D'], sinPrecio: 3 })));
prueba('resumen: sin faltantes no avisa nada',
    !/sin precio/.test(L.armarResumen(['a', 'b'], { altas: ['A', 'B'], sinPrecio: 0 })));
prueba('resumen: varias sin cambios dice la última', L.armarResumen(['uno', 'dos'], { altas: [], cambios: 0, bajas: 0 }) === 'dos');

// ---- tocaHablar ----
const base = { hayParaDecir: true, usuarioHabla: false, msDesdeQueHablo: 5000, ocupado: false };
prueba('hablar: con pausa y nada pendiente, habla', L.tocaHablar(base));
prueba('hablar: si él está hablando, no', !L.tocaHablar({ ...base, usuarioHabla: true }));
prueba('hablar: si recién paró, espera la pausa', !L.tocaHablar({ ...base, msDesdeQueHablo: 500 }));
prueba('hablar: si todavía está pensando lo siguiente, espera', !L.tocaHablar({ ...base, ocupado: true }));
prueba('hablar: sin nada para decir, no', !L.tocaHablar({ ...base, hayParaDecir: false }));

// ---- esEco ----
const dicho = ['Listo, agregué la demolición. ¿Con qué seguimos?'];
prueba('eco: lo que acaba de decir el asistente es eco', L.esEco('agregué la demolición con qué seguimos', dicho));
prueba('eco: un pedido nuevo no es eco', !L.esEco('agregá contrapiso 20 metros a 15 lucas', dicho));
prueba('eco: una palabra suelta no alcanza para decidir', !L.esEco('listo', dicho));
prueba('eco: sin nada dicho, nunca es eco', !L.esEco('agregué la demolición', []));
prueba('eco: ignora tildes y mayúsculas', L.esEco('AGREGUE LA DEMOLICION', dicho));
// El caso que se perdía: comparte "contrapiso" y "mil" con lo que acaba de
// decir, pero es un pedido nuevo.
prueba('eco: un pedido que repite palabras de la respuesta NO es eco',
    !L.esEco('ahora el contrapiso a 21 mil', ['Listo, el contrapiso quedó a 18 mil. ¿Seguimos?']));
prueba('eco: la respuesta repetida tal cual sí es eco',
    L.esEco('el contrapiso quedó a 18 mil', ['Listo, el contrapiso quedó a 18 mil. ¿Seguimos?']));

console.log(`\n${ok}/${total}`);
process.exit(ok === total ? 0 : 1);
