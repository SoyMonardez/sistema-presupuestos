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

    return { isSupported, start, stop, isActive };
})();
