// Dictado por voz: graba con MediaRecorder y transcribe en el servidor (Groq Whisper).
// Mucho más confiable que la Web Speech API, y funciona en cualquier navegador moderno.
const Voice = (() => {
    let recorder = null;
    let stream = null;
    let chunks = [];
    let active = false;
    let timerInterval = null;

    function isSupported() {
        return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    }

    function pickMimeType() {
        const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
        return candidates.find(t => MediaRecorder.isTypeSupported(t)) || '';
    }

    async function start({ onTick, onStop, onError }) {
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

        recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
        recorder.onstop = () => {
            clearInterval(timerInterval);
            stream.getTracks().forEach(t => t.stop());
            active = false;
            const blob = new Blob(chunks, { type: recorder.mimeType || 'audio/webm' });
            onStop?.(blob);
        };

        recorder.start();

        const startedAt = Date.now();
        timerInterval = setInterval(() => {
            const secs = Math.floor((Date.now() - startedAt) / 1000);
            onTick?.(secs);
            if (secs >= 120) stop(); // tope de 2 minutos por dictado
        }, 500);
    }

    function stop() {
        if (recorder && active) recorder.stop();
    }

    function isActive() { return active; }

    // ================= Vista previa en vivo =================
    // Lo que se ve escribirse mientras habla.
    //
    // Esto NO reemplaza a Whisper: lo usa el reconocimiento del propio navegador,
    // que es instantáneo y gratis pero entiende bastante peor el rioplatense y
    // las palabras de obra. Sirve para ver que te está escuchando; el texto que
    // queda es el de Whisper, que llega cuando se corta la grabación.
    //
    // Es "mejor esfuerzo" a propósito: corre en paralelo a la grabación y si el
    // navegador no lo soporta, o falla, o pelea por el micrófono, no pasa nada —
    // se sigue grabando igual y el resultado final es el mismo.
    const Reconocimiento = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recon = null;

    function previewSupported() { return Boolean(Reconocimiento); }

    function startPreview(onText) {
        if (!Reconocimiento) return false;
        try {
            recon = new Reconocimiento();
            recon.lang = 'es-AR';
            recon.continuous = true;
            recon.interimResults = true;      // lo que va entendiendo, sin esperar

            recon.onresult = (e) => {
                let texto = '';
                for (let i = 0; i < e.results.length; i++) texto += e.results[i][0].transcript;
                onText?.(texto.trim());
            };
            // Los errores se tragan: la vista previa es un lujo, no el resultado.
            recon.onerror = () => {};
            // Chrome lo corta solo tras un silencio; mientras se siga grabando,
            // se vuelve a levantar para que el texto no deje de aparecer.
            recon.onend = () => { if (active && recon) { try { recon.start(); } catch {} } };

            recon.start();
            return true;
        } catch {
            recon = null;
            return false;
        }
    }

    function stopPreview() {
        if (!recon) return;
        const r = recon;
        recon = null;              // corta el auto-relevo del onend
        try { r.stop(); } catch {}
    }

    return { isSupported, start, stop, isActive, previewSupported, startPreview, stopPreview };
})();
