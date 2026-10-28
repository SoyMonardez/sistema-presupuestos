// La cara de la conversación por voz: el orbe, el brillo de los bordes, el
// subtítulo y las tarjetas de "pienso hacer…".
//
// Tiene que quedar claro de un vistazo, y de lejos, en qué anda el asistente.
// Por eso cada fase tiene su color y su forma de moverse, y el borde de toda la
// pantalla brilla con ese mismo color mientras el modo está prendido:
//
//   escuchando → celeste, respira con la voz de él
//   pensando   → violeta, gira
//   haciendo   → naranja, late
//   hablando   → verde agua, se mueve con la voz del asistente
//
// Los colores viven en el CSS (--voz-a / --voz-b de cada [data-fase]); acá solo
// se leen para pintar el canvas. Este módulo no decide nada: dibuja lo que le
// dice conversacion.js.

const Orbe = (() => {
    const { $ } = UI;

    const ETIQUETAS = {
        escuchando: 'Te escucho',
        pensando: 'Pensando…',
        haciendo: 'Cargando…',
        hablando: 'Hablando',
        esperando: 'Esperando tu OK',
    };
    const MAX_TARJETAS = 4;

    let raiz, canvas, g2d, faseEl, subEl, tarjetasEl, deshacerBtn, autoInput, flotante, centro;
    let fase = 'escuchando';
    let colores = ['#38bdf8', '#6366f1'];
    let cuadro = null;
    let medirNivel = () => 0;
    let suavizado = 0;
    let mini = false;

    // El panel ocupa media pantalla en el celular. Se lo puede achicar a un orbe
    // flotante que sigue mostrando en qué anda (color y movimiento) sin tapar
    // la lista. Se recuerda si lo dejó así y dónde lo puso.
    const CLAVE_MINI = 'presu_voz_mini';
    const clavePosicion = () => `presu_voz_flotante_${esPC() ? 'pc' : 'cel'}`;
    const esPC = () => window.matchMedia('(min-width: 1200px)').matches;
    const leer = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    const guardar = (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} };

    // Tocar el orbe mientras habla lo calla (en el celular, con el micrófono en
    // pausa para que suene por el altavoz, es la forma de interrumpirlo).
    // `alTocar` devuelve true si se ocupó del toque.
    let alTocar = () => false;

    function init({ onSalir, onDeshacer, onAuto, nivel, onTocar }) {
        if (onTocar) alTocar = onTocar;
        raiz = $('#voz-modo');
        canvas = $('#voz-orbe');
        g2d = canvas.getContext('2d');
        faseEl = $('#voz-fase');
        subEl = $('#voz-subtitulo');
        tarjetasEl = $('#voz-tarjetas');
        deshacerBtn = $('#voz-deshacer');
        autoInput = $('#voz-auto');
        flotante = $('#voz-flotante');
        centro = canvas.parentElement;
        if (nivel) medirNivel = nivel;

        $('#voz-minimizar').addEventListener('click', () => minimizar());
        prepararDeslizar($('#voz-cabeza'));
        prepararArrastre(flotante);
        canvas.addEventListener('click', () => { if (!mini) alTocar(); });

        $('#voz-salir').addEventListener('click', () => onSalir?.());
        deshacerBtn.addEventListener('click', () => onDeshacer?.());
        autoInput.addEventListener('change', () => onAuto?.(autoInput.checked));
    }

    function abrir({ auto }) {
        raiz.hidden = false;
        document.body.classList.add('voz-activa');
        autoInput.checked = auto;
        tarjetasEl.innerHTML = '';
        subtitulo('');
        cambiarFase('escuchando');
        ponerMini(leer(CLAVE_MINI) === '1');
        if (!cuadro) cuadro = requestAnimationFrame(dibujar);
    }

    function cerrar() {
        raiz.hidden = true;
        document.body.classList.remove('voz-activa', 'voz-mini');
        cancelAnimationFrame(cuadro);
        cuadro = null;
    }

    // ---------- Orbe flotante ----------
    function minimizar() { ponerMini(true); guardar(CLAVE_MINI, '1'); }
    function expandir()  { ponerMini(false); guardar(CLAVE_MINI, null); }

    function ponerMini(si) {
        mini = si;
        raiz.classList.toggle('mini', si);
        document.body.classList.toggle('voz-mini', si);
        flotante.hidden = !si;
        // Un solo canvas: se muda entre el panel y el botón flotante.
        (si ? flotante : centro).prepend(canvas);
        if (si) ubicarFlotante();
        ajustarCanvas();
    }

    function ubicarFlotante() {
        // Se borra todo lo que dejó un arrastre anterior: si quedara `right:auto`
        // de la posición del celular, en la PC la esquina del CSS no se aplica.
        for (const p of ['left', 'top', 'right', 'bottom', 'transform']) flotante.style[p] = '';
        const guardada = leer(clavePosicion());
        if (!guardada) return;   // la del CSS: abajo al medio, o abajo a la derecha en la PC
        const [x, y] = guardada.split(',').map(Number);
        if (Number.isFinite(x) && Number.isFinite(y)) moverFlotante(x, y);
    }

    function moverFlotante(x, y) {
        const lado = flotante.offsetWidth || 76;
        const maxX = window.innerWidth - lado - 8;
        const maxY = window.innerHeight - lado - 8;
        flotante.style.left = `${Math.max(8, Math.min(maxX, x))}px`;
        flotante.style.top = `${Math.max(8, Math.min(maxY, y))}px`;
        flotante.style.right = flotante.style.bottom = 'auto';
        flotante.style.transform = 'none';
    }

    /**
     * Arrastrar el orbe lo mueve; tocarlo sin moverlo abre el panel. La
     * diferencia es si se corrió más de unos pocos píxeles.
     */
    function prepararArrastre(el) {
        let inicio = null;
        el.addEventListener('pointerdown', (e) => {
            const r = el.getBoundingClientRect();
            inicio = { x: e.clientX, y: e.clientY, dx: e.clientX - r.left, dy: e.clientY - r.top, movio: false };
            el.setPointerCapture(e.pointerId);
        });
        el.addEventListener('pointermove', (e) => {
            if (!inicio) return;
            if (!inicio.movio && Math.hypot(e.clientX - inicio.x, e.clientY - inicio.y) < 8) return;
            inicio.movio = true;
            el.classList.add('arrastrando');
            moverFlotante(e.clientX - inicio.dx, e.clientY - inicio.dy);
        });
        const soltar = () => {
            if (!inicio) return;
            const movio = inicio.movio;
            inicio = null;
            el.classList.remove('arrastrando');
            if (movio) guardar(clavePosicion(), `${parseInt(el.style.left)},${parseInt(el.style.top)}`);
            else if (!alTocar()) expandir();
        };
        el.addEventListener('pointerup', soltar);
        el.addEventListener('pointercancel', () => { inicio = null; el.classList.remove('arrastrando'); });
    }

    /** En el celular: deslizar la manija del panel (para arriba o abajo) lo achica. */
    function prepararDeslizar(el) {
        let y0 = null;
        el.addEventListener('pointerdown', (e) => {
            if (e.target.closest('button')) return;
            y0 = e.clientY;
            el.setPointerCapture(e.pointerId);
        });
        el.addEventListener('pointermove', (e) => {
            if (y0 === null) return;
            if (Math.abs(e.clientY - y0) > 40) { y0 = null; minimizar(); }
        });
        const fin = () => { y0 = null; };
        el.addEventListener('pointerup', fin);
        el.addEventListener('pointercancel', fin);
    }

    function cambiarFase(nueva) {
        if (!raiz || nueva === fase && raiz.dataset.fase === nueva) return;
        fase = nueva;
        raiz.dataset.fase = nueva;
        faseEl.textContent = ETIQUETAS[nueva] || '';
        const css = getComputedStyle(raiz);
        colores = [css.getPropertyValue('--voz-a').trim() || colores[0], css.getPropertyValue('--voz-b').trim() || colores[1]];
    }

    /** Lo que está diciendo él. `provisorio`: todavía puede cambiar. */
    function subtitulo(texto, { provisorio = false } = {}) {
        if (!subEl) return;
        subEl.textContent = texto || '';
        subEl.classList.toggle('provisorio', provisorio);
    }

    function permitirDeshacer(si) { if (deshacerBtn) deshacerBtn.disabled = !si; }

    // ---------- Tarjetas ----------
    /**
     * Una tarjeta por turno: lo que pidió, lo que piensa hacer (se va
     * escribiendo) y, si no está en Auto, los botones para aceptar o no.
     */
    function nuevaTarjeta(pedidos) {
        const el = document.createElement('div');
        el.className = 'voz-tarjeta pensando';
        el.innerHTML = `
            <div class="voz-t-cabeza"><span class="voz-t-punto"></span><span class="voz-t-titulo">Pensando…</span></div>
            <p class="voz-t-pedido"></p>
            <p class="voz-t-pensamiento"></p>
            <div class="voz-t-acciones" hidden>
                <button type="button" class="voz-t-dejar">Dejalo</button>
                <button type="button" class="voz-t-aplicar">Aplicar</button>
            </div>`;
        el.querySelector('.voz-t-pedido').textContent = `“${pedidos.join(' · ')}”`;
        tarjetasEl.appendChild(el);
        while (tarjetasEl.children.length > MAX_TARJETAS) tarjetasEl.firstElementChild.remove();
        el.scrollIntoView({ block: 'nearest' });

        const titulo = el.querySelector('.voz-t-titulo');
        const pensamiento = el.querySelector('.voz-t-pensamiento');
        const acciones = el.querySelector('.voz-t-acciones');
        const estado = (clase, texto) => {
            el.className = `voz-tarjeta ${clase}`;
            titulo.textContent = texto;
            acciones.hidden = true;
        };

        return {
            pensamiento(trozo) { pensamiento.textContent += trozo; },
            fijarPensamiento(texto) { if (texto) pensamiento.textContent = texto; },
            propuesta({ onAplicar, onDejar }) {
                estado('propuesta', 'Pienso hacer esto');
                acciones.hidden = false;
                el.querySelector('.voz-t-aplicar').onclick = () => onAplicar?.();
                el.querySelector('.voz-t-dejar').onclick = () => onDejar?.();
            },
            haciendo() { estado('haciendo', 'Cargando…'); },
            aplicada() { estado('aplicada', 'Listo'); },
            descartada() { estado('descartada', 'Descartado'); },
            info() { estado('info', 'Respuesta'); },
            error(msg) { estado('error', 'No pude'); pensamiento.textContent = msg; },
        };
    }

    // ---------- El orbe ----------
    function ajustarCanvas() {
        const dpr = window.devicePixelRatio || 1;
        const lado = canvas.clientWidth || 96;
        canvas.width = lado * dpr;
        canvas.height = lado * dpr;
        g2d.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    // Ruido suave hecho con senos: alcanza para que el borde ondule orgánico sin
    // traer una librería de Perlin.
    function ondulacion(angulo, t, semilla) {
        return Math.sin(angulo * 3 + t * 1.3 + semilla) * 0.5
             + Math.sin(angulo * 5 - t * 1.7 + semilla * 2) * 0.3
             + Math.sin(angulo * 2 + t * 0.9) * 0.2;
    }

    function dibujar(ms) {
        cuadro = requestAnimationFrame(dibujar);
        pintar(g2d, canvas.clientWidth || 96, ms);
    }

    /**
     * Pinta el orbe en cualquier canvas: el de la página y el de la burbuja que
     * flota sobre otras apps (ver burbuja.js), que dibuja aunque esta página no
     * esté a la vista.
     *
     * `fondo`: color con que se tapa antes de pintar. Sin él se borra a
     * transparente, que en la página deja ver lo de atrás pero en la burbuja
     * (un video) sale como un cuadrado blanco.
     */
    let ultimoCuadro = -1;
    let crudo = 0;
    function pintar(g2d, lado, ms, { fondo = null } = {}) {
        const c = lado / 2;
        const t = ms / 1000;

        // Con dos lienzos pintando a la vez, el nivel se mide una sola vez por cuadro.
        if (ultimoCuadro !== ms) {
            ultimoCuadro = ms;
            crudo = medirNivel() || 0;
            suavizado += (crudo - suavizado) * 0.25;
        }

        // Cada fase se mueve distinto: así se distingue aunque no se vea el color.
        let radio = lado * 0.3, amp = 0.04, giro = t * 0.4;
        if (fase === 'escuchando') { radio *= 1 + suavizado * 0.25; amp = 0.03 + suavizado * 0.18; }
        else if (fase === 'pensando') { amp = 0.07; giro = t * 2.2; }
        else if (fase === 'haciendo') { radio *= 1 + Math.sin(t * 9) * 0.06; amp = 0.05; }
        else if (fase === 'hablando') {
            // La voz del aparato no se puede medir: se simula una onda de habla.
            const v = crudo || (0.35 + Math.sin(t * 11) * 0.2 + Math.sin(t * 7.3) * 0.15);
            radio *= 1 + v * 0.18; amp = 0.05 + v * 0.12;
        }
        else if (fase === 'esperando') { radio *= 1 + Math.sin(t * 2) * 0.03; amp = 0.02; }

        if (fondo) { g2d.fillStyle = fondo; g2d.fillRect(0, 0, lado, lado); }
        else g2d.clearRect(0, 0, lado, lado);

        // Halo
        const halo = g2d.createRadialGradient(c, c, radio * 0.6, c, c, radio * 1.6);
        halo.addColorStop(0, colores[0] + '55');
        halo.addColorStop(1, colores[0] + '00');
        g2d.fillStyle = halo;
        g2d.fillRect(0, 0, lado, lado);

        // Cuerpo: dos capas desfasadas, para que tenga volumen.
        for (const [capa, alfa] of [[0, 'cc'], [1, 'ff']]) {
            g2d.beginPath();
            const puntos = 64;
            for (let i = 0; i <= puntos; i++) {
                const a = (i / puntos) * Math.PI * 2;
                const r = radio * (1 - capa * 0.12) * (1 + amp * ondulacion(a + giro * (capa ? -1 : 1), t, capa * 1.7));
                const x = c + Math.cos(a) * r;
                const y = c + Math.sin(a) * r;
                if (i === 0) g2d.moveTo(x, y); else g2d.lineTo(x, y);
            }
            g2d.closePath();
            const grad = g2d.createLinearGradient(c - radio, c - radio, c + radio, c + radio);
            grad.addColorStop(0, colores[capa ? 0 : 1] + alfa);
            grad.addColorStop(1, colores[capa ? 1 : 0] + alfa);
            g2d.fillStyle = grad;
            g2d.fill();
        }

        // Brillo arriba a la izquierda
        const brillo = g2d.createRadialGradient(c - radio * 0.35, c - radio * 0.4, 0, c - radio * 0.35, c - radio * 0.4, radio * 0.7);
        brillo.addColorStop(0, 'rgba(255,255,255,0.45)');
        brillo.addColorStop(1, 'rgba(255,255,255,0)');
        g2d.fillStyle = brillo;
        g2d.beginPath();
        g2d.arc(c, c, radio * 0.95, 0, Math.PI * 2);
        g2d.fill();
    }

    window.addEventListener('resize', () => {
        if (!cuadro) return;
        if (mini) ubicarFlotante();   // que no quede afuera de la pantalla al girar el celular
        ajustarCanvas();
    });

    return {
        init, abrir, cerrar, cambiarFase, subtitulo, permitirDeshacer, nuevaTarjeta, minimizar, expandir,
        estaMini: () => mini,
        pintar,
    };
})();
