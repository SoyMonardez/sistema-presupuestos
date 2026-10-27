// El cortador de la conversación por voz.
//
// Lo que llega del micrófono es un chorro de texto partido donde el dictado hizo
// una pausa, no donde termina un pedido. "Agregá demolición… uno, metro
// cuadrado… a 320 mil" puede llegar en tres pedazos, y "poné el título Casa
// Pérez y agregá un contrapiso" trae dos pedidos en uno. Antes de pensar hay
// que cortar bien: qué parte ya es un pedido entero y qué parte todavía viene.
//
// Ese corte lo hace un modelo rápido (Groq), pero las respuestas cortas que se
// repiten todo el tiempo —"sí", "no", "deshacé", "terminamos"— se resuelven acá
// con una regex: no tiene sentido gastar una vuelta de red en un "dale".

// Tienen que cubrir el texto ENTERO, igual que CONFIRMA en public/js/chat.js:
// "sí, pero bajale el precio" no es una confirmación, es un pedido nuevo.
const FIN = '[\\s.,!¡¿?]*$';
const ATAJOS = [
    ['confirmar_todo', new RegExp(`^\\s*(s[ií]+,?\\s*)?(a todo|todo|aplic[aá] todo|aplicalos todos|todos|hac[eé] todo)${FIN}`, 'i')],
    ['confirmar',      new RegExp(`^\\s*(s[ií]+|dale|ok(ey)?|listo|aplica(lo|r)?|aplic[aá]|hacelo|obvio|correcto|perfecto|va|vale|confirmo|adelante|de una|s[ií],? dale|s[ií],? hacelo|s[ií],? aplicalo|met[eé]lo|agregalo|cargalo)${FIN}`, 'i')],
    ['rechazar',       new RegExp(`^\\s*(no|nel|nop|dej[aá](lo)?|dejalo as[ií]|olvidalo|cancel(a|ar|alo|á)?|mejor no|no,? dejalo|nada)${FIN}`, 'i')],
    ['deshacer',       new RegExp(`^\\s*((dale,?\\s*)?(deshac[eé](lo)?|deshacer|volv[eé] (para )?atr[aá]s|sac[aá] lo [uú]ltimo|borr[aá] lo [uú]ltimo)(\\s+(eso|lo [uú]ltimo|el [uú]ltimo))?)${FIN}`, 'i')],
    ['salir',          new RegExp(`^\\s*((listo,?\\s*|bueno,?\\s*)?(terminamos|termin[eé]|chau|nada m[aá]s|eso es todo|sal[ií](r)?( del modo)?|cerr[aá]( el modo)?|apag[aá]te)(,?\\s*gracias)?|gracias,? (eso es todo|terminamos|chau))${FIN}`, 'i')],
];

/** Si el texto es una de las respuestas cortas, devuelve su tipo; si no, null. */
export function atajo(texto) {
    const t = String(texto || '').trim();
    if (!t || t.length > 60) return null;
    for (const [tipo, re] of ATAJOS) {
        if (re.test(t)) return tipo;
    }
    return null;
}

// Palabras con las que nadie termina un pedido: si el texto corta ahí, sigue.
const COLGADO = /\b(a|al|de|del|con|y|e|o|en|por|para|el|la|los|las|un|una|que|es|son|sale|salen|cuesta|precio|cantidad|medida|tipo|unos|unas|como|más|mas|menos|x)[\s,.…-]*$/i;

export function quedaColgado(texto) {
    return COLGADO.test(String(texto || '').trim());
}

// ¿Pidió que el asistente ponga precios por su cuenta?
const PIDE_ESTIMAR = /estim|precio de mercado|a costo|costo directo|calcul[aá]le?s? (el |un )?precio|ponele?s? (un )?precio|inventale?s?|sac[aá]le?s? (el |un )?precio/i;

/**
 * Por voz, un precio que él no dijo no se inventa: quedaría en el presupuesto
 * sin que nadie lo haya mirado, porque él dicta con la vista en otro lado. El
 * prompt ya lo pide, pero el modelo a veces estima igual; acá se pone en 0
 * todo precio estimado (los que traen "es_costo_directo") salvo que él haya
 * pedido estimar. Los del tarifario no traen esa marca y pasan tal cual.
 *
 * Devuelve las ops corregidas y los nombres de los items que quedaron sin precio.
 */
export function quitarEstimados(rawOps, pedidos) {
    const ops = Array.isArray(rawOps) ? rawOps : [];
    if (PIDE_ESTIMAR.test((pedidos || []).join(' '))) return { ops, sinPrecio: [] };

    const sinPrecio = [];
    const corregidas = ops.map(op => {
        if (String(op?.action).toLowerCase() !== 'add' || !op.item) return op;
        const estimado = op.item.es_costo_directo === true || op.item.costo_directo === true;
        const nombre = String(op.item.name || '').trim();
        if (!estimado && Number(op.item.unit_price) > 0) return op;
        if (nombre) sinPrecio.push(nombre);
        if (!estimado) return op;
        const { es_costo_directo, costo_directo, ...item } = op.item;
        return { ...op, item: { ...item, unit_price: 0 } };
    });
    return { ops: corregidas, sinPrecio };
}

const TIPOS = new Set(['pedido', 'confirmar', 'confirmar_todo', 'rechazar', 'deshacer', 'salir']);

/**
 * Valida lo que devolvió el modelo. Si viene roto, se arma la versión segura:
 * todo lo dictado es un solo pedido, así no se pierde nada de lo que dijo.
 */
export function normalizarCorte(raw, textoCompleto, { final = false } = {}) {
    const instrucciones = (Array.isArray(raw?.instrucciones) ? raw.instrucciones : [])
        .slice(0, 20)
        .map(i => ({
            texto: String(i?.texto || '').trim().slice(0, 1500),
            tipo: TIPOS.has(i?.tipo) ? i.tipo : 'pedido',
        }))
        .filter(i => i.texto);

    let resto = String(raw?.resto || '').trim().slice(0, 1500);
    const acuse = String(raw?.acuse || '').trim().slice(0, 80);

    // Si el modelo no devolvió nada útil, que no se pierda el dictado.
    if (!instrucciones.length && !resto) {
        const t = String(textoCompleto || '').trim();
        if (t) {
            if (final) instrucciones.push({ texto: t, tipo: atajo(t) || 'pedido' });
            else resto = t;
        }
    }

    // El modelo rápido a veces da por completo un pedido que termina colgado
    // ("…18 metros cuadrados a"): si se manda así, el precio llega en el
    // pedido siguiente y queda como otro item. Esa regla no se le deja al
    // modelo: si el último pedido termina en una palabra que pide continuación,
    // vuelve a quedar esperando.
    if (!final && !resto && instrucciones.length) {
        const ultimo = instrucciones[instrucciones.length - 1];
        if (ultimo.tipo === 'pedido' && quedaColgado(ultimo.texto)) {
            resto = instrucciones.pop().texto;
        }
    }

    // Cuando se cerró el turno (pasó un rato sin que hable), lo que quedaba
    // esperando ya no va a completarse: se manda como está.
    if (final && resto) {
        instrucciones.push({ texto: resto, tipo: atajo(resto) || 'pedido' });
        resto = '';
    }

    return { instrucciones, resto, acuse };
}
