// Leer un campo de texto de un JSON que todavía se está escribiendo.
//
// El chat le pide al modelo un objeto {"reply":"...","ops":[...]}, pero para que
// la respuesta se sienta viva hay que ir mostrando el texto mientras llega. Lo
// que llega es JSON a medio escribir: {"reply":"Te simulo el desc
//
// Esta función saca el valor parcial de "reply" de ese fragmento, sin esperar a
// que el objeto cierre y sin romperse si corta en cualquier lado — incluso en la
// mitad de una secuencia de escape.

const ESCAPES = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };

/**
 * @param {string} buffer  JSON incompleto tal como viene llegando
 * @param {string} campo   nombre de la clave a leer
 * @returns {string} el valor leído hasta donde se pueda (puede ser '')
 */
export function partialString(buffer, campo = 'reply') {
    const clave = `"${campo}"`;
    const posClave = buffer.indexOf(clave);
    if (posClave === -1) return '';

    // Saltar los espacios y los dos puntos entre la clave y el valor.
    let i = posClave + clave.length;
    while (i < buffer.length && /[\s:]/.test(buffer[i])) i++;
    if (buffer[i] !== '"') return '';   // todavía no empezó el valor
    i++;

    let out = '';
    while (i < buffer.length) {
        const c = buffer[i];

        if (c === '\\') {
            const sig = buffer[i + 1];
            if (sig === undefined) break;          // el escape viene cortado: se corta acá

            if (sig === 'u') {
                const hex = buffer.slice(i + 2, i + 6);
                if (hex.length < 4) break;         // \uXXXX incompleto
                out += String.fromCharCode(parseInt(hex, 16));
                i += 6;
                continue;
            }
            out += ESCAPES[sig] ?? sig;
            i += 2;
            continue;
        }

        if (c === '"') break;                      // cerró el string: terminó el campo
        out += c;
        i++;
    }
    return out;
}

/**
 * Lo que va ANTES de un campo, ya cerrado y parseado.
 *
 * La conversación por voz pide {"pensamiento","ops","encabezado","respuesta"}
 * en ese orden. Cuando aparece la clave "respuesta", todo lo anterior ya está
 * escrito: se puede aplicar el cambio en pantalla mientras el modelo todavía
 * redacta lo que va a decir, en vez de esperar a que termine.
 *
 * Devuelve el objeto parcial, o null si todavía no se puede (o no parsea).
 */
export function objectBefore(buffer, campo) {
    const m = new RegExp(`,\s*"${campo}"\s*:`).exec(buffer);
    if (!m) return null;
    const desde = buffer.indexOf('{');
    if (desde === -1 || desde > m.index) return null;
    try {
        return JSON.parse(buffer.slice(desde, m.index) + '}');
    } catch {
        return null;
    }
}
