// Abreviaturas de las direcciones y los títulos que se dictan por voz.
//
// Dictado, "avenida Libertador 2000" llega con todas las letras, y en un
// presupuesto se escribe "Av. Libertador 2000". El prompt ya lo pide, pero el
// modelo a veces lo deja entero: estas son las que se escriben siempre igual
// y se corrigen acá. Si él pide la palabra completa, se respeta.

// Las que dependen de lo que sigue (un nombre propio o un número) miran la
// mayúscula: "barrio Rivadavia" es una dirección, "casa del barrio" no.
const REGLAS = [
    [/\bavenida\b\.?/gi, 'Av.'],
    [/\bAv\b(?!\.)/g, 'Av.'],
    [/\b(boulevard|bulevar|boulevar)\b/gi, 'Bv.'],
    [/\b[Bb]arrio\s+(?=[A-ZÁÉÍÓÚÑ0-9])/g, 'B° '],
    [/\b[Pp]asaje\s+(?=[A-ZÁÉÍÓÚÑ0-9])/g, 'Pje. '],
    [/\bn[uú]mero\s+(?=\d)/gi, 'N° '],
    [/\b[Dd]epartamento\s+(?=\d|[A-Z]\b)/g, 'Dpto. '],
    [/\b[Mm]anzana\s+(?=\d|[A-Z]\b)/g, 'Mza. '],
    [/\b[Gg]eneral\s+(?=[A-ZÁÉÍÓÚÑ])/g, 'Gral. '],
    [/\b[Dd]octora\s+(?=[A-ZÁÉÍÓÚÑ])/g, 'Dra. '],
    [/\b[Dd]octor\s+(?=[A-ZÁÉÍÓÚÑ])/g, 'Dr. '],
    [/\b[Ii]ngenier[oa]\s+(?=[A-ZÁÉÍÓÚÑ])/g, 'Ing. '],
    [/\b[Aa]rquitect[oa]\s+(?=[A-ZÁÉÍÓÚÑ])/g, 'Arq. '],
];

// Campos donde va una dirección o un título. El nombre del cliente y el
// teléfono se dejan como los dijo.
const CAMPOS = ['name', 'location', 'client_address'];

const PIDE_COMPLETO = /complet|sin abreviar|entera|entero|con todas las letras|no (lo )?abrevi/i;

export function abreviar(texto) {
    let t = String(texto || '');
    for (const [re, por] of REGLAS) t = t.replace(re, por);
    return t.replace(/\s{2,}/g, ' ').trim();
}

/** Devuelve el encabezado con las abreviaturas puestas, salvo que haya pedido lo contrario. */
export function abreviarEncabezado(encabezado, pedidos = []) {
    if (PIDE_COMPLETO.test([].concat(pedidos).join(' '))) return encabezado;
    const out = { ...encabezado };
    for (const campo of CAMPOS) {
        if (typeof out[campo] === 'string') out[campo] = abreviar(out[campo]);
    }
    return out;
}
