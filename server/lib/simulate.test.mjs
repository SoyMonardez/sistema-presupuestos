import { simulate, simulationToOps } from './simulate.js';
import { applyOps } from './ops.js';

let pasadas = 0, total = 0;

function caso(nombre, fn) {
    total++;
    try {
        const r = fn();
        if (r === true) { pasadas++; console.log(`OK   ${nombre}`); }
        else { console.log(`MAL  ${nombre}\n       ${r}`); }
    } catch (e) {
        console.log(`MAL  ${nombre}\n       excepción: ${e.message}`);
    }
}

const tresItems = () => ([
    { name: 'Contrapiso',   quantity: 20, unit: 'm²', unit_price: 12000 },
    { name: 'Vereda',       quantity: 35, unit: 'm²', unit_price: 9000  },
    { name: 'Mano de obra', quantity: 8,  unit: 'hs', unit_price: 5000  },
]);

caso('descuento: solo updates, con los numeros correctos', () => {
    const items = tresItems();
    const sim = simulate(items, { type: 'discount', pct: 10, all: true });
    const ops = simulationToOps(items, sim);
    if (ops.some(o => o.action !== 'update')) return 'aparecieron ops que no son update: ' + JSON.stringify(ops);
    if (ops.length !== 3) return `esperaba 3 updates, hubo ${ops.length}`;
    if (ops.map(o => o.num).join() !== '1,2,3') return 'numeros mal: ' + ops.map(o => o.num).join();
    return true;
});

caso('sacar el item del medio: UN remove y ningun update espurio', () => {
    const items = tresItems();
    const sim = simulate(items, { type: 'remove', num: 2 });
    const ops = simulationToOps(items, sim);
    const removes = ops.filter(o => o.action === 'remove');
    const updates = ops.filter(o => o.action === 'update');
    if (updates.length) return 'genero updates espurios: ' + JSON.stringify(updates);
    if (removes.length !== 1 || removes[0].num !== 2) return 'remove mal: ' + JSON.stringify(removes);
    return true;
});

caso('sacar el item del medio: el resultado aplicado es correcto', () => {
    const items = tresItems();
    const sim = simulate(items, { type: 'remove', num: 2 });
    const final = applyOps(items, simulationToOps(items, sim));
    if (final.length !== 2) return `quedaron ${final.length} items`;
    if (final[0].name !== 'Contrapiso' || final[1].name !== 'Mano de obra') {
        return 'quedaron los items equivocados: ' + final.map(i => i.name).join();
    }
    return true;
});

caso('nombres duplicados: saca el item que corresponde, no el primero igual', () => {
    const items = [
        { name: 'Hormigón', quantity: 1, unit: 'm³', unit_price: 100000 },
        { name: 'Hormigón', quantity: 5, unit: 'm³', unit_price: 100000 },
    ];
    const sim = simulate(items, { type: 'remove', num: 2 });
    const ops = simulationToOps(items, sim);
    const removes = ops.filter(o => o.action === 'remove');
    if (removes.length !== 1 || removes[0].num !== 2) {
        return 'antes sacaba el item 1 por comparar nombres; ops: ' + JSON.stringify(ops);
    }
    const final = applyOps(items, ops);
    if (final.length !== 1 || final[0].quantity !== 1) {
        return 'quedo el item equivocado: ' + JSON.stringify(final);
    }
    return true;
});

caso('agregar: op de add sin el marcador interno _idx', () => {
    const items = tresItems();
    const sim = simulate(items, { type: 'add', item: { name: 'Flete', quantity: 1, unit: 'global', unit_price: 40000 } });
    const ops = simulationToOps(items, sim);
    const adds = ops.filter(o => o.action === 'add');
    if (adds.length !== 1) return `esperaba 1 add, hubo ${adds.length}`;
    if ('_idx' in adds[0].item) return 'el _idx interno se filtro al item guardado';
    if (adds[0].item.name !== 'Flete') return 'nombre mal: ' + adds[0].item.name;
    return true;
});

caso('cambiar un precio: solo toca ese item', () => {
    const items = tresItems();
    const sim = simulate(items, { type: 'set_price', num: 3, unit_price: 7000 });
    const ops = simulationToOps(items, sim);
    if (ops.length !== 1) return 'toco mas de un item: ' + JSON.stringify(ops);
    if (ops[0].num !== 3 || ops[0].fields.unit_price !== 7000) return 'op mal: ' + JSON.stringify(ops[0]);
    return true;
});

console.log(`\n${pasadas}/${total}`);
process.exit(pasadas === total ? 0 : 1);
