// La lista de items: las tarjetas, el total, la modal de descripción y la
// corrección de ortografía.
//
// Es la pantalla donde se trabaja de verdad, así que casi todo lo que hay acá
// existe por algo que molestaba en el celular: la descripción se edita en una
// modal (no en la tarjeta) porque el teclado tapaba media pantalla, y el subtotal
// se muestra también en palabras porque con seis ceros al lado nadie distingue
// 660.000 de 6.600.000 de un vistazo.

const Items = (() => {
    const { $, toast, enLetras, fmtMoneyInput, parseNum, parseQty, numToInput, formatQty, autoGrow } = UI;

    const items = Estado.lista();   // identidad estable, ver estado.js

    let suggestTimer = null;

    // ================= Tarjetas =================
    function render() {
        const listEl = $('#items-list');
        listEl.innerHTML = '';
        items.forEach((item, index) => {
            const card = document.createElement('div');
            card.className = 'item-card';
            card.innerHTML = `
                <div class="ic-top">
                    <span class="ic-num">${index + 1}</span>
                    <button class="ic-desc" type="button">
                        <span class="ic-desc-text"></span>
                    </button>
                    <button class="ic-remove" title="Quitar item" aria-label="Quitar item">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="20" height="20"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>
                </div>
                <div class="ic-fields">
                    <label class="ic-field"><span>Cantidad</span><input type="text" inputmode="decimal" class="f-qty" placeholder="1"></label>
                    <label class="ic-field"><span>Unidad</span><button type="button" class="f-unit" title="Elegir unidad"></button></label>
                    <label class="ic-field ic-field-price"><span>Precio por unidad</span><input type="text" inputmode="numeric" class="f-price" placeholder="$ 0"></label>
                </div>
                <div class="ic-foot">
                    <div class="ic-foot-btns">
                        <button class="ic-detail-toggle" type="button">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>
                            <span class="detail-label">Detalles</span>
                        </button>
                        <button class="ic-convert-toggle" type="button" title="Convertir unidad">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="15" height="15"><path d="M17 1l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><path d="M7 23l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>
                            <span class="detail-label">Convertir</span>
                        </button>
                    </div>
                    <div class="ic-subtotal">
                        <span class="ic-sub-amount"></span>
                        <span class="ic-sub-words"></span>
                    </div>
                </div>`;

            const descBtn  = card.querySelector('.ic-desc');
            const descText = card.querySelector('.ic-desc-text');
            const qtyEl    = card.querySelector('.f-qty');
            const unitEl   = card.querySelector('.f-unit');
            const priceEl  = card.querySelector('.f-price');
            const subAmt   = card.querySelector('.ic-sub-amount');
            const subWords = card.querySelector('.ic-sub-words');
            const toggleEl = card.querySelector('.ic-detail-toggle');

            function refreshSub() {
                const sub = item.quantity * item.unit_price;
                subAmt.textContent = formatARS(sub);
                subWords.textContent = enLetras(sub);
            }

            if (item.name && item.name.trim()) {
                descText.textContent = item.name;
                descBtn.classList.remove('empty');
            } else {
                descText.textContent = 'Tocá para escribir la descripción';
                descBtn.classList.add('empty');
            }
            qtyEl.value   = item.quantity ? String(item.quantity).replace('.', ',') : '';
            unitEl.textContent = item.unit || 'un.';
            priceEl.value = numToInput(item.unit_price);
            if (item.detail && item.detail.trim()) toggleEl.classList.add('active');
            refreshSub();

            // Tocar la descripción o "Detalles" abre la ventana modal
            descBtn.addEventListener('click', () => abrirModal(index, 'name'));
            toggleEl.addEventListener('click', () => abrirModal(index, 'detail'));
            card.querySelector('.ic-convert-toggle').addEventListener('click', () => Unidades.abrirConversion({ index }));

            qtyEl.addEventListener('input', () => {
                item.quantity = parseQty(qtyEl.value);
                refreshSub(); actualizarTotal(); Estado.scheduleSave();
            });
            unitEl.addEventListener('click', () => {
                Unidades.abrirPicker(item.unit, (label) => {
                    item.unit = label;
                    unitEl.textContent = label;
                    Estado.scheduleSave();
                });
            });
            priceEl.addEventListener('input', () => {
                priceEl.value = fmtMoneyInput(priceEl.value);
                item.unit_price = parseNum(priceEl.value);
                refreshSub(); actualizarTotal(); Estado.scheduleSave();
            });
            card.querySelector('.ic-remove').addEventListener('click', () => {
                Estado.sacarItem(index);
                render();
                Estado.scheduleSave();
            });

            listEl.appendChild(card);
        });
        actualizarTotal();
    }

    function actualizarTotal() {
        const total = items.reduce((sum, i) => sum + (i.quantity * i.unit_price || 0), 0);
        $('#total-amount').textContent = formatARS(total);
        const w = $('#total-words');
        if (w) w.textContent = enLetras(total);
    }

    $('#btn-add-item').addEventListener('click', () => {
        const idx = Estado.agregarItem({ name: '', detail: '', quantity: 1, unit: 'un.', unit_price: 0 });
        render();
        abrirModal(idx, 'name');
    });

    // ================= Modal de descripción =================
    let modalIndex = -1;

    function abrirModal(index, focusField) {
        if (index < 0 || index >= items.length) return;
        modalIndex = index;
        const item = items[index];
        const nameEl = $('#item-modal-name');
        const detailEl = $('#item-modal-detail');
        nameEl.value = item.name || '';
        detailEl.value = item.detail || '';
        ocultarSugerencias();
        $('#item-modal').hidden = false;
        document.body.classList.add('modal-open');
        requestAnimationFrame(() => {
            autoGrow(nameEl); autoGrow(detailEl);
            (focusField === 'detail' ? detailEl : nameEl).focus();
        });
        Nav.pushLayer('item-modal', ocultarModal);
    }

    // El cierre real. Lo corre Nav, venga del botón o del gesto del celular.
    function ocultarModal() {
        $('#item-modal').hidden = true;
        document.body.classList.remove('modal-open');
        ocultarSugerencias();
        modalIndex = -1;
        render();   // refresca el texto de las tarjetas
    }
    // Lo que llaman los botones de la pantalla: pasa por el historial para que
    // el gesto y el botón no se puedan desincronizar.
    function cerrarModal() { Nav.popLayer(); }

    $('#item-modal-name').addEventListener('input', () => {
        if (modalIndex < 0) return;
        const el = $('#item-modal-name');
        items[modalIndex].name = el.value;
        autoGrow(el);
        Estado.scheduleSave();
        agendarSugerencias(el, items[modalIndex]);
    });
    $('#item-modal-detail').addEventListener('input', () => {
        if (modalIndex < 0) return;
        const el = $('#item-modal-detail');
        items[modalIndex].detail = el.value;
        autoGrow(el);
        Estado.scheduleSave();
    });
    $('#item-modal-done').addEventListener('click', cerrarModal);
    $('#item-modal-close').addEventListener('click', cerrarModal);
    $('#item-modal').addEventListener('click', (e) => { if (e.target.id === 'item-modal') cerrarModal(); });

    // ================= Sugerencias IA (dentro de la modal) =================
    // Antes esto llamaba a ocultarSugerencias() en CADA tecla y volvía a mostrar
    // 600 ms después. Como la caja estaba en el flujo, colapsaba y expandía todo
    // el rato. Ahora las sugerencias viejas se quedan hasta que llegan las nuevas,
    // y la caja flota (ver .modal-suggest en el CSS), así que ya no empuja nada.
    function agendarSugerencias(inputEl, item) {
        clearTimeout(suggestTimer);
        const query = inputEl.value.trim();
        if (query.length < 3) { ocultarSugerencias(); return; }

        suggestTimer = setTimeout(async () => {
            try {
                const { suggestions } = await API.aiSuggest(query, items);
                // Si mientras tanto se fue del campo o cambió lo que escribió,
                // no pisamos nada.
                if (document.activeElement !== inputEl) return;
                if (!suggestions.length) { ocultarSugerencias(); return; }
                mostrarSugerencias(suggestions, item);
            } catch { /* sugerencias son best-effort */ }
        }, 600);
    }

    function mostrarSugerencias(suggestions, item) {
        const box = $('#item-modal-suggest');
        box.innerHTML = '';
        for (const s of suggestions) {
            const chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'suggest-chip';
            chip.innerHTML = `<span></span><span class="suggest-chip-price"></span>`;
            chip.firstChild.textContent = `${s.name} (${s.unit})`;
            chip.lastChild.textContent = s.unit_price ? '~' + formatARS(s.unit_price) : '';
            chip.addEventListener('mousedown', (e) => {
                e.preventDefault(); // que no dispare el blur antes del click
                item.name = s.name;
                item.unit = s.unit;
                if (!item.unit_price && s.unit_price) item.unit_price = s.unit_price;
                $('#item-modal-name').value = s.name;
                autoGrow($('#item-modal-name'));
                Estado.scheduleSave();
                ocultarSugerencias();
            });
            box.appendChild(chip);
        }
        box.hidden = false;
    }

    function ocultarSugerencias() {
        const b = $('#item-modal-suggest');
        if (b) { b.hidden = true; b.innerHTML = ''; }
    }

    // ================= Ortografía (corrección con IA) =================
    $('#btn-spell').addEventListener('click', async () => {
        const valid = items.filter(i => (i.name && i.name.trim()) || (i.detail && i.detail.trim()));
        if (!valid.length) {
            toast('No hay items para corregir', true);
            return;
        }
        const btn = $('#btn-spell');
        const label = $('#spell-label');
        btn.disabled = true;
        const prevLabel = label.textContent;
        label.textContent = 'Corrigiendo…';
        try {
            // Aplanamos: por cada item van [name, detail] en orden.
            const flat = [];
            items.forEach(i => { flat.push(i.name || '', i.detail || ''); });
            const { texts } = await API.aiSpellcheck(flat);
            let changed = 0;
            items.forEach((it, idx) => {
                const newName = texts[idx * 2];
                const newDetail = texts[idx * 2 + 1];
                if (typeof newName === 'string' && newName !== it.name) { it.name = newName; changed++; }
                if (typeof newDetail === 'string' && newDetail !== it.detail) { it.detail = newDetail; changed++; }
            });
            render();
            if (changed) {
                Estado.scheduleSave();
                toast('Ortografía corregida');
            } else {
                toast('No había nada que corregir');
            }
        } catch (err) {
            toast(err.message, true);
        } finally {
            btn.disabled = false;
            label.textContent = prevLabel;
        }
    });

    // Repintar la lista es cosa de este módulo: el estado avisa, acá se dibuja.
    Estado.conectar({ onRender: render });

    return { render };
})();
