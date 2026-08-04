// Pruebas de cómo se prepara el texto antes de leerlo en voz alta.
//
// Es la parte que de verdad decide si se entiende o no. Un lector de voz lee
// "$238.525" como "doscientos treinta y ocho punto quinientos veinticinco" y
// "m²" como "eme dos" — hablado eso no sirve para nada, y es justo lo que más
// aparece en un presupuesto.
//
// Ojo con el punto: en la plata es separador de miles ("175.000") y en las
// medidas es decimal ("1.10 m"). Los dos casos conviven en el mismo mensaje.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const leer = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');

// hablar.js usa numeroALetras, que vive en pdf.js. Se evalúan juntos, con un
// window mínimo para que el módulo pueda preguntar por speechSynthesis.
const sandbox = `
    const window = { };
    ${leer('pdf.js')}
    ${leer('hablar.js')}
    return Hablar;
`;
const Hablar = new Function(sandbox)();

let ok = 0, total = 0;

function prueba(nombre, entrada, esperado) {
    total++;
    const r = Hablar.paraLeer(entrada);
    if (r === esperado) {
        ok++;
        console.log(`OK   ${nombre}`);
    } else {
        console.log(`FALLA  ${nombre}\n       esperaba: ${esperado}\n       vino:     ${r}`);
    }
}

function contiene(nombre, entrada, fragmento) {
    total++;
    const r = Hablar.paraLeer(entrada);
    if (r.includes(fragmento)) {
        ok++;
        console.log(`OK   ${nombre}`);
    } else {
        console.log(`FALLA  ${nombre}\n       esperaba que contenga: ${fragmento}\n       vino: ${r}`);
    }
}

// ---- Plata ----
prueba('monto con separador de miles', 'Sale $238.525', 'Sale doscientos treinta y ocho mil quinientos veinticinco pesos');
prueba('monto con espacio despues del signo', 'Total $ 1.170.000', 'Total un millón ciento setenta mil pesos');
prueba('monto con centavos', 'Queda $27.268,04', 'Queda veintisiete mil doscientos sesenta y ocho pesos con 4 centavos');
prueba('monto chico', 'Son $900', 'Son novecientos pesos');

// ---- Número grande sin signo ----
prueba('costo directo suelto', 'El costo directo es 175.000 en total', 'El costo directo es ciento setenta y cinco mil en total');

// ---- Medidas: el punto acá es DECIMAL, no miles ----
prueba('medida decimal con punto', 'La pared es de 1.10 de alto', 'La pared es de 1 coma 10 de alto');
prueba('cantidad decimal con coma', 'Son 9,9 de superficie', 'Son 9 coma 9 de superficie');

// ---- Unidades ----
contiene('metros cuadrados', 'Cubre 20 m² de contrapiso', 'metros cuadrados');
contiene('metros cubicos', 'Da 1.485 m³', 'metros cúbicos');
// Este salió de una conversión real (9,9 m² × 0,15 = 1.485 m³). Con la regla de
// los miles se leía "mil cuatrocientos ochenta y cinco": mil veces el valor.
// La unidad de atrás es lo que dice que el punto es decimal.
prueba('volumen convertido NO es mil', 'Da 1.485 m³', 'Da 1 coma 485 metros cúbicos');
contiene('horas', 'Son 3 hs de máquina', 'horas');
contiene('porcentaje', 'Le bajo un 10%', 'por ciento');

// ---- Markdown que mete el modelo ----
prueba('negritas fuera', 'El precio es **$238.525** final', 'El precio es doscientos treinta y ocho mil quinientos veinticinco pesos final');

// ---- Casos de texto real, pegado a la unidad ----
// Así viene escrito en los items ("platea 0.80m x 0.50m x 0.15m"): sin espacio
// entre el número y la unidad. Entre "0" y "m" no hay borde de palabra, y por
// eso estos casos —los más frecuentes— quedaban sin convertir.
prueba('medida pegada a la unidad', 'Muro de 1.10m de alto', 'Muro de 1 coma 10 metros de alto');
prueba('cadena de medidas pegadas', 'Platea 0.80m x 0.50m x 0.15m',
    'Platea 0 coma 80 metros x 0 coma 50 metros x 0 coma 15 metros');
// Sin número adelante también se convierte (antes leía "el eme dos"). El
// singular lo pone la regla de concordancia, ver más abajo.
contiene('unidad sin numero adelante', 'a $42.000 el m²', 'metro cuadrado');

// ---- Que no suene a traducción automática ----
prueba('con articulo va en singular', 'a $42.000 el m²', 'a cuarenta y dos mil pesos el metro cuadrado');
contiene('abreviatura de hormigon', 'Platea de H°17', 'hormigón 17');

// ---- Caso real: plata y medida en la MISMA frase ----
contiene('plata y medida juntas: la plata en palabras',
    'Muro de 1.10 m de alto por $175.000', 'ciento setenta y cinco mil pesos');
contiene('plata y medida juntas: la medida como decimal',
    'Muro de 1.10 m de alto por $175.000', '1 coma 10');

// ---- No debe romper texto sin números ----
prueba('texto comun intacto', 'Dale, lo dejo como estaba', 'Dale, lo dejo como estaba');

console.log(`\n${ok}/${total}`);
process.exit(ok === total ? 0 : 1);
