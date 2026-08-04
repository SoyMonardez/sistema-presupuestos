// Sacar las medidas del texto del item, para el conversor de unidades.
//
// Va en el cliente y no en el servidor a propósito: es una función de texto pura,
// sin nada de estado ni de base de datos, y los items ya están cargados en el
// navegador. Pedírsela al servidor metería un viaje de red justo en el momento
// en que se abre el modal de convertir (se nota como demora para nada).
//
// El caso que resuelve: un item ya dice "platea de H°17 0.80m x 0.50m x 0.15m",
// y para convertirlo a m² el modal pedía el espesor de nuevo, a mano, cuando ya
// estaba escrito ahí arriba.

const Medidas = (() => {
    const CM_A_M = 0.01;
    const MM_A_M = 0.001;

    const ETIQUETAS = [
        { re: /espesor|espes\.?|\besp\.?\b|\be\s*=/i, campo: 'alto' },
        { re: /alto|altura|profundidad|prof\.?/i,      campo: 'alto' },
        { re: /ancho|anch\.?/i,                        campo: 'ancho' },
        { re: /largo|long\.?|longitud|lineal/i,        campo: 'largo' },
    ];

    function aMetros(valor, unidad) {
        const n = parseFloat(String(valor).replace(',', '.'));
        if (!Number.isFinite(n)) return null;
        const u = String(unidad || '').toLowerCase();
        if (u.startsWith('cm')) return n * CM_A_M;
        if (u.startsWith('mm')) return n * MM_A_M;
        return n;
    }

    const NUM = String.raw`(\d+(?:[.,]\d+)?)\s*(cm|mm|mts?|m)?`;
    const CADENA = new RegExp(`${NUM}\\s*[x×]\\s*${NUM}(?:\\s*[x×]\\s*${NUM})?`, 'i');

    function extraer(texto) {
        const t = String(texto || '');
        if (!t.trim()) return { fuente: '' };

        const out = {};
        let fuente = '';

        const cadena = t.match(CADENA);
        if (cadena) {
            const valores = [
                aMetros(cadena[1], cadena[2]),
                aMetros(cadena[3], cadena[4]),
                cadena[5] !== undefined ? aMetros(cadena[5], cadena[6]) : null,
            ].filter(v => v !== null && v > 0);

            if (valores.length >= 2) {
                out.largo = valores[0];
                out.ancho = valores[1];
                if (valores.length >= 3) out.alto = valores[2];
                fuente = cadena[0].trim();
            }

            const despues = t.slice(t.indexOf(cadena[0]) + cadena[0].length, t.indexOf(cadena[0]) + cadena[0].length + 20);
            if (valores.length === 2 && /^\s*(de\s+)?(alto|altura|espesor)/i.test(despues)) {
                out.alto = out.ancho;
                delete out.ancho;
            }
        }

        for (const { re, campo } of ETIQUETAS) {
            // El (?:…) no es decorativo: re.source es una alternación suelta
            // ("espesor|espes\.?|…"), y pegarle el número al final sin agrupar
            // hacía que el número quedara atado SOLO a la última alternativa. Con
            // eso "espesor 15 cm" no se leía nunca — la única parte que andaba era
            // la cadena de dimensiones ("0.80m x 0.50m x 0.15m").
            const conValor = new RegExp(`(?:${re.source})\\s*:?=?\\s*${NUM}`, 'i');
            const m = t.match(conValor);
            if (!m) continue;
            const valor = aMetros(m[1], m[2]);
            if (valor === null || valor <= 0) continue;
            out[campo] = valor;
            fuente = fuente ? `${fuente}, ${m[0].trim()}` : m[0].trim();
        }

        return { ...out, fuente };
    }

    /** Qué medidas de las que hacen falta se pudieron leer del texto. */
    function medidasPara(necesarias, texto) {
        const encontradas = extraer(texto);
        const valores = {};
        for (const campo of necesarias || []) {
            if (encontradas[campo] > 0) valores[campo] = encontradas[campo];
        }
        return { valores, fuente: Object.keys(valores).length ? encontradas.fuente : '' };
    }

    return { extraer, medidasPara };
})();
