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
const ruidoSrc = fs.readFileSync(path.join(__dirname, 'ruido-de-fondo.js'), 'utf8');

// voice.js es un archivo de navegador: se le da el mínimo para que se defina.
// ruido-de-fondo.js va antes, como en index.html.
const { Voice } = new Function('window', 'navigator', `
    const module = { exports: {} };
    ${ruidoSrc}
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

// ---------- Con ruido de fondo ----------
// Lo que pasó en el gimnasio: con música, el volumen nunca bajaba del umbral
// fijo y el dictado no se cortaba nunca. Se arman escenas repetibles: el
// volumen se mide cada 150 ms (como en voice.js), la música tiene un golpe de
// bombo cada medio segundo y la voz baja al nivel del ruido entre palabras.
// La voz además sube y baja entre sílabas (una vocal acentuada suena varias
// veces más fuerte que una consonante): la música comprimida de un gimnasio es
// mucho más pareja, y es lo que permite separarlas.
//
// Cada escena se corre con 100 semillas distintas y tienen que andar todas: una
// sola corrida que pasa puede ser suerte.

function azar(semilla) {   // mulberry32: el mismo "azar" en cada corrida
    return () => {
        semilla |= 0; semilla = semilla + 0x6D2B79F5 | 0;
        let t = Math.imul(semilla ^ semilla >>> 15, 1 | semilla);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

const PASO = 150;
const SEMILLAS = 100;

/**
 * @param {object} o
 * @param {Array<[number, number, number]>} o.ruido  tramos [desde, hasta, volumen] del ruido del lugar
 * @param {Array<[number, number]>} o.habla  tramos [desde, hasta] en ms en que habla
 * @param {number} o.hastaMs     cuánto dura la escena
 */
function escena({ ruido, habla, hastaMs }, semilla) {
    const r = azar(semilla);
    const pasos = [];
    for (let t = 0; t <= hastaMs; t += PASO) {
        const nivel = ruido.find(([a, b]) => t >= a && t < b)?.[2] ?? 0;
        let fondo = nivel * (0.7 + r() * 0.6);
        // El bombo, lo que queda de él después del filtro de voz.
        if (t % 500 < PASO) fondo *= 1.4;
        const hablando = habla.some(([a, b]) => t >= a && t < b);
        // Entre palabra y palabra (uno de cada cinco pasos) la voz se va; el
        // resto, entre 0,06 (consonante) y 0,4 (vocal acentuada): hablándole
        // al celular, de cerca, unos 8 dB por encima de la música.
        const voz = hablando && r() > 0.2 ? 0.06 * Math.pow(0.4 / 0.06, r()) : 0;
        pasos.push([Math.sqrt(fondo * fondo + voz * voz), t]);
    }
    return pasos;
}

/**
 * Corre la escena con muchas semillas. desde null: no tiene que cortar nunca.
 * permitidas: cuántas semillas pueden salir mal (ver la pausa para pensar).
 */
function cortaEntre(nombre, def, desde = null, hasta = null, permitidas = 0) {
    total++;
    const malas = [];
    for (let s = 1; s <= SEMILLAS; s++) {
        const d = Voice.crearDetectorDeSilencio({ silencioMs: SILENCIO_MS });
        let cortoEn = null;
        for (const [v, t] of escena(def, s)) if (d.medir(v, t) && cortoEn === null) cortoEn = t;
        const bien = desde === null ? cortoEn === null : cortoEn !== null && cortoEn >= desde && cortoEn <= hasta;
        if (!bien) malas.push(`semilla ${s}: ${cortoEn === null ? 'no cortó' : `cortó en ${cortoEn}`}`);
    }
    if (malas.length <= permitidas) { ok++; console.log(`OK   ${nombre}${malas.length ? ` (${malas.length}/${SEMILLAS})` : ''}`); }
    else console.log(`FALLA  ${nombre}\n       esperaba ${desde === null ? 'no cortar' : `cortar entre ${desde} y ${hasta}`}; ${malas.length}/${SEMILLAS} mal (${malas.slice(0, 3).join(', ')})`);
}

const GIMNASIO = [[0, Infinity, 0.06]];   // la música queda 5 veces por encima del umbral fijo
const HABITACION = [[0, Infinity, 0.002]];
// Puede cortar apenas terminó de hablar (si lo último que dijo fue bajito, la
// cuenta arrancó un poco antes), nunca mientras habla, y no mucho después.
const despuesDe = (fin) => [fin, fin + SILENCIO_MS + 800];

cortaEntre('gimnasio: corta a los 3s de dejar de hablar aunque siga la música',
    { ruido: GIMNASIO, habla: [[2000, 7000]], hastaMs: 15000 }, ...despuesDe(7000));

cortaEntre('gimnasio: hablando apenas toca el micrófono, también corta',
    { ruido: GIMNASIO, habla: [[0, 6000]], hastaMs: 15000 }, ...despuesDe(6000));

cortaEntre('gimnasio: no corta mientras habla de corrido',
    { ruido: GIMNASIO, habla: [[1000, 14000]], hastaMs: 14000 });

// Una pausa de un segundo y medio. Muy de vez en cuando corta igual: si justo
// antes y después dijo cosas bajito, que no pasan el ruido, el silencio que ve
// el detector suma los 3 segundos. Sin el filtro, con música, no cortaba nunca.
cortaEntre('gimnasio: una pausa para pensar no corta',
    { ruido: GIMNASIO, habla: [[1000, 5000], [6500, 9000]], hastaMs: 9000 }, null, null, 2);

cortaEntre('gimnasio: callado desde el principio no corta antes de aprender el ruido',
    { ruido: GIMNASIO, habla: [], hastaMs: 1400 });

cortaEntre('habitación: hablar de corrido desde el arranque no corta',
    { ruido: HABITACION, habla: [[0, 12000]], hastaMs: 12000 });

cortaEntre('habitación: corta a los 3s como siempre',
    { ruido: HABITACION, habla: [[500, 4000]], hastaMs: 10000 }, ...despuesDe(4000));

// La música cambia de volumen (otro tema, alguien la sube): se acomoda solo.
cortaEntre('la música sube mientras habla y igual corta al final',
    { ruido: [[0, 3000, 0.02], [3000, Infinity, 0.08]], habla: [[1000, 9000]], hastaMs: 20000 },
    ...despuesDe(9000));

console.log(`\n${ok}/${total}`);
process.exit(ok === total ? 0 : 1);
