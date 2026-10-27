// Las palabras que el reconocedor de voz tiene que esperar oír.
//
// Whisper y Scribe se equivocan sobre todo con lo que no es lenguaje de todos
// los días: "mampostería" sale "mamposterías" o "más posterior", "H17" sale
// "hache diecisiete", y el nombre de un item del tarifario sale cualquier cosa.
// A los dos se les puede pasar una lista de términos para que los prefieran
// (Whisper como "prompt", Scribe como "keyterms"), y con eso aciertan mucho más.
//
// La lista sale de tres lados: el vocabulario de obra de siempre, el tarifario
// de él y los items del presupuesto que tiene abierto.

const BASE = [
    'presupuesto', 'item', 'ítem', 'cantidad', 'precio', 'unidad', 'subtotal',
    'metro cuadrado', 'metros cuadrados', 'metro cúbico', 'metros cúbicos', 'metro lineal',
    'm²', 'm³', 'global', 'kilo', 'tonelada', 'litro', 'hora', 'día', 'bolsa',
    'demolición', 'mampostería', 'contrapiso', 'carpeta', 'revoque grueso', 'revoque fino',
    'hormigón', 'hormigón armado', 'H17', 'H21', 'losa', 'viga', 'columna', 'platea', 'zapata',
    'cerámica', 'porcelanato', 'pintura', 'látex', 'impermeabilización', 'membrana',
    'excavación', 'compactación', 'relleno', 'nivelación', 'vereda', 'cordón cuneta',
    'mano de obra', 'materiales', 'flete', 'volquete', 'limpieza de obra',
    'luca', 'lucas', 'palo', 'mil', 'millón',
    'agregá', 'sacá', 'cambiá', 'deshacé', 'título', 'cliente',
];

const limpiar = (t) => String(t || '').replace(/\s+/g, ' ').trim();

/**
 * @param {object} o
 * @param {string[]} [o.tarifario]  nombres del tarifario
 * @param {string[]} [o.items]      nombres de los items del presupuesto abierto
 * @param {number}   [o.max]        tope de términos
 * @returns {string[]} términos sin repetir, los más específicos primero
 */
export function vocabularioVoz({ tarifario = [], items = [], max = 80 } = {}) {
    const vistos = new Set();
    const out = [];
    // Primero lo de él: es lo que más se equivoca y lo que más importa.
    for (const t of [...items, ...tarifario, ...BASE]) {
        const term = limpiar(t).slice(0, 48);
        const clave = term.toLowerCase();
        if (term.length < 2 || vistos.has(clave)) continue;
        vistos.add(clave);
        out.push(term);
        if (out.length >= max) break;
    }
    return out;
}

/**
 * El "prompt" de Whisper: una frase de contexto con los términos. Whisper lo
 * toma como si fuera lo que se dijo antes, así que tiene que leerse natural y
 * corto (Groq acepta unos 224 tokens).
 */
export function promptWhisper(terminos, maxChars = 700) {
    let texto = 'Presupuesto de obra en Argentina, dictado en voz alta. Términos: ';
    for (const t of terminos) {
        if (texto.length + t.length + 2 > maxChars) break;
        texto += t + ', ';
    }
    return texto.replace(/, $/, '.');
}

// Frases que Whisper "escucha" en el silencio o en el ruido: vienen de los
// subtítulos con los que se entrenó y no las dijo nadie.
const ALUCINACIONES = /(subt[ií]tulos? (realizados|por)|amara\.org|gracias por ver|suscr[ií]bete|dale like|nos vemos en el pr[oó]ximo|m[uú]sica de fondo|\[m[uú]sica\]|transcripci[oó]n por)/i;

// Probado con dos segundos de ruido: Whisper devuelve "¡Gracias!" las tres
// veces, y con confianza alta. Un "gracias" suelto no le pide nada al
// asistente, así que descartarlo no pierde ningún pedido.
const SOLO_CORTESIA = /^[¡!¿\s]*(muchas\s+)?gracias(\s+a\s+todos)?[\s.!…]*$/i;

export function esAlucinacion(texto) {
    const t = limpiar(texto);
    if (!t) return true;
    if (ALUCINACIONES.test(t) || SOLO_CORTESIA.test(t)) return true;
    // Solo puntuación o una sílaba suelta.
    return t.replace(/[^\p{L}\p{N}]/gu, '').length < 2;
}
