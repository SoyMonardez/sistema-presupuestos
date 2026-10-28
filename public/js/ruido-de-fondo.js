// Separar la voz del ruido de fondo.
//
// El detector de "dejó de hablar" comparaba el volumen contra un umbral fijo.
// En una habitación anda, pero en un gimnasio o en una obra la música y las
// máquinas ya están por encima de ese umbral todo el tiempo: para el detector
// nunca se calla, así que el dictado no se mandaba y la conversación no pasaba
// a pensar hasta que paraba el ruido.
//
// Acá el umbral se acomoda al lugar. Se mira el volumen de los últimos segundos
// y se toma uno de los más bajos (el percentil 10): eso es el ruido de fondo,
// porque aunque hable de corrido entre palabra y palabra el volumen baja al
// nivel del ruido. Hay voz cuando el volumen pasa ese piso por un margen.
//
// El primer segundo y medio no se le cree al piso: con tan poco escuchado, si
// arrancó a hablar apenas tocó el micrófono, el "piso" sería su propia voz.
//
// Por qué un percentil y no un promedio que va siguiendo al volumen: el
// promedio se lo come la voz misma. Si habla diez segundos seguidos, el piso
// sube hasta su voz y la deja de reconocer. El percentil bajo no se mueve
// mientras haya huecos entre palabras, y siempre los hay.

const RuidoDeFondo = (() => {
    /**
     * @param {object} o
     * @param {number} o.minimo       umbral de siempre: en silencio de verdad manda este
     * @param {number} [o.factor]     cuánto por encima del ruido tiene que estar la voz
     * @param {number} [o.ventanaMs]  cuánto para atrás se mira para medir el ruido
     * @param {number} [o.percentil]  qué tan abajo se toma el piso (0..1)
     * @param {number} [o.aprendeMs]  cuánto escuchar antes de creerle al piso
     */
    function crear({ minimo, factor = 2.5, ventanaMs = 4000, percentil = 0.1, aprendeMs = 1500 }) {
        let muestras = [];          // [{ volumen, t }]
        let desde = null;           // cuándo llegó la primera muestra
        let umbral = minimo;

        return {
            /** @returns {boolean} true si este volumen es voz y no el ruido del lugar */
            esVoz(volumen, ahora) {
                // Se compara contra el piso de lo que vino antes: el sonido de
                // ahora no puede subirse su propia vara.
                const voz = volumen > umbral;
                if (desde === null) desde = ahora;
                muestras.push({ volumen, t: ahora });
                while (muestras.length > 1 && ahora - muestras[0].t > ventanaMs) muestras.shift();
                if (ahora - desde >= aprendeMs) {
                    const orden = muestras.map(m => m.volumen).sort((a, b) => a - b);
                    const piso = orden[Math.floor((orden.length - 1) * percentil)];
                    umbral = Math.max(minimo, piso * factor);
                }
                return voz;
            },
            umbral: () => umbral,
        };
    }

    return { crear };
})();

// Para poder probarlo desde node (ver voice.test.mjs).
if (typeof module !== 'undefined') module.exports = { RuidoDeFondo };
