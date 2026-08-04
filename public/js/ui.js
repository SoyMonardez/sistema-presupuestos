// Las piezas chicas que usa todo el resto: el selector corto, el aviso flotante
// y los ayudantes de números.
//
// Estaban arriba de app.js, que las tenía a mano por estar todo en el mismo
// archivo. Al partirlo hacían falta desde cinco lados a la vez, así que viven acá.
//
// Los helpers de números son casi todos por lo mismo: los montos de un
// presupuesto tienen muchos ceros y sin separadores se leen mal, pero un input
// con separadores ya no es un número para JavaScript. Todo lo que entra pasa por
// parseNum/parseQty y todo lo que sale por fmtMoneyInput/numToInput.

const UI = (() => {
    const $ = (sel) => document.querySelector(sel);

    function toast(msg, isError = false) {
        const el = $('#toast');
        el.textContent = msg;
        el.className = 'toast' + (isError ? ' error' : '');
        el.hidden = false;
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { el.hidden = true; }, 3200);
    }

    // Monto en palabras: 660000 -> "seiscientos sesenta mil pesos".
    // numeroALetras lo define pdf.js; el guard es porque este archivo carga antes.
    function enLetras(value) {
        const n = Math.floor(Math.abs(Number(value) || 0));
        if (!n || typeof numeroALetras !== 'function') return '';
        return numeroALetras(n).toLowerCase() + ' pesos';
    }

    // Formatea un texto de plata con separadores de miles: "1500000" -> "1.500.000"
    function fmtMoneyInput(raw) {
        raw = String(raw).replace(/[^\d,]/g, '');
        const i = raw.indexOf(',');
        let intPart = (i >= 0 ? raw.slice(0, i) : raw).replace(/^0+(?=\d)/, '');
        intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
        let out = intPart;
        if (i >= 0) out += ',' + raw.slice(i + 1).replace(/,/g, '').slice(0, 2);
        return out;
    }

    // Convierte un texto "1.500.000,50" a número 1500000.5 (punto = miles, coma = decimal)
    function parseNum(str) {
        str = String(str).replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
        return Number(str) || 0;
    }

    // Cantidad: acepta coma o punto como decimal (1,5 o 1.5 → 1.5) y miles con punto (1.090 → 1090)
    function parseQty(str) {
        str = String(str).trim().replace(/[^\d.,]/g, '');
        if (str.includes(',')) {
            str = str.replace(/\./g, '').replace(',', '.');   // coma = decimal, puntos = miles
        } else {
            const dots = (str.match(/\./g) || []).length;
            if (dots > 1) {
                str = str.replace(/\./g, '');                 // varios puntos = miles
            } else if (dots === 1 && str.split('.')[1].length === 3) {
                str = str.replace('.', '');                   // "1.090" = 1090 (miles), no 1,09
            }                                                 // un punto con 1-2 decimales = decimal
        }
        return Number(str) || 0;
    }

    // Número JS -> texto de input formateado (660000 -> "660.000")
    function numToInput(n) {
        if (!n) return '';
        return fmtMoneyInput(String(n).replace('.', ','));
    }

    // Cantidad para mostrar: 1.5 -> "1,5" (sin arrastrar los decimales del float)
    function formatQty(n) {
        return (Math.round(n * 1e6) / 1e6).toString().replace('.', ',');
    }

    // Crece la altura de un textarea según el contenido.
    // Solo escribe si la altura cambió de verdad, y nunca achica mientras el campo
    // tiene el foco: reescribir style.height en cada tecla era una de las cosas
    // que hacían saltar la pantalla mientras se escribía en el celular.
    function autoGrow(el) {
        if (!el || el.offsetParent === null || el.clientWidth < 40) return; // sin layout válido todavía
        const actual = parseFloat(el.style.height) || 0;
        const enfocado = document.activeElement === el;

        el.style.height = 'auto';
        const deseada = Math.min(Math.max(el.scrollHeight, 22), 520);
        // Con el foco puesto solo crece; achicar mueve todo lo de alrededor.
        const nueva = enfocado ? Math.max(deseada, actual) : deseada;

        if (nueva !== actual) el.style.height = nueva + 'px';
        else el.style.height = actual + 'px';
    }

    return { $, toast, enLetras, fmtMoneyInput, parseNum, parseQty, numToInput, formatQty, autoGrow };
})();
