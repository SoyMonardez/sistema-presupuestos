// Dictado por voz: graba con MediaRecorder y transcribe en el servidor (Groq Whisper).
// Mucho más confiable que la Web Speech API, y funciona en cualquier navegador moderno.
//
// Hace tres cosas mientras se graba:
//
//   1. Va entregando el audio ACUMULADO cada pocos segundos (`onParcial`), para
//      transcribirlo y mostrar el texto mientras la persona todavía está
//      hablando. No espera a que suelte el botón.
//
//   2. Escucha el volumen del micrófono y avisa cuando se hizo silencio
//      (`onSilencio`), para poder mandar el mensaje solo.
//
//   3. Al final entrega el audio completo (`onStop`), que es el que vale.
//
// Por qué el parcial manda el audio acumulado y no solo el pedazo nuevo: en webm
// el primer bloque lleva el encabezado y los demás no se pueden decodificar
// sueltos. Mandando todo desde el principio siempre es un audio válido. Para
// dictados de unos segundos el costo de repetirlo es despreciable.
//
// Antes esto se apoyaba en el reconocimiento de voz del navegador para la vista
// previa. Se sacó: Brave lo trae desactivado (es un servicio de Google) y varios
// navegadores lo tienen a medias, así que en la práctica no aparecía nada y el
// error se perdía en silencio. Whisper no depende del navegador.

const Voice = (() => {
    let recorder = null;
    let stream = null;
    let chunks = [];
    let active = false;
    let timerInterval = null;

    // Análisis de volumen para detectar el silencio
    let audioCtx = null;
    let analizador = null;
    let silencioInterval = null;

    const MS_POR_BLOQUE   = 1000;   // cada cuánto MediaRecorder suelta audio
    const MS_ENTRE_PARCIALES = 2500;  // cada cuánto se pide una transcripción parcial
    const TOPE_SEGUNDOS   = 120;    // tope por dictado

    // Umbral de "hay voz". Es volumen medio (RMS) sobre 0..1; el ruido de una
    // habitación queda bien por debajo y una voz normal bien por encima.
    const UMBRAL_VOZ = 0.012;

    function isSupported() {
        return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    }

    function pickMimeType() {
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
        return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
    }

    /**
     * @param {object} cb
     * @param {(segundos:number)=>void}   [cb.onTick]
     * @param {(audio:Blob)=>void}        [cb.onParcial]   audio acumulado, para ir mostrando
     * @param {()=>void}                  [cb.onSilencio]  dejó de hablar
     * @param {(audio:Blob)=>void}        [cb.onStop]      audio completo
     * @param {(msg:string)=>void}        [cb.onError]
     * @param {number} [cb.silencioMs]    cuánto silencio hace falta para avisar
     */
    async function start({ onTick, onStop, onError, onParcial, onSilencio, silencioMs = 0 }) {
        if (active) return;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch (err) {
            onError?.(err.name === 'NotAllowedError' || err.name === 'SecurityError'
                ? 'Permití el acceso al micrófono (candado en la barra de direcciones).'
                : err.name === 'NotFoundError'
                    ? 'No se encontró ningún micrófono.'
                    : 'No se pudo acceder al micrófono: ' + err.name);
            return;
        }

        chunks = [];
        active = true;
        const mimeType = pickMimeType();
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        const tipo = () => recorder.mimeType || mimeType || 'audio/webm';

        let ultimoParcial = 0;
        recorder.ondataavailable = (e) => {
            if (!e.data.size) return;
            chunks.push(e.data);
            if (!onParcial) return;
            const ahora = Date.now();
            if (ahora - ultimoParcial < MS_ENTRE_PARCIALES) return;
            ultimoParcial = ahora;
            // Todo lo grabado hasta acá: siempre es un audio válido (ver arriba).
            onParcial(new Blob(chunks, { type: tipo() }));
        };

        recorder.onstop = () => {
            clearInterval(timerInterval);
            pararEscuchaDeSilencio();
            stream.getTracks().forEach(t => t.stop());
            active = false;
            onStop?.(new Blob(chunks, { type: tipo() }));
        };

        // Con timeslice, MediaRecorder va soltando audio en vez de guardarlo
        // todo para el final. Es lo que permite transcribir mientras habla.
        recorder.start(MS_POR_BLOQUE);

        const startedAt = Date.now();
        timerInterval = setInterval(() => {
            const secs = Math.floor((Date.now() - startedAt) / 1000);
            onTick?.(secs);
            if (secs >= TOPE_SEGUNDOS) stop();
        }, 500);

        if (silencioMs > 0 && onSilencio) escucharSilencio(silencioMs, onSilencio);
    }

    /**
     * La decisión de "ya dejó de hablar", separada de los temporizadores y del
     * micrófono para poder probarla sola (ver voice.test.mjs). Le vas pasando el
     * volumen y te dice cuándo dar por terminado.
     *
     * Dos reglas que parecen obvias y no lo son:
     *  - No cuenta hasta haber escuchado voz al menos una vez. Si no, daría por
     *    terminado apenas arranca, cuando todavía no dijo nada.
     *  - Cualquier sonido reinicia la cuenta: las pausas al pensar en medio de
     *    una frase no tienen que cortar el dictado.
     */
    function crearDetectorDeSilencio({ umbral = UMBRAL_VOZ, silencioMs }) {
        let huboVoz = false;
        let calladoDesde = 0;
        return {
            /** @returns {boolean} true cuando hay que cortar */
            medir(volumen, ahora) {
                if (volumen > umbral) { huboVoz = true; calladoDesde = 0; return false; }
                if (!huboVoz) return false;
                if (!calladoDesde) { calladoDesde = ahora; return false; }
                return ahora - calladoDesde >= silencioMs;
            },
        };
    }

    /**
     * Escucha el volumen del micrófono y avisa cuando dejó de hablar.
     * Va con el Web Audio API y no con el reconocimiento del navegador porque
     * esto anda en todos lados, incluido Brave.
     */
    function escucharSilencio(silencioMs, onSilencio) {
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            audioCtx = new Ctx();
            // Puede arrancar suspendido si el navegador no vio un gesto todavía;
            // acá siempre venimos de un toque, pero resume() no cuesta nada.
            audioCtx.resume?.().catch(() => {});
            const fuente = audioCtx.createMediaStreamSource(stream);
            analizador = audioCtx.createAnalyser();
            analizador.fftSize = 1024;
            fuente.connect(analizador);

            const datos = new Float32Array(analizador.fftSize);
            const detector = crearDetectorDeSilencio({ silencioMs });

            silencioInterval = setInterval(() => {
                if (!active) return;
                analizador.getFloatTimeDomainData(datos);
                let suma = 0;
                for (const v of datos) suma += v * v;
                const volumen = Math.sqrt(suma / datos.length);

                if (detector.medir(volumen, Date.now())) {
                    pararEscuchaDeSilencio();
                    onSilencio();
                }
            }, 150);
        } catch {
            // Sin detección de silencio se sigue pudiendo dictar a mano.
        }
    }

    function pararEscuchaDeSilencio() {
        clearInterval(silencioInterval);
        silencioInterval = null;
        analizador = null;
        if (audioCtx) { try { audioCtx.close(); } catch {} audioCtx = null; }
    }

    function stop() {
        if (recorder && active) recorder.stop();
    }

    function isActive() { return active; }

    return { isSupported, start, stop, isActive, crearDetectorDeSilencio };
})();

// Para poder probar el detector desde node (ver voice.test.mjs).
if (typeof module !== 'undefined') module.exports = { Voice };
