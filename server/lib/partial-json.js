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
