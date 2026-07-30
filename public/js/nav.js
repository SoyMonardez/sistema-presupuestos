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
