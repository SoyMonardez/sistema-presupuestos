// Los sonidos de la conversación por voz.
//
// Sirven para lo mismo que en un teléfono: saber qué pasó sin mirar la
// pantalla. Él dicta con la vista en la planilla que está leyendo, no en la
// app, así que "entró", "lo cargué" y "te toca" tienen que escucharse.
//
// Se generan con Web Audio en vez de usar archivos: no hay nada que descargar
// ni que cachear, y la CSP no necesita abrirse para nada.

const Sonidos = (() => {
    let ctx = null;

    /**
     * El AudioContext compartido (también lo usa Hablar para medir el volumen
     * de la voz). Tiene que crearse o reanudarse desde un toque del usuario,
     * si no el navegador lo deja mudo.
     */
    function contexto() {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        if (!ctx) ctx = new AC();
        if (ctx.state === 'suspended') ctx.resume().catch(() => {});
        return ctx;
    }

    // Una nota suave: seno con ataque y caída cortos, para que no suene a alarma.
    function nota(frecuencia, { desde = 0, dura = 0.16, volumen = 0.12, tipo = 'sine' } = {}) {
        const c = contexto();
        if (!c) return;
        const t0 = c.currentTime + desde;
        const osc = c.createOscillator();
        const env = c.createGain();
        osc.type = tipo;
        osc.frequency.setValueAtTime(frecuencia, t0);
        env.gain.setValueAtTime(0.0001, t0);
        env.gain.exponentialRampToValueAtTime(volumen, t0 + 0.015);
        env.gain.exponentialRampToValueAtTime(0.0001, t0 + dura);
        osc.connect(env).connect(c.destination);
        osc.start(t0);
        osc.stop(t0 + dura + 0.05);
    }

    // Subiendo: "estoy acá". Bajando: "me fui".
    function entrar() {
        nota(523.25, { dura: 0.18 });               // do
        nota(659.25, { desde: 0.09, dura: 0.2 });   // mi
        nota(783.99, { desde: 0.18, dura: 0.32, volumen: 0.1 }); // sol
    }
    function salir() {
        nota(783.99, { dura: 0.16, volumen: 0.1 });
        nota(523.25, { desde: 0.1, dura: 0.28 });
    }
    // "Te escucho": un toquecito agudo, como el del dictado del teléfono.
    function teEscucho() { nota(880, { dura: 0.12, volumen: 0.07 }); }
    // Un cambio quedó cargado. Corto y seco, para que diez seguidos no molesten.
    function aplicado() {
        nota(1318.5, { dura: 0.07, volumen: 0.06, tipo: 'triangle' });
        nota(1760, { desde: 0.05, dura: 0.09, volumen: 0.05, tipo: 'triangle' });
    }
    // Hay algo para confirmar.
    function pregunta() {
        nota(659.25, { dura: 0.12, volumen: 0.08 });
        nota(880, { desde: 0.1, dura: 0.18, volumen: 0.08 });
    }
    function error() {
        nota(220, { dura: 0.18, volumen: 0.09, tipo: 'triangle' });
        nota(174.6, { desde: 0.14, dura: 0.26, volumen: 0.09, tipo: 'triangle' });
    }

    return { contexto, entrar, salir, teEscucho, aplicado, pregunta, error };
})();
