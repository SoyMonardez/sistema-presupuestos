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
    // RMS 0..1 en la banda de la voz (rmsVoz del worklet); ver el mismo umbral
    // en voice.js. Es el mínimo: con ruido de fondo sube solo (ruido-de-fondo.js).
    const UMBRAL_VOZ = 0.012;
    // Con ruido de fondo el VAD de Scribe puede no cerrar nunca el pedazo: para
    // él la música también es voz. Si el texto en vivo no cambia en este rato,
    // ya terminó de hablar y se le pide que lo cierre.
    const PARCIAL_QUIETO_MS = 1600;
    const COLA_VOZ_MS = 700;        // cuánto sigue "hablando" después del último sonido
    const SILENCIO_SEGMENTO_MS = 900;   // respaldo: pausa que cierra un pedazo
    const PREVIO_MS = 300;          // respaldo: audio de antes de que arranque la voz
    // Respaldo: cuántos bloques de 100 ms con voz hacen falta para mandar un
    // pedazo. Menos que eso es un golpe, una tos o el eco del parlante, y
    // Whisper sobre eso inventa frases.
    const MIN_BLOQUES_CON_VOZ = 4;

    let stream = null;
    let ctx = null;
    let moduloEn = null;            // en qué AudioContext ya se cargó el worklet
    let nodo = null;
    let fuente = null;              // el micrófono conectado al worklet
    let micPausado = false;
    let reabriendo = null;
    let ws = null;
    let modo = null;                // 'vivo' | 'respaldo'
    let activa = false;
    let cb = {};

    let nivelActual = 0;
    let ultimaVoz = 0;
    let hablaba = false;
    let ruido = null;               // el piso de ruido del lugar (ver ruido-de-fondo.js)

    // En vivo: el último texto parcial que todavía no se cerró.
    let parcialPendiente = '';
    let parcialDesde = 0;
    let cierreEnviado = false;      // ya se pidió cerrar este parcial
    let sinCierreManual = false;    // Scribe rechazó el cierre a mano: no pedirlo más
    let sinFiltroFondo = false;     // Scribe rechazó filter_background_audio

    // Respaldo: el pedazo que se está juntando para mandar a Whisper.
    let previo = [];
    let juntando = null;
    let bloquesConVoz = 0;
    let presupuesto = null;         // id del presupuesto, para el vocabulario
    let sinTerminos = false;        // Scribe rechazó los keyterms: no mandarlos más

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
     * @param {number} [c.presupuesto]  id del presupuesto abierto (vocabulario)
     */
    async function iniciar(c = {}) {
        if (activa) return;
        cb = c;
        presupuesto = c.presupuesto || null;
        try {
            stream = await pedirMicrofono();
        } catch (err) {
            cb.onError?.(err.name === 'NotAllowedError' || err.name === 'SecurityError'
                ? 'Permití el acceso al micrófono (candado en la barra de direcciones).'
                : err.name === 'NotFoundError'
                    ? 'No se encontró ningún micrófono.'
                    : 'No se pudo acceder al micrófono: ' + err.name);
            return false;
        }

        activa = true;
        ruido = RuidoDeFondo.crear({ minimo: UMBRAL_VOZ });
        ctx = Sonidos.contexto();
        try {
            if (moduloEn !== ctx) {
                await ctx.audioWorklet.addModule('/js/pcm-worklet.js');
                moduloEn = ctx;
            }
            nodo = new AudioWorkletNode(ctx, 'pcm-worklet');
            nodo.port.onmessage = (e) => alRecibirAudio(e.data);
            // El worklet no produce sonido, pero tiene que estar conectado a la
            // salida para que el navegador lo haga correr. Con ganancia 0, mudo.
            const mudo = ctx.createGain();
            mudo.gain.value = 0;
            nodo.connect(mudo).connect(ctx.destination);
            fuente = ctx.createMediaStreamSource(stream);
            fuente.connect(nodo);
        } catch (err) {
            detener();
            cb.onError?.('Este navegador no deja procesar el micrófono en vivo.');
            return false;
        }

        if (!(await conectarScribe())) usarRespaldo();
        return true;
    }

    // ---------- Micrófono abierto o en pausa (altavoz del celular) ----------
    // Con el micrófono capturando, el celular se pone en "modo llamada" y saca
    // el sonido por el parlante chico de la oreja, bajito. Ni Android ni iPhone
    // dejan que una página fuerce el altavoz con el micrófono abierto. Lo que sí
    // funciona: soltar el micrófono mientras habla el asistente y volver a
    // abrirlo cuando termina. Lo decide conversacion.js (solo en celulares).
    function sesionDeAudio(tipo) {
        // Safari: pedirle "reproducción" mientras habla, para que vaya al altavoz.
        try { if (navigator.audioSession) navigator.audioSession.type = tipo; } catch {}
    }

    function pedirMicrofono() {
        sesionDeAudio('auto');
        return navigator.mediaDevices.getUserMedia({
            // Sin cancelación de eco se escucharía a sí mismo hablando por
            // el parlante y se contestaría solo.
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
        });
    }

    /** Suelta el micrófono (el WebSocket sigue abierto, sin mandar nada). */
    function pausarMic() {
        if (!activa || micPausado) return;
        micPausado = true;
        try { fuente?.disconnect(); } catch {}
        fuente = null;
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        juntando = null;
        bloquesConVoz = 0;
        nivelActual = 0;
        if (hablaba) { hablaba = false; cb.onHabla?.(false); }
        sesionDeAudio('playback');
    }

    /** Vuelve a abrir el micrófono. Devuelve false si no se pudo. */
    async function reanudarMic() {
        if (!activa || !micPausado) return true;
        if (reabriendo) return reabriendo;
        reabriendo = (async () => {
            try {
                const nuevo = await pedirMicrofono();
                if (!activa) { nuevo.getTracks().forEach(t => t.stop()); return false; }
                stream = nuevo;
                fuente = ctx.createMediaStreamSource(stream);
                fuente.connect(nodo);
                micPausado = false;
                return true;
            } catch {
                cb.onError?.('No se pudo volver a abrir el micrófono. Tocá el orbe para seguir.');
                return false;
            } finally {
                reabriendo = null;
            }
        })();
        return reabriendo;
    }

    // ---------- En vivo: Scribe ----------
    async function conectarScribe() {
        let token, keyterms = [];
        try {
            ({ token, keyterms = [] } = await API.vozToken(presupuesto));
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
        // Que separe la voz de quien habla del ruido de atrás (música, gente,
        // máquinas): con eso el VAD se da cuenta de que se calló aunque el
        // ruido siga.
        if (!sinFiltroFondo) params.set('filter_background_audio', 'true');
        // Las palabras de su obra y su tarifario: Scribe las prefiere al dudar.
        if (!sinTerminos) for (const t of keyterms) params.append('keyterms', t);
        const conTerminos = !sinTerminos && keyterms.length > 0;

        const r = await abrirScribe(params);
        if (r === true) return true;
        // Si la rechazó (no si no contestó: eso es la red), se prueba sin los
        // extras de a uno. Mejor escuchar sin filtro o sin vocabulario que caer
        // al respaldo por un parámetro.
        if (r === 'rechazo' && activa && !sinFiltroFondo) {
            sinFiltroFondo = true;
            return conectarScribe();
        }
        if (r === 'rechazo' && activa && conTerminos) {
            sinTerminos = true;
            return conectarScribe();
        }
        return false;
    }

    /** @returns {Promise<true|'rechazo'|false>} arrancó, la rechazó o no contestó */
    function abrirScribe(params) {
        return new Promise((resolverCon) => {
            let arranco = false;
            const socket = new WebSocket(`${URL_SCRIBE}?${params}`);
            ws = socket;
            parcialPendiente = '';
            cierreEnviado = false;
            const resolver = (ok) => resolverCon(ok ? true : 'rechazo');
            const plazo = setTimeout(() => { if (!arranco) { socket.close(); resolverCon(false); } }, 6000);

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
                    case 'partial_transcript': {
                        const texto = msg.text?.trim();
                        if (!texto) break;
                        if (texto !== parcialPendiente) {
                            parcialPendiente = texto;
                            parcialDesde = Date.now();
                            cierreEnviado = false;
                        }
                        cb.onParcial?.(texto);
                        break;
                    }
                    case 'committed_transcript':
                        parcialPendiente = '';
                        cierreEnviado = false;
                        if (msg.text?.trim()) cb.onSegmento?.(msg.text.trim());
                        else cb.onParcial?.('');
                        break;
                    default:
                        if (msg.error) {
                            console.warn('[escucha] Scribe:', msg.message_type, msg.error);
                            if (!arranco) { clearTimeout(plazo); resolver(false); }
                            // Si se quejó justo después de pedirle cerrar a mano,
                            // no se le pide más: queda su VAD solo.
                            if (cierreEnviado) sinCierreManual = true;
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

    function enviarAScribe(pcm, ahora) {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        // Hay texto sin cerrar que no cambió en un rato: ya terminó de hablar,
        // aunque el ruido de atrás no deje que el VAD de Scribe se dé cuenta.
        const cerrar = Boolean(parcialPendiente) && !cierreEnviado && !sinCierreManual
            && ahora - parcialDesde >= PARCIAL_QUIETO_MS;
        if (cerrar) cierreEnviado = true;
        ws.send(JSON.stringify({
            message_type: 'input_audio_chunk',
            audio_base_64: aBase64(pcm),
            commit: cerrar,
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
            if (hayVoz) { juntando = previo.slice(); previo = []; bloquesConVoz = 1; }
            return;
        }
        juntando.push(bloque);
        if (hayVoz) bloquesConVoz++;
        const silencio = ahora - ultimaVoz;
        const largo = juntando.length / 10;   // segundos
        if (silencio >= SILENCIO_SEGMENTO_MS || largo >= 30) {
            const pedazo = juntando;
            const conVoz = bloquesConVoz;
            juntando = null;
            bloquesConVoz = 0;
            // Menos de medio segundo de audio, o casi todo silencio, es un ruido.
            if (pedazo.length >= 5 && conVoz >= MIN_BLOQUES_CON_VOZ) transcribirPedazo(pedazo);
        }
    }

    async function transcribirPedazo(bloques) {
        try {
            const { text } = await API.aiTranscribe(aWav(bloques), { voz: true, budget: presupuesto });
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
    function alRecibirAudio({ pcm, rms, rmsVoz = rms }) {
        if (!activa || micPausado) return;
        const ahora = Date.now();
        nivelActual = Math.min(1, rms * 6);

        // Voz por encima del ruido del lugar, no cualquier sonido: con música
        // de fondo, si no, "estaría hablando" siempre y nunca pasaría a pensar.
        const hayVoz = ruido.esVoz(rmsVoz, ahora);
        if (hayVoz) ultimaVoz = ahora;
        const habla = ahora - ultimaVoz < COLA_VOZ_MS;
        if (habla !== hablaba) {
            hablaba = habla;
            cb.onHabla?.(habla);
        }

        if (modo === 'vivo') enviarAScribe(pcm, ahora);
        else if (modo === 'respaldo') juntarParaRespaldo(pcm, hayVoz, ahora);
    }

    function detener() {
        activa = false;
        modo = null;
        const socket = ws;
        ws = null;
        try { socket?.close(); } catch {}
        try { fuente?.disconnect(); } catch {}
        fuente = null;
        try { nodo?.disconnect(); } catch {}
        nodo = null;
        micPausado = false;
        reabriendo = null;
        sesionDeAudio('auto');
        stream?.getTracks().forEach(t => t.stop());
        stream = null;
        previo = [];
        juntando = null;
        bloquesConVoz = 0;
        nivelActual = 0;
        hablaba = false;
        ruido = null;
        parcialPendiente = '';
        cierreEnviado = false;
    }

    const nivel = () => nivelActual;
    const estaHablando = () => hablaba;
    const modoActual = () => modo;

    return { soportada, iniciar, detener, nivel, estaHablando, modoActual, pausarMic, reanudarMic, micEnPausa: () => micPausado };
})();
