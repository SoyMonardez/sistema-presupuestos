// Pruebas del detector de silencio del dictado.
//
// Es lo que decide cuándo el mensaje se manda solo, así que equivocarse tiene
// dos costos feos: cortar en medio de una frase (manda algo a medio decir) o no
// cortar nunca (se queda grabando hasta el tope de dos minutos).
//
// Va aparte del micrófono y de los temporizadores a propósito. Intentar probar
// esto en un navegador no sirve: cuando la pestaña no está a la vista, Chrome
// estrangula los setInterval —medido, 4 ejecuciones donde tocaban 30— así que
// una prueba de tiempo real ahí da falsos negativos. La decisión es una función
// pura: se le pasa volumen y reloj, y contesta.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'voice.js'), 'utf8');

// voice.js es un archivo de navegador: se le da el mínimo para que se defina.
const { Voice } = new Function('window', 'navigator', `
    const module = { exports: {} };
    ${src}
    return module.exports;
`)({}, {});

const SILENCIO_MS = 3000;
const VOZ = 0.2;        // volumen de alguien hablando
const NADA = 0.001;     // ruido de fondo

let ok = 0, total = 0;

function prueba(nombre, pasos, esperado) {
    total++;
    const d = Voice.crearDetectorDeSilencio({ silencioMs: SILENCIO_MS });
    let cortoEn = null;
    for (const [volumen, t] of pasos) {
        if (d.medir(volumen, t) && cortoEn === null) cortoEn = t;
    }
    const bien = esperado === null ? cortoEn === null : cortoEn === esperado;
    if (bien) { ok++; console.log(`OK   ${nombre}`); }
    else console.log(`FALLA  ${nombre}\n       esperaba cortar en ${esperado}, cortó en ${cortoEn}`);
}

// Silencio desde el arranque: nunca corta, porque todavía no dijo nada. Sin
// esta regla, tocar el micrófono y pensar dos segundos mandaría un mensaje vacío.
prueba('callado desde el principio no corta',
    [[NADA, 0], [NADA, 1000], [NADA, 5000], [NADA, 9000]], null);

// Habla y se calla: corta a los 3 segundos de haberse callado.
prueba('corta a los 3s de dejar de hablar',
    [[VOZ, 0], [VOZ, 500], [NADA, 1000], [NADA, 2000], [NADA, 3000], [NADA, 4000]], 4000);

// No corta antes de tiempo.
prueba('no corta a los 2s',
    [[VOZ, 0], [NADA, 500], [NADA, 1500], [NADA, 2400]], null);

// Pausa al pensar en medio de la frase: sigue hablando y NO tiene que cortar.
prueba('la pausa para pensar no corta',
    [[VOZ, 0], [NADA, 500], [NADA, 1500], [NADA, 2400], [VOZ, 2600], [NADA, 3000], [NADA, 4000]], null);

// Después de retomar, la cuenta arranca de nuevo desde el último sonido.
prueba('tras retomar, cuenta de nuevo desde cero',
    [[VOZ, 0], [NADA, 1000], [VOZ, 2000], [NADA, 3000], [NADA, 4000], [NADA, 5000], [NADA, 6100]], 6100);

// Un ruido corto no alcanza para que cuente como que habló.
total++;
{
    const d = Voice.crearDetectorDeSilencio({ silencioMs: SILENCIO_MS, umbral: 0.012 });
    const bajoUmbral = d.medir(0.011, 0) === false && d.medir(0.011, 5000) === false;
    if (bajoUmbral) { ok++; console.log('OK   el ruido de fondo no cuenta como voz'); }
    else console.log('FALLA  el ruido de fondo no cuenta como voz');
}

console.log(`\n${ok}/${total}`);
process.exit(ok === total ? 0 : 1);
