import assert from 'node:assert/strict';
import { crearLimiteIA } from './limite-ia.js';

let t = 0;
const limite = crearLimiteIA({ porMinuto: 3, porDia: 5, ahora: () => t });

// Por minuto: 3 entran, el cuarto no.
for (let i = 0; i < 3; i++) assert.equal(limite.permitir('a').ok, true);
assert.deepEqual(limite.permitir('a').motivo, 'minuto');

// Cada acceso tiene su cuenta.
assert.equal(limite.permitir('b').ok, true);

// Pasado el minuto vuelve a entrar, hasta el techo del día.
t += 60_000;
assert.equal(limite.permitir('a').ok, true);
assert.equal(limite.permitir('a').ok, true);
assert.equal(limite.permitir('a').motivo, 'dia');
t += 60_000;
assert.equal(limite.permitir('a').motivo, 'dia');

// Al otro día se reinicia.
t += 24 * 60 * 60 * 1000;
assert.equal(limite.permitir('a').ok, true);

// Lo rechazado no cuenta.
const l2 = crearLimiteIA({ porMinuto: 1, porDia: 2, ahora: () => t });
assert.equal(l2.permitir('x').ok, true);
for (let i = 0; i < 10; i++) assert.equal(l2.permitir('x').ok, false);
t += 60_000;
assert.equal(l2.permitir('x').ok, true);

console.log('limite-ia: ok');
