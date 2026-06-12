// Dictado por voz con Web Speech API (Chrome/Edge/Android). Requiere HTTPS o localhost.
const Voice = (() => {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    let recognition = null;
    let finalText = '';
    let active = false;

    function isSupported() { return Boolean(SR); }

    function start({ onPartial, onEnd, onError }) {
        if (!SR || active) return;
        finalText = '';
        active = true;

        recognition = new SR();
        recognition.lang = 'es-AR';
        recognition.continuous = true;
        recognition.interimResults = true;

        recognition.onresult = (event) => {
            let interim = '';
            for (let i = event.resultIndex; i < event.results.length; i++) {
                const piece = event.results[i][0].transcript;
                if (event.results[i].isFinal) finalText += piece + ' ';
                else interim += piece;
            }
            onPartial?.((finalText + interim).trim());
        };

        recognition.onerror = (event) => {
            active = false;
            if (event.error === 'no-speech') return; // onend se encarga
            onError?.(event.error === 'not-allowed'
                ? 'Permití el acceso al micrófono para dictar.'
                : `Error de micrófono: ${event.error}`);
        };

        recognition.onend = () => {
            const wasActive = active;
            active = false;
            if (wasActive) onEnd?.(finalText.trim());
        };

        recognition.start();
    }

    function stop() {
        if (recognition && active) recognition.stop();
    }

    function isActive() { return active; }

    return { isSupported, start, stop, isActive };
})();
