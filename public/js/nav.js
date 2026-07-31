// Navegación de app: capas apiladas + pestañas con gesto.
//
// El problema que resuelve la parte de capas: en el celular, el gesto de volver
// cerraba la app entera en vez de cerrar la modal abierta, porque las modales se
// mostraban y escondían sin tocar el historial del navegador.
//
// La solución es que cada capa que se abre (una vista, una modal) empuje una
// entrada al historial, y que TANTO el botón de cerrar COMO el gesto del celular
// pasen por el mismo camino: history.back(). Al ir por el mismo lado no se pueden
// desincronizar, que es el bug clásico de manejar las dos cosas por separado.

const Nav = (() => {

    // ======================= Capas =======================
    // Cada elemento: { name, onClose }. La última es la que está arriba de todo.
    const layers = [];
    let ignoreNextPop = false;

    /**
     * Registra una capa abierta. `onClose` corre cuando se cierra, venga del
     * botón de la pantalla o del gesto del celular.
     */
    function pushLayer(name, onClose) {
        layers.push({ name, onClose });
        history.pushState({ navLayer: name, depth: layers.length }, '');
    }

    /** Cierra la capa de arriba. Es lo que llaman los botones X y "Listo". */
    function popLayer() {
        if (!layers.length) return;
        history.back();   // dispara popstate, que corre el onClose
    }

    /** ¿Hay una capa con este nombre abierta? */
    function hasLayer(name) {
        return layers.some(l => l.name === name);
    }

    /** Cierra todas las capas sin dejar basura en el historial. */
    function closeAll() {
        const n = layers.length;
        if (!n) return;
        ignoreNextPop = true;
        while (layers.length) layers.pop().onClose?.();
        history.go(-n);
    }

    window.addEventListener('popstate', () => {
        if (ignoreNextPop) { ignoreNextPop = false; return; }
        const layer = layers.pop();
        if (layer) layer.onClose?.();
        // Si no quedaban capas, el navegador ya hizo lo suyo: en la vista raíz el
        // gesto sale de la app, que es lo que corresponde.
    });

    // ======================= Barras de scroll que se desvanecen =======================
    // La barra fija a un costado se ve mal. Se enciende mientras se scrollea y se
    // apaga sola un rato después, como en las apps del celular.
    //
    // Va por delegación en captura porque el evento "scroll" no burbujea: hay que
    // escucharlo en la fase de captura del documento para enterarse de cualquier
    // elemento que scrollee, incluidos los que se crean después.

    const APAGAR_MS = 900;
    const temporizadores = new WeakMap();

    document.addEventListener('scroll', (e) => {
        const el = e.target;
        if (!el || el === document || !el.classList?.contains('scroll-suave')) return;

        el.classList.add('scrolleando');
        clearTimeout(temporizadores.get(el));
        temporizadores.set(el, setTimeout(() => el.classList.remove('scrolleando'), APAGAR_MS));
    }, true);

    // ======================= Arrastrar la hoja para cerrar =======================
    // El gesto que se espera de una hoja inferior: se agarra y se tira para abajo.
    // Se engancha una sola vez sobre el documento (delegación), así vale para las
    // modales que ya existen y para las que se agreguen después.
    //
    // Solo arranca desde el encabezado o el tirador: si arrancara desde el cuerpo,
    // pelearía con el scroll interno de la lista de unidades. La excepción es
    // cuando el cuerpo ya está arriba de todo (scrollTop 0) y el gesto va hacia
    // abajo, que es como se comportan las apps nativas.

    const CIERRE_MINIMO = 90;      // px que hay que arrastrar para que cierre
    const VELOCIDAD_FLICK = 0.5;   // px/ms: un tirón corto pero rápido también cierra

    let hoja = null;               // .modal-box que se está arrastrando
    let inicioY = 0, inicioT = 0, desplazado = 0, arrastrando = false;

    function puedeArrastrar(target, box) {
        if (target.closest('.modal-close, button, input, textarea, select, a')) return false;
        if (target.closest('.modal-head, .sheet-grip')) return true;
        // Desde el cuerpo solo si no hay nada scrolleado arriba.
        const body = target.closest('.modal-body');
        return body ? body.scrollTop <= 0 : false;
    }

    document.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        const box = e.target.closest('.modal-box');
        if (!box || !puedeArrastrar(e.target, box)) return;
        hoja = box;
        inicioY = e.touches[0].clientY;
        inicioT = Date.now();
        desplazado = 0;
        arrastrando = true;
        hoja.style.transition = 'none';
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
        if (!arrastrando || !hoja || e.touches.length !== 1) return;
        const dy = e.touches[0].clientY - inicioY;
        if (dy <= 0) {              // tirar para arriba no hace nada
            desplazado = 0;
            hoja.style.transform = '';
            return;
        }
        desplazado = dy;
        e.preventDefault();          // el gesto es nuestro: que no scrollee la página
        hoja.style.transform = `translateY(${dy}px)`;
        const overlay = hoja.parentElement;
        if (overlay) overlay.style.background = `rgba(0,0,0,${Math.max(.15, .6 - dy / 700)})`;
    }, { passive: false });

    function soltarHoja() {
        if (!arrastrando || !hoja) return;
        arrastrando = false;
        const box = hoja;
        const overlay = box.parentElement;
        const velocidad = desplazado / Math.max(Date.now() - inicioT, 1);
        const cierra = desplazado > CIERRE_MINIMO || (velocidad > VELOCIDAD_FLICK && desplazado > 30);

        box.style.transition = 'transform .22s ease';
        if (overlay) overlay.style.background = '';

        if (cierra) {
            box.style.transform = `translateY(${box.offsetHeight}px)`;
            // Se cierra por el mismo camino que el botón X y el gesto del celular,
            // para que el historial no se desincronice.
            setTimeout(() => {
                box.style.transition = '';
                box.style.transform = '';
                popLayer();
            }, 180);
        } else {
            box.style.transform = '';               // vuelve a su lugar
            setTimeout(() => { box.style.transition = ''; }, 240);
        }
        hoja = null;
        desplazado = 0;
    }

    document.addEventListener('touchend', soltarHoja, { passive: true });
    document.addEventListener('touchcancel', soltarHoja, { passive: true });

    // ======================= Pestañas con gesto =======================
    // Las pestañas NO empujan historial a propósito: en las apps con barra
    // inferior, el gesto de volver sale de la pantalla, no recorre las pestañas.

    function setupTabs({ track, buttons, onChange }) {
        let index = 0;
        let count = buttons.length;

        // Estado del gesto
        let startX = 0, startY = 0, startTime = 0;
        let axis = null;              // null = todavía no se sabe | 'x' | 'y'
        let dragging = false;
        let width = 0;

        function go(next, { animate = true } = {}) {
            index = Math.max(0, Math.min(count - 1, next));
            track.style.transition = animate ? 'transform .26s cubic-bezier(.32,.72,0,1)' : 'none';
            track.style.transform = `translate3d(${-index * 100}%, 0, 0)`;
            buttons.forEach((b, i) => {
                b.classList.toggle('active', i === index);
                b.setAttribute('aria-selected', i === index ? 'true' : 'false');
            });
            // Solo la pestaña visible es alcanzable con el teclado o el lector.
            [...track.children].forEach((pane, i) => pane.setAttribute('aria-hidden', i === index ? 'false' : 'true'));
            onChange?.(index);
        }

        buttons.forEach((btn, i) => btn.addEventListener('click', () => go(i)));

        // --- Gesto horizontal ---
        // El bloqueo de eje es lo que evita que el swipe pelee con el scroll
        // vertical de la lista de items: el primer movimiento decide quién manda.
        track.addEventListener('touchstart', (e) => {
            if (e.touches.length !== 1) return;
            // Arrancar el gesto encima de un campo de texto molesta al escribir.
            if (e.target.closest('input, textarea, select, .no-swipe')) return;
            const t = e.touches[0];
            startX = t.clientX;
            startY = t.clientY;
            startTime = Date.now();
            axis = null;
            dragging = true;
            width = track.offsetWidth || 1;
            track.style.transition = 'none';
        }, { passive: true });

        track.addEventListener('touchmove', (e) => {
            if (!dragging || e.touches.length !== 1) return;
            const t = e.touches[0];
            const dx = t.clientX - startX;
            const dy = t.clientY - startY;

            if (axis === null) {
                if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;   // todavía indeciso
                axis = Math.abs(dx) > Math.abs(dy) ? 'x' : 'y';
                if (axis === 'y') { dragging = false; return; }       // gana el scroll
            }

            e.preventDefault();   // el gesto es nuestro: no scrollear de costado
            // Resistencia en los extremos, para que se sienta que no hay más.
            let offset = dx;
            if ((index === 0 && dx > 0) || (index === count - 1 && dx < 0)) offset = dx * 0.35;
            track.style.transform = `translate3d(calc(${-index * 100}% + ${offset}px), 0, 0)`;
        }, { passive: false });

        function endDrag(e) {
            if (!dragging) return;
            dragging = false;
            if (axis !== 'x') return;

            const dx = (e.changedTouches?.[0]?.clientX ?? startX) - startX;
            const elapsed = Date.now() - startTime;
            const velocity = Math.abs(dx) / Math.max(elapsed, 1);

            // Cambia de pestaña si arrastró un cuarto de pantalla, o si fue un
            // flick corto pero rápido (que es como se usa de verdad).
            const salta = Math.abs(dx) > width * 0.25 || (velocity > 0.4 && Math.abs(dx) > 40);
            go(salta ? index + (dx < 0 ? 1 : -1) : index);
        }

        track.addEventListener('touchend', endDrag, { passive: true });
        track.addEventListener('touchcancel', endDrag, { passive: true });

        go(0, { animate: false });

        return {
            go,
            current: () => index,
            refresh: () => { count = buttons.length; go(index, { animate: false }); },
        };
    }

    return { pushLayer, popLayer, hasLayer, closeAll, setupTabs };
})();
