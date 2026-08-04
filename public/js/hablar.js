// Leer en voz alta lo que contesta el asistente.
//
// Usa la voz que ya trae el aparato (Web Speech API): no cuesta nada, funciona
// sin internet y no hay ninguna key que configurar. La contra es que la calidad
// depende del dispositivo — en un Android con las voces de Google o en un iPhone
// suena bien; en una PC vieja con las voces de Microsoft suena a robot.
//
// Por eso todo sale por `Hablar.decir(texto)` y no llamando a speechSynthesis
// desde la pantalla: el día que se quiera enchufar una voz paga (que devuelve un
// audio y se reproduce con <audio>), se cambia acá adentro y el resto no se
// entera. Mismo criterio que server/ai/provider.js.
//
// Lo que más importa en ESTA app no es la voz sino CÓMO LEE LOS NÚMEROS. Un
// presupuesto es casi todo plata y medidas, y los lectores leen "$238.525" como
// "doscientos treinta y ocho punto quinientos veinticinco" y "m²" como "eme dos".
// Eso no se entiende hablado. Antes de mandar el texto a la voz se traduce a cómo
// lo diría una persona.

const Hablar = (() => {
    const soportado = typeof window !== 'undefined' && 'speechSynthesis' in window;

    let vozElegida = null;
    let hablando = false;
    let alCambiar = null;      // avisa a la pantalla para prender/apagar el botón
    let mantenerVivo = null;

    // ---------- Elegir la mejor voz disponible ----------
    // Las voces tardan en cargar y en algunos navegadores llegan por evento, así
    // que esto se vuelve a correr cuando avisan.
    //
    // Preferencias, en orden: que sea española; que sea de las buenas (Google,
    // las de Apple, o cualquiera marcada como premium/neural); y que el acento
    // sea rioplatense o al menos latino antes que el de España.
    const BUENAS = /google|premium|enhanced|neural|natural|siri|m[oó]nica|paulina/i;

    function puntaje(v) {
        let p = 0;
        const lang = (v.lang || '').toLowerCase();
        if (!lang.startsWith('es')) return -1;
        if (BUENAS.test(v.name)) p += 10;
        if (lang.startsWith('es-ar')) p += 6;          // rioplatense, lo ideal
        else if (lang.startsWith('es-419') || lang.startsWith('es-mx') || lang.startsWith('es-us')) p += 4;
        else if (lang.startsWith('es-es')) p += 1;     // el "vosotros" suena ajeno acá
        if (!v.localService) p += 1;                   // las de red suelen ser mejores
        return p;
    }

    function elegirVoz() {
        if (!soportado) return null;
        const voces = speechSynthesis.getVoices() || [];
        let mejor = null;
        let mejorP = -1;
        for (const v of voces) {
            const p = puntaje(v);
            if (p > mejorP) { mejorP = p; mejor = v; }
        }
        vozElegida = mejorP >= 0 ? mejor : null;
        return vozElegida;
    }

    if (soportado) {
        elegirVoz();
        speechSynthesis.addEventListener?.('voiceschanged', elegirVoz);
    }

    /** ¿Hay alguna voz en español para usar? */
    function disponible() {
        if (!soportado) return false;
        if (!vozElegida) elegirVoz();
        // Aunque no haya voz española, el navegador puede leer igual con la de
        // por defecto. Se prefiere ofrecerlo antes que esconder el botón.
        return true;
    }

    /** Nombre de la voz que va a usar, para mostrarlo en los ajustes. */
    function vozActual() {
        if (!vozElegida) elegirVoz();
        return vozElegida ? `${vozElegida.name} (${vozElegida.lang})` : 'la voz por defecto del dispositivo';
    }

    // ---------- Traducir el texto a "cómo se dice" ----------

    /** 238525 → "doscientos treinta y ocho mil quinientos veinticinco" */
    function enPalabras(n) {
        if (typeof numeroALetras !== 'function') return null;   // lo define pdf.js
        if (!Number.isFinite(n) || n < 0 || n > 999999999) return null;
        return numeroALetras(Math.round(n)).toLowerCase();
    }

    // "1.500.000,50" → 1500000.5 · "1.10" → 1.10 · "175.000" → 175000
    //
    // El punto es ambiguo en esta app: en la plata es separador de miles
    // ("175.000") y en las medidas es decimal ("1.10 m"). Se resuelve igual que
    // en parseQty (ui.js): punto seguido de EXACTAMENTE tres dígitos y sin más
    // dígitos atrás es separador de miles; si no, es decimal.
    function aNumero(txt) {
        let s = String(txt).trim();
        if (s.includes(',')) return Number(s.replace(/\./g, '').replace(',', '.')) || 0;
        const puntos = (s.match(/\./g) || []).length;
        if (puntos > 1) return Number(s.replace(/\./g, '')) || 0;
        if (puntos === 1) {
            const [, dec] = s.split('.');
            if (dec.length === 3) return Number(s.replace('.', '')) || 0;   // miles
            return Number(s) || 0;                                          // decimal
        }
        return Number(s) || 0;
    }

    const UNIDADES = [
        // Los símbolos ² y ³ no son ambiguos, así que se convierten haya o no un
        // número adelante: en el texto aparece seguido "a $42.000 el m²", y ahí
        // se leía "el eme dos".
        [/m²/g,  ' metros cuadrados'],
        [/m³/g,  ' metros cúbicos'],
        // Estos sí piden número adelante: "m2" o "m" sueltos aparecen dentro de
        // palabras y de abreviaturas que no son unidades.
        [/(\d)\s*m2\b/g, '$1 metros cuadrados'],
        [/(\d)\s*m3\b/g, '$1 metros cúbicos'],
        [/(\d)\s*ml\b/g, '$1 metros lineales'],
        [/(\d)\s*hs\b/g, '$1 horas'],
        [/(\d)\s*kg\b/g, '$1 kilos'],
        [/(\d)\s*cm\b/g, '$1 centímetros'],
        [/(\d)\s*mm\b/g, '$1 milímetros'],
        [/(\d)\s*m\b/g,  '$1 metros'],
        [/\bun\.\s/g,    'unidades '],
        [/%/g,           ' por ciento'],
    ];

    /**
     * Deja el texto listo para que una voz lo lea como lo diría una persona.
     * Exportada para poder probarla sola (ver hablar.test.mjs).
     */
    function paraLeer(texto) {
        let t = String(texto || '');

        // Marcas de markdown que el modelo mete a veces: se leerían "asterisco".
        t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/[*_`#]/g, '');

        // Plata: "$238.525" o "$ 1.500.000,50" → en palabras + "pesos".
        t = t.replace(/\$\s?(\d[\d.,]*)/g, (m, num) => {
            const n = aNumero(num);
            const ent = Math.floor(n);
            const cent = Math.round((n - ent) * 100);
            const palabras = enPalabras(ent);
            if (palabras === null) return m;
            return cent
                ? `${palabras} pesos con ${cent} centavos`
                : `${palabras} pesos`;
        });

        // Números grandes sueltos, sin el signo: "175.000 de costo".
        //
        // El lookahead es por un caso que parece de laboratorio y no lo es: un
        // volumen convertido da "1.485 m³" (9,9 m² × 0,15), que con la regla de
        // los miles se leía "mil cuatrocientos ochenta y cinco metros cúbicos"
        // — mil veces el valor real. Si atrás viene una unidad de medida, el
        // punto es decimal aunque tenga tres cifras.
        t = t.replace(
            /\b(\d{1,3}(?:\.\d{3})+)\b(?!\s*(?:m²|m³|m2\b|m3\b|ml\b|mm\b|cm\b|kg\b|hs\b|m\b))/g,
            (m) => enPalabras(aNumero(m)) ?? m,
        );

        // Decimales: "1.10", "9,9" y "1.485" se leen mejor con "coma".
        //
        // Nada de \b al final: en el texto real la medida viene pegada a la
        // unidad ("1.10m x 0.15m") y entre "0" y "m" no hay borde de palabra,
        // así que con \b esos casos —los más comunes— quedaban sin convertir.
        t = t.replace(/(?<![\d.,])(\d+)[.,](\d{1,3})(?![\d.,])/g, '$1 coma $2');

        // Abreviaturas de obra. "H°17" leído letra por letra no se entiende, y
        // es de lo que más aparece en los items de este rubro.
        t = t.replace(/\bH°\s*/g, 'hormigón ').replace(/\bA°\s*/g, 'acero ');

        for (const [re, rep] of UNIDADES) t = t.replace(re, rep);

        // Concordancia: la conversión deja "el metros cuadrados", que suena a
        // traducción automática. Con artículo delante va en singular.
        t = t.replace(/\b(el|del|al|por|un|cada)\s+metros\s+(cuadrados|cúbicos|lineales)\b/gi,
            (_, art, u) => `${art} metro ${u === 'cuadrados' ? 'cuadrado' : u === 'cúbicos' ? 'cúbico' : 'lineal'}`);
        t = t.replace(/\b(una|cada)\s+horas\b/gi, '$1 hora');

        // Las flechas y los guiones de lista no se leen: se convierten en pausa.
        t = t.replace(/\s*[→>]\s*/g, ', ').replace(/^\s*[-•]\s*/gm, ', ');

        return t.replace(/\s{2,}/g, ' ').trim();
    }

    // ---------- Decir ----------

    /**
     * Corta en frases para dos cosas: que empiece a hablar antes, y esquivar el
     * bug viejo de Chrome que trunca las locuciones largas.
     */
    function enFrases(t) {
        return t
            .split(/(?<=[.!?:\n])\s+/)
            .map(s => s.trim())
            .filter(Boolean)
            .flatMap(s => s.length <= 220 ? [s] : s.match(/.{1,220}(\s|$)/g).map(x => x.trim()));
    }

    function avisar() { alCambiar?.({ hablando, pausado, id: idActual }); }

    // Estado de la lectura en curso.
    //
    // Se guardan las frases que faltan porque la pausa no se puede confiar al
    // navegador solo: en Chrome de escritorio pause() anda, pero en Android
    // suele ser un no-op o directamente cortar. Teniendo la cola acá, si el
    // navegador no pausa de verdad se corta y al reanudar se sigue desde la
    // frase que faltaba. Para el que escucha es lo mismo.
    let pendientes = [];        // frases que todavía no se dijeron
    let pausado = false;
    let idActual = null;        // qué mensaje se está leyendo
    let pausaNativa = false;    // ¿el navegador pausó de verdad?

    /**
     * Lee el texto. Corta lo que estuviera diciendo antes.
     * `id` identifica de qué mensaje se trata, para que la pantalla sepa qué
     * botón marcar como "sonando".
     */
    function decir(texto, id = null) {
        if (!soportado) return;
        callar();

        const limpio = paraLeer(texto);
        if (!limpio) return;
        if (!vozElegida) elegirVoz();

        idActual = id;
        pendientes = enFrases(limpio);
        arrancar();
    }

    /** Mete en la cola del navegador lo que quede por decir. */
    function arrancar() {
        if (!pendientes.length) { terminar(); return; }

        hablando = true;
        pausado = false;
        pausaNativa = false;
        avisar();

        // Se copia la lista: cada frase se saca de `pendientes` cuando TERMINA
        // de decirse, así lo que queda ahí es siempre lo que falta escuchar.
        const frases = pendientes.slice();
        frases.forEach((frase, i) => {
            const u = new SpeechSynthesisUtterance(frase);
            if (vozElegida) { u.voice = vozElegida; u.lang = vozElegida.lang; }
            else u.lang = 'es-AR';
            // Un poco más lento que el default: se entiende mejor, y quien lo va
            // a escuchar no es necesariamente alguien apurado leyendo una app.
            u.rate = 0.95;
            u.pitch = 1;
            u.onend = () => {
                // Si se cortó por una pausa, no se descuenta: esa frase se
                // vuelve a decir entera al reanudar.
                if (pausado) return;
                pendientes.shift();
                if (i === frases.length - 1) terminar();
            };
            u.onerror = () => { if (!pausado) terminar(); };
            speechSynthesis.speak(u);
        });

        arrancarMantenerVivo();
    }

    function terminar() {
        hablando = false;
        pausado = false;
        pendientes = [];
        idActual = null;
        pararMantenerVivo();
        avisar();
    }

    /** Corta del todo. Lo que faltaba se pierde. */
    function callar() {
        if (!soportado) return;
        speechSynthesis.cancel();
        pararMantenerVivo();
        if (hablando || pausado) terminar();
        else { pendientes = []; idActual = null; }
    }

    /**
     * Pausa. Primero se le pide al navegador; si no pausó de verdad —Android
     * seguido no lo hace— se corta y se recuerda por dónde iba.
     */
    function pausar() {
        if (!soportado || !hablando || pausado) return;
        pausado = true;
        pararMantenerVivo();

        speechSynthesis.pause();
        pausaNativa = speechSynthesis.paused === true;
        if (!pausaNativa) speechSynthesis.cancel();   // se sigue desde `pendientes`

        avisar();
    }

    /** Sigue desde donde había quedado. */
    function reanudar() {
        if (!soportado || !pausado) return;
        pausado = false;

        if (pausaNativa) {
            speechSynthesis.resume();
            hablando = true;
            arrancarMantenerVivo();
            avisar();
        } else {
            arrancar();   // vuelve a encolar lo que faltaba
        }
    }

    /** Pausa o sigue, según cómo esté. Es lo que llama el botón. */
    function alternarPausa() {
        if (pausado) reanudar();
        else if (hablando) pausar();
    }

    const estaHablando = () => hablando;
    const estaPausado  = () => pausado;
    const leyendoId    = () => idActual;

    /** La pantalla se entera de cada cambio, para pintar los botones. */
    function alHablar(fn) { alCambiar = fn; }

    // Chrome de escritorio se "duerme" y deja de hablar pasados unos 15 segundos.
    // El truco conocido es pedirle resume() cada tanto mientras hay algo en cola.
    //
    // OJO: esto tiene que respetar la pausa. Antes de que existiera el botón no
    // importaba, pero un resume() automático encima de una pausa a propósito la
    // desharía sola a los diez segundos.
    function arrancarMantenerVivo() {
        pararMantenerVivo();
        mantenerVivo = setInterval(() => {
            if (pausado) return;
            if (!speechSynthesis.speaking && !speechSynthesis.pending) {
                pararMantenerVivo();
                return;
            }
            speechSynthesis.pause();
            speechSynthesis.resume();
        }, 10000);
    }
    function pararMantenerVivo() {
        clearInterval(mantenerVivo);
        mantenerVivo = null;
    }

    /**
     * iOS no deja hablar si la primera vez no salió de un toque del usuario.
     * Se llama desde el click que prende la voz, con algo mínimo, para destrabar.
     */
    function destrabar() {
        if (!soportado) return;
        const u = new SpeechSynthesisUtterance(' ');
        u.volume = 0;
        speechSynthesis.speak(u);
    }

    return {
        soportado, disponible, vozActual, paraLeer, destrabar,
        decir, callar, pausar, reanudar, alternarPausa,
        estaHablando, estaPausado, leyendoId, alHablar,
    };
})();

// Para poder probar paraLeer() desde node (ver hablar.test.mjs).
if (typeof module !== 'undefined') module.exports = { Hablar };
