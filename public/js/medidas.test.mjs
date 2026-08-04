// Pruebas de la lectura de medidas del texto del item.
//
// Existen por un bug que estuvo silencioso: las medidas escritas con nombre
// ("espesor 15 cm", "ancho 1,20 m") NO se leían nunca. La alternación de la
// etiqueta se concatenaba con el número sin agrupar, así que el número quedaba
// atado solo a la última opción de la alternación. Lo único que funcionaba era
// la cadena de dimensiones ("0.80m x 0.50m x 0.15m"), que es justo el caso con
// el que se probó a mano — por eso pasó desapercibido.
//
// Es un archivo del navegador, sin import/export: se lee y se evalúa.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(__dirname, 'medidas.js'), 'utf8');
const Medidas = new Function(`${src}; return Medidas;`)();

let ok = 0, total = 0;

function prueba(nombre, texto, esperado) {
    total++;
    const r = Medidas.extraer(texto);
    const fallas = [];
    for (const [campo, valor] of Object.entries(esperado)) {
        const obtenido = r[campo];
        // Comparación con tolerancia: son metros salidos de dividir por 100.
        if (obtenido === undefined || Math.abs(obtenido - valor) > 1e-9) {
            fallas.push(`${campo}: esperaba ${valor}, vino ${obtenido}`);
        }
    }
    if (fallas.length) {
        console.log(`FALLA  ${nombre}\n       ${fallas.join('\n       ')}`);
    } else {
        ok++;
        console.log(`OK   ${nombre}`);
    }
}

prueba('espesor en cm', 'Muro de ladrillo, espesor 15 cm', { alto: 0.15 });
prueba('espesor abreviado con igual', 'Losa e=0,12 m', { alto: 0.12 });
prueba('ancho con coma decimal', 'Vereda de hormigón, ancho 1,20 m', { ancho: 1.2 });
prueba('largo en metros', 'Cordón cuneta, largo 30 m', { largo: 30 });
prueba('altura en mm', 'Zócalo, altura 100 mm', { alto: 0.1 });
prueba('cadena de tres dimensiones', 'Platea de H°17 0.80m x 0.50m x 0.15m', { largo: 0.8, ancho: 0.5, alto: 0.15 });
prueba('cadena de dos + "de alto"', 'Muro 9m x 1.10m de alto', { largo: 9, alto: 1.1 });
// La etiqueta explícita gana: "9m x 1.10m" es el frente del muro, el espesor es
// lo que hace falta para pasarlo a m³. Antes ganaba el 1,10 y la conversión daba
// 10,89 m³ en vez de 1,485 m³ — casi ocho veces de más.
prueba('la etiqueta explícita le gana a la cadena', 'Muro 9m x 1.10m de alto, espesor 15 cm', { largo: 9, alto: 0.15 });

// medidasPara solo devuelve lo que se pidió, y la fuente para mostrarla.
total++;
const { valores, fuente } = Medidas.medidasPara(['alto'], 'Muro de ladrillo, espesor 15 cm');
if (valores.alto === 0.15 && Object.keys(valores).length === 1 && fuente.includes('espesor')) {
    ok++;
    console.log('OK   medidasPara filtra por lo que hace falta y dice de dónde salió');
} else {
    console.log(`FALLA  medidasPara: ${JSON.stringify({ valores, fuente })}`);
}

// Texto sin medidas: no inventa nada.
total++;
const vacio = Medidas.extraer('Mano de obra de albañilería');
if (vacio.largo === undefined && vacio.ancho === undefined && vacio.alto === undefined && vacio.fuente === '') {
    ok++;
    console.log('OK   texto sin medidas no inventa ninguna');
} else {
    console.log(`FALLA  texto sin medidas: ${JSON.stringify(vacio)}`);
}

console.log(`\n${ok}/${total}`);
process.exit(ok === total ? 0 : 1);
