// AudioWorklet de la conversación por voz.
//
// Scribe (la voz a texto en vivo de ElevenLabs) pide PCM de 16 bits, mono, a
// 16 kHz. El micrófono llega a la frecuencia del aparato (44,1 o 48 kHz) y en
// float, así que acá se baja de frecuencia y se convierte. Corre en el hilo de
// audio: no traba la pantalla aunque haya animaciones.
//
// Cada ~100 ms manda al hilo principal un bloque { pcm, rms, rmsVoz }: el audio
// listo para el WebSocket, el volumen (para el orbe) y el volumen en la banda
// de la voz (para el detector de voz).
//
// rmsVoz pasa por un filtro de 200 a 4000 Hz. Afuera queda casi todo el ruido
// de un gimnasio o una obra (el bombo y el bajo de la música, golpes, motores),
// y la voz sigue adentro. El audio que va a Scribe no se filtra: eso lo limpia
// el navegador con su supresión de ruido y Scribe se arregla mejor con todo.

const DESTINO = 16000;
const MUESTRAS_POR_BLOQUE = 1600;   // 100 ms a 16 kHz
const VOZ_DESDE_HZ = 200;
const VOZ_HASTA_HZ = 4000;

/** Filtro biquad de Butterworth (fórmulas del "Audio EQ Cookbook"). */
function biquad(tipo, frecuencia) {
    const w0 = 2 * Math.PI * frecuencia / sampleRate;
    const cos = Math.cos(w0);
    const alfa = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alfa;
    const b = tipo === 'agudos'
        ? [(1 + cos) / 2, -(1 + cos), (1 + cos) / 2]   // deja pasar lo agudo
        : [(1 - cos) / 2, 1 - cos, (1 - cos) / 2];     // deja pasar lo grave
    const b0 = b[0] / a0, b1 = b[1] / a0, b2 = b[2] / a0;
    const a1 = -2 * cos / a0, a2 = (1 - alfa) / a0;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return (x) => {
        const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
    };
}

class PcmWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.paso = sampleRate / DESTINO;   // cuántas muestras de entrada por cada una de salida
        this.pos = 0;                       // posición fraccionaria dentro de la entrada
        this.bloque = new Int16Array(MUESTRAS_POR_BLOQUE);
        this.lleno = 0;
        this.sumaCuadrados = 0;
        this.sumaCuadradosVoz = 0;
        this.cuenta = 0;
        this.sinGraves = biquad('agudos', VOZ_DESDE_HZ);
        this.sinAgudos = biquad('graves', Math.min(VOZ_HASTA_HZ, sampleRate * 0.45));
    }

    process(inputs) {
        const canal = inputs[0]?.[0];
        if (!canal) return true;

        for (let i = 0; i < canal.length; i++) {
            this.sumaCuadrados += canal[i] * canal[i];
            const voz = this.sinAgudos(this.sinGraves(canal[i]));
            this.sumaCuadradosVoz += voz * voz;
            this.cuenta++;
        }

        // Interpolación lineal entre muestras vecinas: alcanza de sobra para voz.
        while (this.pos < canal.length) {
            const i = Math.floor(this.pos);
            const f = this.pos - i;
            const sig = i + 1 < canal.length ? canal[i + 1] : canal[i];
            const v = canal[i] * (1 - f) + sig * f;
            const s = Math.max(-1, Math.min(1, v));
            this.bloque[this.lleno++] = s < 0 ? s * 0x8000 : s * 0x7fff;

            if (this.lleno === MUESTRAS_POR_BLOQUE) {
                const n = Math.max(1, this.cuenta);
                const rms = Math.sqrt(this.sumaCuadrados / n);
                const rmsVoz = Math.sqrt(this.sumaCuadradosVoz / n);
                this.port.postMessage({ pcm: this.bloque.buffer, rms, rmsVoz }, [this.bloque.buffer]);
                this.bloque = new Int16Array(MUESTRAS_POR_BLOQUE);
                this.lleno = 0;
                this.sumaCuadrados = 0;
                this.sumaCuadradosVoz = 0;
                this.cuenta = 0;
            }
            this.pos += this.paso;
        }
        this.pos -= canal.length;
        return true;
    }
}

registerProcessor('pcm-worklet', PcmWorklet);
