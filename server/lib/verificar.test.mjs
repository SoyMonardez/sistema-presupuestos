import { revisarPresupuesto } from './verificar.js';

const markup = { utilidad_pct: 15 };
let pasadas = 0, total = 0;

function caso(nombre, items, opts, esperado) {
    total++;
    const avisos = revisarPresupuesto(items, { markup, ...opts });
    const ok = esperado(avisos);
    if (ok) pasadas++;
    console.log(`${ok ? 'OK  ' : 'MAL '} ${nombre}`);
    avisos.forEach(a => console.log(`       · ${a}`));
    if (!ok) console.log('       (no era lo esperado)');
    console.log('');
}

// 1. El caso que motivó todo: la pared a costo
const paredACosto = [
    { name: 'Ladrillo común 8 huecos', unit: 'm²', quantity: 10, unit_price: 25000, detail: '' },
    { name: 'Argamasa y accesorios',   unit: 'm²', quantity: 10, unit_price: 15000, detail: '' },
    { name: 'Mano de obra albañil',    unit: 'm²', quantity: 10, unit_price: 20000, detail: '' },
];
caso('Presupuesto a costo (sin margen)', paredACosto,
    { propuestos: paredACosto.map(item => ({ action: 'add', item })) },
    a => a.some(x => /a costo/i.test(x)));

// 2. Solo materiales, sin mano de obra
const soloMaterial = [
    { name: 'Ladrillo común', unit: 'un.', quantity: 600, unit_price: 350, detail: '', _costo_directo: 250 },
    { name: 'Cemento',        unit: 'saco', quantity: 12, unit_price: 20000, detail: '', _costo_directo: 15000 },
];
caso('Falta la mano de obra', soloMaterial,
    { propuestos: soloMaterial.map(item => ({ action: 'add', item })) },
    a => a.some(x => /mano de obra/i.test(x)));

// 3. Cantidad en m² sin explicar de dónde sale
const sinCuenta = [
    { name: 'Revoque grueso', unit: 'm²', quantity: 47, unit_price: 12000, detail: '', _costo_directo: 8800 },
    { name: 'Mano de obra',   unit: 'hs',  quantity: 16, unit_price: 9000, detail: '', _costo_directo: 6600 },
];
caso('Cantidad sin justificar', sinCuenta,
    { propuestos: sinCuenta.map(item => ({ action: 'add', item })) },
    a => a.some(x => /de dónde sale/i.test(x)));

// 4. Igual pero con la cuenta escrita: NO debe avisar por eso
const conCuenta = [
    { name: 'Revoque grueso', unit: 'm²', quantity: 47, unit_price: 12000, _costo_directo: 8800,
      detail: 'Muro: 18.80 m x 2.50 m = 47 m²' },
    { name: 'Mano de obra',   unit: 'hs', quantity: 16, unit_price: 9000, _costo_directo: 6600, detail: '' },
];
caso('Cantidad justificada (no debe avisar)', conCuenta,
    { propuestos: conCuenta.map(item => ({ action: 'add', item })) },
    a => !a.some(x => /de dónde sale/i.test(x)));

// 5. Precio muy lejos del tarifario
const caro = [
    { name: 'Hora de oficial albañil', unit: 'hs', quantity: 8, unit_price: 95000, detail: '', _costo_directo: 70000 },
    { name: 'Ladrillo', unit: 'un.', quantity: 100, unit_price: 400, detail: '', _costo_directo: 300 },
];
caso('Precio 10x el tarifario', caro,
    {
        propuestos: caro.map(item => ({ action: 'add', item })),
        tarifario: [{ name: 'Hora de oficial albañil', unit: 'hs', price: 9500 }],
    },
    a => a.some(x => /tarifario/i.test(x)));

// 6. Items en cero
const enCero = [
    { name: 'Sellado de juntas', unit: 'm', quantity: 45, unit_price: 0, detail: 'Perímetro: 45 m' },
    { name: 'Mano de obra', unit: 'hs', quantity: 8, unit_price: 9000, detail: '', _costo_directo: 6600 },
];
caso('Items en cero', enCero,
    { propuestos: enCero.map(item => ({ action: 'add', item })) },
    a => a.some(x => /\$0/.test(x)));

// 7. Un presupuesto bien armado: pocos o ningún aviso de error
const bien = [
    { name: 'Ladrillo común 8x19x9', unit: 'un.', quantity: 675, unit_price: 341, _costo_directo: 250,
      detail: 'Superficie: 9.00 m x 1.10 m = 9.9 m²\n62 ladrillos/m² x 9.9 = 614 un.\n+10% desperdicio = 675 un.' },
    { name: 'Cemento y arena', unit: 'global', quantity: 1, unit_price: 204510, _costo_directo: 150000, detail: 'Para 9.9 m²' },
    { name: 'Mano de obra albañil y ayudante', unit: 'día', quantity: 2, unit_price: 109072, _costo_directo: 80000, detail: '2 días' },
];
caso('Presupuesto bien armado', bien,
    { propuestos: bien.map(item => ({ action: 'add', item })) },
    a => !a.some(x => /a costo|mano de obra|de dónde sale|\$0/i.test(x)));

console.log(`${pasadas}/${total}`);
process.exit(pasadas === total ? 0 : 1);
