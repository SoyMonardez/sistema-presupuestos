// El oído de la conversación por voz.
//
// A diferencia de Voice (el dictado de siempre, que graba y transcribe al
// final), esto escucha de corrido mientras dure el modo conversación y va
// avisando dos cosas:
//
//   onParcial(texto)  → lo que está diciendo ahora, palabra por palabra. Puede
//                       cambiar mientras habla; sirve para el subtítulo.
//   onSegmento(texto) → un pedazo ya cerrado (hizo una pausa). Es lo que se
//                       manda a cortar y a pensar.
//
// Por dónde transcribe:
//   - En vivo: Scribe de ElevenLabs por WebSocket, con un token de un solo uso
//     que da el servidor. Es lo que hace que el texto aparezca mientras habla.
//   - Respaldo: si no hay ElevenLabs o el WebSocket falla, se cortan los
//     pedazos acá por silencio y se transcriben con Groq Whisper
//     (API.aiTranscribe). Sin subtítulo en vivo, pero anda.
//
// El audio sale de un AudioWorklet (pcm-worklet.js) que ya lo entrega en el
// formato que pide Scribe y con el volumen medido.

const Escucha = (() => {
    const URL_SCRIBE = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
    const UMBRAL_VOZ = 0.015;       // RMS 0..1; ver el mismo umbral en voice.js
    const COLA_VOZ_MS = 700;        // cuánto sigue "hablando" después del último sonido
    const SILENCIO_SEGMENTO_MS = 900;   // respaldo: pausa que cierra un pedazo
    const PREVIO_MS = 300;          // respaldo: audio de antes de que arranque la voz

    let stream = null;
    let ctx = null;
    let moduloEn = null;            // en qué AudioContext ya se cargó el worklet
    let nodo = null;
    let ws = null;
    let modo = null;                // 'vivo' | 'respaldo'
    let activa = false;
    let cb = {};

    let nivelActual = 0;
    let ultimaVoz = 0;
    let hablaba = false;

    // Respaldo: el pedazo que se está juntando para mandar a Whisper.
    let previo = [];
    let juntando = null;

    function soportada() {
        return Boolean(navigator.mediaDevices?.getUserMedia && window.AudioWorkletNode);
    }

    /**
     * @param {object} c
     * @param {(texto:string)=>void} [c.onParcial]
     * @param {(texto:string)=>void} [c.onSegmento]
     * @param {(habla:boolean)=>void} [c.onHabla]   arrancó o paró de hablar
     * @param {(modo:'vivo'|'respaldo')=>void} [c.onModo]
     * @param {(msg:string)=>void} [c.onError]
     */
    async function iniciar(c = {}) {
        if (activa) return;
        cb = c;
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                // Sin cancelación de eco se escucharía a sí mismo hablando por
                // el parlante y se contestaría solo.
                audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
            });
        } catch (err) {
            cb.onError?.(err.name === 'NotAllowedError' || err.name === 'SecurityError'
                ? 'Permití el acceso al micrófono (candado en la barra de direcciones).'
                : err.name === 'NotFoundError'
                    ? 'No se encontró ningún micrófono.'
                    : 'No se pudo acceder al micrófono: ' + err.name);
            return false;
        }

        activa = true;
        ctx = Sonidos.contexto();
        try {
            if (moduloEn !== ctx) {
                await ctx.audioWorklet.addModule('/js/pcm-worklet.js');
                moduloEn = ctx;
            }
            const fuente = ctx.createMediaStreamSource(stream);
            nodo = new AudioWorkletNode(ctx, 'pcm-worklet');
            nodo.port.onmessage = (e) => alRecibirAudio(e.data);
            // El worklet no produce sonido, pero tiene que estar conectado a la
            // salida para que el navegador lo haga correr. Con ganancia 0, mudo.
            const mudo = ctx.createGain();
            mudo.gain.value = 0;
            fuente.connect(nodo).connect(mudo).connect(ctx.destination);
        } catch (err) {
            detener();
            cb.onError?.('Este navegador no deja procesar el micrófono en vivo.');
            return false;
        }

        if (!(await conectarScribe())) usarRespaldo();
        return true;
    }

    // ---------- En vivo: Scribe ----------
    async function conectarScribe() {
        let token;
        try {
            ({ token } = await API.vozToken());
        } catch {
            return false;
        }
        if (!activa) return false;

        const params = new URLSearchParams({
            model_id: 'scribe_v2_realtime',
            token,
            audio_format: 'pcm_16000',
            language_code: 'es',
            // Que Scribe cierre el pedazo solo cuando hace una pausa. Corto, para
            // que el pedido salga rápido; el cortador junta lo que quede partido.
            commit_strategy: 'vad',
            vad_silence_threshold_secs: '0.8',
        });

        return new Promise((resolver) => {
            let arranco = false;
            const socket = new WebSocket(`${URL_SCRIBE}?${params}`);
            ws = socket;
            const plazo = setTimeout(() => { if (!arranco) { socket.close(); resolver(false); } }, 6000);

            socket.onmessage = (e) => {
                let msg;
                try { msg = JSON.parse(e.data); } catch { return; }
                switch (msg.message_type) {
                    case 'session_started':
                        arranco = true;
                        clearTimeout(plazo);
                        modo = 'vivo';
                        cb.onModo?.('vivo');
                        resolver(true);
                        break;
                    case 'partial_transcript':
                        if (msg.text?.trim()) cb.onParcial?.(msg.text.trim());
                        break;
                    case 'committed_transcript':
                        if (msg.text?.trim()) cb.onSegmento?.(msg.text.trim());
                        else cb.onParcial?.('');
                        break;
                    default:
                        if (msg.error) {
                            console.warn('[escucha] Scribe:', msg.message_type, msg.error);
                            if (!arranco) { clearTimeout(plazo); resolver(false); }
                        }
                }
            };
            socket.onerror = () => { if (!arranco) { clearTimeout(plazo); resolver(false); } };
            socket.onclose = () => {
                if (ws !== socket) return;
                ws = null;
                if (!arranco) { clearTimeout(plazo); resolver(false); return; }
                // Se cortó a mitad de la conversación (red, límite de sesión):
                // se intenta reconectar con un token nuevo y, si no, respaldo.
                if (activa && modo === 'vivo') {
                    modo = null;
                    conectarScribe().then(ok => { if (!ok && activa) usarRespaldo(); });
                }
            };
        });
    }

    function enviarAScribe(pcm) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: aBase64(pcm),
            commit: false,
            sample_rate: 16000,
        }));
    }

    function aBase64(buffer) {
        const bytes = new Uint8Array(buffer);
        let bin = '';
        for (let i = 0; i < bytes.length; i += 0x8000) {
            bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        return btoa(bin);
    }

    // ---------- Respaldo: cortar por silencio y mandar a Whisper ----------
    function usarRespaldo() {
        if (!activa) return;
        modo = 'respaldo';
        cb.onModo?.('respaldo');
    }

    function juntarParaRespaldo(pcm, hayVoz, ahora) {
        const bloque = new Int16Array(pcm);
        if (!juntando) {
            previo.push(bloque);
            while (previo.length > PREVIO_MS / 100) previo.shift();
            if (hayVoz) { juntando = previo.slice(); previo = []; }
            return;
        }
        juntando.push(bloque);
        const silencio = ahora - ultimaVoz;
        const largo = juntando.length / 10;   // segundos
        if (silencio >= SILENCIO_SEGMENTO_MS || largo >= 30) {
            const pedazo = juntando;
            juntando = null;
            // Menos de medio segundo de audio es un ruido, no un pedido.
            if (pedazo.length >= 5) transcribirPedazo(pedazo);
        }
    }

    async function transcribirPedazo(bloques) {
        try {
            const { text } = await API.aiTranscribe(aWav(bloques));
            if (activa && text?.trim()) cb.onSegmento?.(text.trim());
        } catch {
            // "No se entendió el audio": normal con ruidos sueltos. Se ignora.
        }
    }

    function aWav(bloques) {
        const muestras = bloques.reduce((n, b) => n + b.length, 0);
        const buf = new ArrayBuffer(44 + muestras * 2);
        const v = new DataView(buf);
        const texto = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
        texto(0, 'RIFF'); v.setUint32(4, 36 + muestras * 2, true); texto(8, 'WAVE');
        texto(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
        v.setUint32(24, 16000, true); v.setUint32(28, 32000, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
        texto(36, 'data'); v.setUint32(40, muestras * 2, true);
        let o = 44;
        for (const b of bloques) for (let i = 0; i < b.length; i++, o += 2) v.setInt16(o, b[i], true);
        return new Blob([buf], { type: 'audio/wav' });
    }

    // ---------- Cada bloque de 100 ms ----------
    function alRecibirAudio({ pcm, rms }) {
        if (!activa) return;
        const ahora = Date.now();
        nivelActual = Math.min(1, rms * 6);

        const hayVoz = rms > UMBRAL_VOZ;
        if (hayVoz) ultimaVoz = ahora;
        const habla = ahora - ultimaVoz < COLA_VOZ_MS;
        if (habla !== hablaba) {
            hablaba = habla;
            cb.onHabla?.(habla);
        }

        if (modo === 'vivo') enviarAScribe(pcm);
        else if (modo === 'respaldo') juntarParaRespaldo(pcm, hayVoz, ahora);
    }

    function detener() {
        activa = false;
        modo = null;
        const socket = ws;
        ws = null;
        try { socket?.close(); } catch {}
        try { nodo?.disconnect(); } catch {}
        nodo = null;
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        previo = [];
        juntando = null;
        nivelActual = 0;
        hablaba = false;
    }

    const nivel = () => nivelActual;
    const estaHablando = () => hablaba;
    const modoActual = () => modo;

    return { soportada, iniciar, detener, nivel, estaHablando, modoActual };
})();
