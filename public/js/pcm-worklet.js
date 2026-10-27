// AudioWorklet de la conversación por voz.
//
// Scribe (la voz a texto en vivo de ElevenLabs) pide PCM de 16 bits, mono, a
// 16 kHz. El micrófono llega a la frecuencia del aparato (44,1 o 48 kHz) y en
// float, así que acá se baja de frecuencia y se convierte. Corre en el hilo de
// audio: no traba la pantalla aunque haya animaciones.
//
// Cada ~100 ms manda al hilo principal un bloque { pcm, rms }: el audio listo
// para el WebSocket y el volumen, que usan el orbe y el detector de voz.

const DESTINO = 16000;
const MUESTRAS_POR_BLOQUE = 1600;   // 100 ms a 16 kHz

class PcmWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.paso = sampleRate / DESTINO;   // cuántas muestras de entrada por cada una de salida
        this.pos = 0;                       // posición fraccionaria dentro de la entrada
        this.bloque = new Int16Array(MUESTRAS_POR_BLOQUE);
        this.lleno = 0;
        this.sumaCuadrados = 0;
        this.cuenta = 0;
    }

    process(inputs) {
        const canal = inputs[0]?.[0];
        if (!canal) return true;

        for (let i = 0; i < canal.length; i++) {
            this.sumaCuadrados += canal[i] * canal[i];
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
                const rms = Math.sqrt(this.sumaCuadrados / Math.max(1, this.cuenta));
                this.port.postMessage({ pcm: this.bloque.buffer, rms }, [this.bloque.buffer]);
                this.bloque = new Int16Array(MUESTRAS_POR_BLOQUE);
                this.lleno = 0;
                this.sumaCuadrados = 0;
                this.cuenta = 0;
            }
            this.pos += this.paso;
        }
        this.pos -= canal.length;
        return true;
    }
}

registerProcessor('pcm-worklet', PcmWorklet);
