// Estado y navegación de la SPA.
(() => {
    const $ = (sel) => document.querySelector(sel);

    const views = {
        login:  $('#view-login'),
        list:   $('#view-list'),
        editor: $('#view-editor'),
        prices: $('#view-prices'),
    };

    let currentBudget = null;   // { id, name, client, notes }
    let items = [];             // [{ name, quantity, unit, unit_price }]
    let draftOps = [];          // operaciones (agregar/editar/borrar) propuestas por la IA, pendientes de confirmar
    let saveTimer = null;
    let suggestTimer = null;
    let suggestTarget = null;   // input de nombre activo para sugerencias
    let tabs = null;            // control de las pestañas del editor (nav.js)

    // ================= Navegación =================
    function show(name) {
        Object.values(views).forEach(v => v.hidden = true);
        views[name].hidden = false;
        window.scrollTo(0, 0);
    }

    function toast(msg, isError = false) {
        const el = $('#toast');
        el.textContent = msg;
        el.className = 'toast' + (isError ? ' error' : '');
        el.hidden = false;
        clearTimeout(toast._t);
        toast._t = setTimeout(() => { el.hidden = true; }, 3200);
    }

    // ===== Helpers de números (para leer fácil aunque tengan muchos ceros) =====
    // Monto en palabras: 660000 -> "seiscientos sesenta mil pesos"
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

    // ================= Login =================
    $('#login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const errEl = $('#login-error');
        errEl.hidden = true;
        try {
            const { token } = await API.login($('#login-password').value);
            API.setToken(token);
            $('#login-password').value = '';
            await openList();
        } catch (err) {
            errEl.textContent = err.message;
            errEl.hidden = false;
        }
    });

    $('#btn-logout').addEventListener('click', () => {
        API.clearToken();
        currentBudget = null;
        Nav.closeAll();     // que no queden capas colgadas en el historial
        show('login');
    });

    window.addEventListener('auth-expired', () => {
        toast('Tu sesión venció, entrá de nuevo', true);
        currentBudget = null;
        Nav.closeAll();
        show('login');
    });

    // ================= Lista =================
    async function openList() {
        // El catálogo se pide una sola vez por sesión: lo necesitan el selector de
        // unidad de cada item y el conversor.
        if (!unitCatalog.length) loadUnitCatalog();
        const budgets = await API.listBudgets();
        const listEl = $('#budget-list');
        listEl.innerHTML = '';
        $('#list-empty').hidden = budgets.length > 0;

        for (const b of budgets) {
            const card = document.createElement('div');
            card.className = 'budget-card';
            card.innerHTML = `
                <div class="budget-card-info">
                    <div class="budget-card-name"></div>
                    <div class="budget-card-meta"></div>
                </div>
                <div class="budget-card-total"></div>`;
            card.querySelector('.budget-card-name').textContent = b.name;
            card.querySelector('.budget-card-meta').textContent =
                `${formatDate(b.updated_at)} · ${b.item_count} item${b.item_count === 1 ? '' : 's'}`;
            card.querySelector('.budget-card-total').textContent = formatARS(b.total);
            card.addEventListener('click', () => openEditor(b.id));
            listEl.appendChild(card);
        }
        show('list');
    }

    $('#btn-new').addEventListener('click', async () => {
        const budget = await API.createBudget({ name: 'Nuevo presupuesto' });
        await openEditor(budget.id);
        $('#budget-name').select();
    });

    // ================= Precios base =================
    let prices = [];
    let pricesTimer = null;

    async function openPrices() {
        prices = (await API.getPrices()).map(p => ({ name: p.name, unit: p.unit, price: p.price }));
        renderPrices();
        cargarMargenes();
        show('prices');
        Nav.pushLayer('prices', async () => {
            clearTimeout(pricesTimer);
            try { await API.savePrices(prices); } catch {}
            await openList();
        });
    }

    // ===== Margen e impuestos =====
    // Lo que separa el costo (material + mano de obra) del precio que se cobra.
    // Sin esto la IA presupuestaba a costo y el trabajo quedaba sin ganancia.
    const CAMPOS_MARGEN = {
        '#set-gastos': 'gastos_pct',
        '#set-utilidad': 'utilidad_pct',
        '#set-iibb': 'iibb_pct',
        '#set-iva': 'iva_pct',
    };
    let margenTimer = null;

    async function cargarMargenes() {
        try {
            const { settings, ejemplo } = await API.getSettings();
            for (const [sel, campo] of Object.entries(CAMPOS_MARGEN)) {
                $(sel).value = String(settings[campo] ?? '').replace('.', ',');
            }
            $('#set-aplica-iva').checked = Boolean(settings.aplica_iva);
            pintarEjemploMargen(ejemplo);
        } catch { /* si falla se queda con lo que muestre el formulario */ }
    }

    function pintarEjemploMargen(e) {
        if (!e) return;
        const filas = [
            ['Costo (material + mano de obra)', e.costo_directo],
            ['+ Gastos generales', e.gastos_generales],
            ['+ Utilidad', e.utilidad],
            ['+ Ingresos brutos', e.iibb],
        ];
        if (e.aplica_iva) filas.push(['+ IVA', e.iva]);

        const box = $('#markup-ejemplo');
        box.innerHTML = '<span class="markup-ejemplo-titulo">Un trabajo que te cuesta $100.000 se cobra:</span>';
        for (const [etiqueta, monto] of filas) {
            const row = document.createElement('div');
            row.className = 'markup-row';
            row.innerHTML = '<span></span><span></span>';
            row.children[0].textContent = etiqueta;
            row.children[1].textContent = formatARS(monto);
            box.appendChild(row);
        }
        const total = document.createElement('div');
        total.className = 'markup-row markup-row-total';
        total.innerHTML = '<span></span><span></span>';
        total.children[0].textContent = 'Precio final';
        total.children[1].textContent = formatARS(e.total);
        box.appendChild(total);
    }

    function guardarMargenes() {
        $('#prices-status').textContent = 'Guardando…';
        clearTimeout(margenTimer);
        margenTimer = setTimeout(async () => {
            const body = { aplica_iva: $('#set-aplica-iva').checked };
            for (const [sel, campo] of Object.entries(CAMPOS_MARGEN)) {
                body[campo] = parseQty($(sel).value);
            }
            try {
                const { ejemplo } = await API.saveSettings(body);
                pintarEjemploMargen(ejemplo);
                $('#prices-status').textContent = 'Guardado';
                setTimeout(() => { if ($('#prices-status').textContent === 'Guardado') $('#prices-status').textContent = ''; }, 1500);
            } catch (err) {
                $('#prices-status').textContent = '';
                toast('No se pudo guardar: ' + err.message, true);
            }
        }, 700);
    }

    Object.keys(CAMPOS_MARGEN).forEach(sel => $(sel).addEventListener('input', guardarMargenes));
    $('#set-aplica-iva').addEventListener('change', guardarMargenes);

    function schedulePricesSave() {
        $('#prices-status').textContent = 'Guardando…';
        clearTimeout(pricesTimer);
        pricesTimer = setTimeout(async () => {
            try {
                await API.savePrices(prices);
                $('#prices-status').textContent = 'Guardado';
                setTimeout(() => { if ($('#prices-status').textContent === 'Guardado') $('#prices-status').textContent = ''; }, 1500);
            } catch (err) {
                $('#prices-status').textContent = '';
                toast('No se pudo guardar: ' + err.message, true);
            }
        }, 900);
    }

    function renderPrices() {
        const listEl = $('#prices-list');
        listEl.innerHTML = '';
        prices.forEach((price, index) => {
            const row = document.createElement('div');
            row.className = 'price-row';
            row.innerHTML = `
                <input type="text" class="p-name" placeholder="Ej: Hormigón H21" autocomplete="off">
                <input type="text" class="p-unit" autocomplete="off">
                <input type="number" class="p-price" inputmode="numeric" min="0" step="any" placeholder="$">
                <button class="item-remove" title="Quitar">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>`;
            const nameEl  = row.querySelector('.p-name');
            const unitEl  = row.querySelector('.p-unit');
            const priceEl = row.querySelector('.p-price');
            nameEl.value  = price.name;
            unitEl.value  = price.unit;
            priceEl.value = price.price || '';
            nameEl.addEventListener('input',  () => { price.name = nameEl.value; schedulePricesSave(); });
            unitEl.addEventListener('input',  () => { price.unit = unitEl.value; schedulePricesSave(); });
            priceEl.addEventListener('input', () => { price.price = Number(priceEl.value) || 0; schedulePricesSave(); });
            row.querySelector('.item-remove').addEventListener('click', () => {
                prices.splice(index, 1);
                renderPrices();
                schedulePricesSave();
            });
            listEl.appendChild(row);
        });
    }

    $('#btn-prices').addEventListener('click', () => openPrices().catch(err => toast(err.message, true)));
    $('#btn-prices-back').addEventListener('click', () => Nav.popLayer());
    $('#btn-add-price').addEventListener('click', () => {
        prices.push({ name: '', unit: 'un.', price: 0 });
        renderPrices();
        const inputs = document.querySelectorAll('#prices-list .p-name');
        inputs[inputs.length - 1]?.focus();
    });

    // ================= Editor =================
    async function openEditor(id) {
        const data = await API.getBudget(id);
        currentBudget = {
            id: data.id, name: data.name, client: data.client, notes: data.notes,
            location: data.location || '', validity_days: data.validity_days ?? 10, advance_pct: data.advance_pct ?? 25,
            format: data.format === 'municipal' ? 'municipal' : 'original',
            client_role: data.client_role || '', client_address: data.client_address || '',
            client_cp: data.client_cp || '', client_phone: data.client_phone || '', client_email: data.client_email || '',
        };
        items = data.items.map(i => ({ name: i.name, detail: i.detail || '', quantity: i.quantity, unit: i.unit, unit_price: i.unit_price }));
        $('#budget-name').value = data.name;
        $('#budget-client').value = data.client;
        $('#budget-location').value = currentBudget.location;
        $('#budget-advance').value = currentBudget.advance_pct;
        $('#budget-validity').value = currentBudget.validity_days;
        $('#budget-client-role').value = currentBudget.client_role;
        $('#budget-client-address').value = currentBudget.client_address;
        $('#budget-client-cp').value = currentBudget.client_cp;
        $('#budget-client-phone').value = currentBudget.client_phone;
        $('#budget-client-email').value = currentBudget.client_email;
        applyFormatUI(currentBudget.format);
        hideDraft();
        hideAIPanel();
        renderItems();
        show('editor');
        tabs?.go(0, { animate: false });
        Chat.open();

        // El editor es una capa: el gesto de volver del celular lleva a la lista,
        // no saca de la app.
        Nav.pushLayer('editor', async () => {
            await flushSave();
            await openList();
        });
    }

    // ================= Formato del PDF =================
    function applyFormatUI(format) {
        const muni = format === 'municipal';
        document.querySelectorAll('.format-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.format === format);
        });
        // Campos exclusivos del formato cliente (ubicación, adelanto, validez)
        document.querySelectorAll('.orig-only').forEach(el => { el.hidden = muni; });
        // Campos exclusivos del formato municipio
        $('#municipal-fields').hidden = !muni;
        const hint = $('#format-hint');
        if (hint) hint.textContent = muni
            ? 'Formato formal blanco y negro, para presentar al municipio.'
            : 'Formato con color, para clientes particulares (casas, refacciones).';
    }

    document.querySelectorAll('.format-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            if (!currentBudget) return;
            currentBudget.format = btn.dataset.format;
            applyFormatUI(currentBudget.format);
            scheduleSave();
        });
    });

    $('#budget-client-role').addEventListener('input', scheduleSave);
    $('#budget-client-address').addEventListener('input', scheduleSave);
    $('#budget-client-cp').addEventListener('input', scheduleSave);
    $('#budget-client-phone').addEventListener('input', scheduleSave);
    $('#budget-client-email').addEventListener('input', scheduleSave);

    // ===== Autocompletar datos del cliente (formato municipio) =====
    // Clientes conocidos: se completan al instante, sin IA y sin riesgo de error.
    const KNOWN_CLIENTS = [
        {
            match: ['municipalidad de la capital', 'municipalidad de capital', 'muni capital', 'municipalidad capital'],
            data: { role: 'Dra. Susana Laciar', address: '', cp: 'J5402', phone: '264 6 317574', email: '' },
        },
    ];
    function findKnownClient(name) {
        const n = (name || '').toLowerCase().trim();
        if (!n) return null;
        return (KNOWN_CLIENTS.find(c => c.match.some(m => n.includes(m))) || {}).data || null;
    }
    function applyClientData(d, onlyEmpty) {
        const map = {
            role: '#budget-client-role', address: '#budget-client-address',
            cp: '#budget-client-cp', phone: '#budget-client-phone', email: '#budget-client-email',
        };
        let filled = 0;
        for (const [k, sel] of Object.entries(map)) {
            const el = $(sel);
            const val = d[k] || '';
            if (!val) continue;
            if (onlyEmpty && el.value.trim()) continue;
            if (el.value !== val) { el.value = val; filled++; }
        }
        if (filled) scheduleSave();
        return filled;
    }

    // Auto: al salir del campo "Nombre del cliente", si es conocido completa lo que esté vacío
    $('#budget-client').addEventListener('blur', () => {
        if (!currentBudget || currentBudget.format !== 'municipal') return;
        const known = findKnownClient($('#budget-client').value);
        if (known) applyClientData(known, true);
    });

    // Botón "Completar datos automáticamente": clientes conocidos al instante, el resto con IA
    $('#btn-client-ai').addEventListener('click', async () => {
        const name = $('#budget-client').value.trim();
        if (!name) { toast('Primero escribí el nombre del cliente', true); return; }
        const known = findKnownClient(name);
        if (known) {
            const n = applyClientData(known, false);
            toast(n ? 'Datos del cliente completados' : 'Los datos ya estaban cargados');
            return;
        }
        const btn = $('#btn-client-ai');
        const lbl = btn.querySelector('span');
        const prev = lbl.textContent;
        btn.disabled = true;
        lbl.textContent = 'Buscando con IA…';
        try {
            const d = await API.aiClientData(name);
            const n = applyClientData(d, false);
            toast(n ? 'Datos completados con IA' : 'No encontré datos oficiales de ese cliente', !n);
        } catch (err) {
            toast(err.message, true);
        } finally {
            btn.disabled = false;
            lbl.textContent = prev;
        }
    });

    // La flecha de volver y el gesto del celular hacen exactamente lo mismo.
    $('#btn-back').addEventListener('click', () => Nav.popLayer());

    $('#btn-delete').addEventListener('click', async () => {
        if (!confirm('¿Borrar este presupuesto? No se puede deshacer.')) return;
        await API.deleteBudget(currentBudget.id);
        currentBudget = null;   // flushSave se saltea solo si no hay presupuesto
        Nav.popLayer();
    });

    // Guardado con debounce
    function scheduleSave() {
        $('#save-status').textContent = 'Guardando…';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 900);
    }

    async function flushSave() {
        clearTimeout(saveTimer);
        if (!currentBudget) return;
        try {
            await API.updateBudget(currentBudget.id, {
                name: $('#budget-name').value,
                client: $('#budget-client').value,
                notes: currentBudget.notes,
                location: $('#budget-location').value,
                advance_pct: Number($('#budget-advance').value) || 0,
                validity_days: Number($('#budget-validity').value) || 0,
                format: currentBudget.format || 'original',
                client_role: $('#budget-client-role').value,
                client_address: $('#budget-client-address').value,
                client_cp: $('#budget-client-cp').value,
                client_phone: $('#budget-client-phone').value,
                client_email: $('#budget-client-email').value,
            });
            await API.saveItems(currentBudget.id, items);
            $('#save-status').textContent = 'Guardado';
            setTimeout(() => { if ($('#save-status').textContent === 'Guardado') $('#save-status').textContent = ''; }, 1500);
        } catch (err) {
            $('#save-status').textContent = '';
            toast('No se pudo guardar: ' + err.message, true);
        }
    }

    $('#budget-name').addEventListener('input', scheduleSave);
    $('#budget-client').addEventListener('input', scheduleSave);
    $('#budget-location').addEventListener('input', scheduleSave);
    $('#budget-advance').addEventListener('input', scheduleSave);
    $('#budget-validity').addEventListener('input', scheduleSave);

    // ================= Items =================
    function renderItems() {
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
            descBtn.addEventListener('click', () => openItemModal(index, 'name'));
            toggleEl.addEventListener('click', () => openItemModal(index, 'detail'));
            card.querySelector('.ic-convert-toggle').addEventListener('click', () => openConvertModal({ index }));

            qtyEl.addEventListener('input', () => {
                item.quantity = parseQty(qtyEl.value);
                refreshSub(); updateTotal(); scheduleSave();
            });
            unitEl.addEventListener('click', () => {
                openUnitPicker(item.unit, (label) => {
                    item.unit = label;
                    unitEl.textContent = label;
                    scheduleSave();
                });
            });
            priceEl.addEventListener('input', () => {
                priceEl.value = fmtMoneyInput(priceEl.value);
                item.unit_price = parseNum(priceEl.value);
                refreshSub(); updateTotal(); scheduleSave();
            });
            card.querySelector('.ic-remove').addEventListener('click', () => {
                items.splice(index, 1);
                renderItems();
                scheduleSave();
            });

            listEl.appendChild(card);
        });
        updateTotal();
    }

    function updateTotal() {
        const total = items.reduce((sum, i) => sum + (i.quantity * i.unit_price || 0), 0);
        $('#total-amount').textContent = formatARS(total);
        const w = $('#total-words');
        if (w) w.textContent = enLetras(total);
    }

    $('#btn-add-item').addEventListener('click', () => {
        items.push({ name: '', detail: '', quantity: 1, unit: 'un.', unit_price: 0 });
        renderItems();
        openItemModal(items.length - 1, 'name');
    });

    // ================= Modal de descripción del item =================
    let modalIndex = -1;
    function openItemModal(index, focusField) {
        if (index < 0 || index >= items.length) return;
        modalIndex = index;
        const item = items[index];
        const nameEl = $('#item-modal-name');
        const detailEl = $('#item-modal-detail');
        nameEl.value = item.name || '';
        detailEl.value = item.detail || '';
        hideSuggest();
        $('#item-modal').hidden = false;
        document.body.classList.add('modal-open');
        requestAnimationFrame(() => {
            autoGrow(nameEl); autoGrow(detailEl);
            (focusField === 'detail' ? detailEl : nameEl).focus();
        });
        Nav.pushLayer('item-modal', hideItemModal);
    }

    // El cierre real. Lo corre Nav, venga del botón o del gesto del celular.
    function hideItemModal() {
        $('#item-modal').hidden = true;
        document.body.classList.remove('modal-open');
        hideSuggest();
        modalIndex = -1;
        renderItems();   // refresca el texto de las tarjetas
    }
    // Lo que llaman los botones de la pantalla: pasa por el historial para que
    // el gesto y el botón no se puedan desincronizar.
    function closeItemModal() { Nav.popLayer(); }

    $('#item-modal-name').addEventListener('input', () => {
        if (modalIndex < 0) return;
        const el = $('#item-modal-name');
        items[modalIndex].name = el.value;
        autoGrow(el);
        scheduleSave();
        scheduleSuggest(el, items[modalIndex]);
    });
    $('#item-modal-detail').addEventListener('input', () => {
        if (modalIndex < 0) return;
        const el = $('#item-modal-detail');
        items[modalIndex].detail = el.value;
        autoGrow(el);
        scheduleSave();
    });
    $('#item-modal-done').addEventListener('click', closeItemModal);
    $('#item-modal-close').addEventListener('click', closeItemModal);
    $('#item-modal').addEventListener('click', (e) => { if (e.target.id === 'item-modal') closeItemModal(); });

    function formatQty(n) {
        return (Math.round(n * 1e6) / 1e6).toString().replace('.', ',');
    }

    // ================= Selector de unidad =================
    // El campo de la unidad era texto libre, así que en la base convivían "m2",
    // "M²" y "metros cuadrados" — con eso ninguna conversión era confiable.
    // Ahora se elige de una lista y siempre se guarda la etiqueta canónica.
    let unitCatalog = [];
    let unitPickTarget = null;   // { onPick(label) }

    async function loadUnitCatalog() {
        try {
            const { units } = await API.getUnits();
            unitCatalog = units || [];
        } catch {
            unitCatalog = [];   // sin catálogo el selector cae a texto: no bloquea el trabajo
        }
    }

    function openUnitPicker(currentLabel, onPick) {
        if (!unitCatalog.length) return false;
        unitPickTarget = { onPick };
        const list = $('#unit-list');
        list.innerHTML = '';
        for (const u of unitCatalog) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'unit-option' + (u.label === currentLabel ? ' active' : '');
            btn.innerHTML = `<span class="unit-option-label"></span><span class="unit-option-kind"></span>`;
            btn.querySelector('.unit-option-label').textContent = u.label;
            btn.querySelector('.unit-option-kind').textContent = KIND_LABEL[u.kind] || '';
            btn.addEventListener('click', () => {
                const cb = unitPickTarget?.onPick;
                closeUnitPicker();
                cb?.(u.label);
            });
            list.appendChild(btn);
        }
        $('#unit-modal').hidden = false;
        document.body.classList.add('modal-open');
        Nav.pushLayer('unit-modal', hideUnitPicker);
        return true;
    }
    const KIND_LABEL = {
        length: 'largo', area: 'superficie', volume: 'volumen',
        count: 'cantidad', weight: 'peso', time: 'tiempo', other: '',
    };
    function hideUnitPicker() {
        $('#unit-modal').hidden = true;
        document.body.classList.remove('modal-open');
        unitPickTarget = null;
    }
    function closeUnitPicker() { Nav.popLayer(); }

    $('#unit-modal-close').addEventListener('click', closeUnitPicker);
    $('#unit-modal').addEventListener('click', (e) => { if (e.target.id === 'unit-modal') closeUnitPicker(); });

    // ================= Modal de conversión de unidades =================
    // La cuenta la hace el servidor (server/lib/units.js), no este archivo: es el
    // mismo motor que usan los comandos de la IA, así el botón manual y el pedido
    // hablado no se pueden desincronizar.
    //
    // El camino normal necesita UNA sola medida: para pasar 20 m² a m³ alcanza con
    // el espesor. Ese número viene en la hoja que le da el municipio.
    let convertScope = null;    // { all: true } | { index }
    let convertOptions = [];    // destinos posibles según la unidad de origen
    let convertTarget = null;   // opción elegida

    // Quién es "dueño" de convertScope/convertTarget en este momento.
    //
    // El cierre de una modal pasa por Nav.popLayer() -> history.back(), que es
    // asincrónico: el onClose (hideConvertModal) recién corre cuando llega el
    // popstate, no en el momento del clic. Si en el medio se abre otra conversión
    // (otro item, o "convertir todo"), ese cierre atrasado terminaba pisando el
    // estado de la apertura nueva y dejaba convertScope en null a mitad de un
    // render — con un item convertido a medias mostrando las medidas del anterior.
    //
    // Cada apertura saca un número de sesión y se lo lleva pegado a su propio
    // callback de cierre y a su propia promesa de red. Si cuando alguno de esos
    // dos vuelve la sesión ya cambió, es que llegó tarde: no toca nada.
    let convertSession = 0;

    async function openConvertModal(scope) {
        if (!items.length) { toast('No hay items para convertir', true); return; }
        const session = ++convertSession;
        convertScope = scope;
        convertTarget = null;
        convertOptions = [];
        $('#conv-pieces').value = '1';
        $('#conv-largo').value = '';
        $('#conv-ancho').value = '';
        $('#conv-alto').value = '';
        $('#conv-geometry').open = false;

        const esTodo = scope.all === true;
        $('#convert-modal-title').textContent = esTodo ? 'Convertir todo el presupuesto' : 'Convertir unidad';

        // Con "convertir todo" el origen puede ser mixto; se toma la unidad más
        // usada como referencia para ofrecer destinos, y los items que no se
        // puedan convertir se avisan después, uno por uno.
        const from = esTodo ? unidadMasComun() : items[scope.index]?.unit;
        renderConvertFrom(from, esTodo);

        $('#conv-targets').innerHTML = '<p class="field-hint">Cargando…</p>';
        $('#conv-measures').hidden = true;
        $('#conv-preview').hidden = true;
        $('#conv-geometry').hidden = true;
        $('#convert-apply').disabled = true;

        $('#convert-modal').hidden = false;
        document.body.classList.add('modal-open');
        Nav.pushLayer('convert-modal', () => hideConvertModal(session));

        try {
            const { options } = await API.unitPlan(from);
            if (session !== convertSession) return;   // se cerró/reabrió mientras esperaba la red
            convertOptions = options || [];
        } catch {
            if (session !== convertSession) return;
            convertOptions = [];
        }
        renderConvertTargets();
    }

    function unidadMasComun() {
        const cuenta = new Map();
        for (const it of items) {
            const u = (it.unit || '').trim();
            if (u) cuenta.set(u, (cuenta.get(u) || 0) + 1);
        }
        let mejor = items[0]?.unit || 'un.';
        let max = 0;
        for (const [u, n] of cuenta) if (n > max) { max = n; mejor = u; }
        return mejor;
    }

    function renderConvertFrom(from, esTodo) {
        const box = $('#conv-from');
        if (esTodo) {
            const iguales = items.every(i => i.unit === from);
            box.innerHTML = `
                <span class="conv-from-label">Unidad actual</span>
                <strong class="conv-from-unit"></strong>
                <span class="conv-from-note"></span>`;
            box.querySelector('.conv-from-unit').textContent = from || '—';
            box.querySelector('.conv-from-note').textContent = iguales
                ? `${items.length} item${items.length === 1 ? '' : 's'}`
                : 'Los items que estén en otra unidad se avisan al final';
            return;
        }
        const item = items[convertScope.index];
        box.innerHTML = `
            <span class="conv-from-label">Item actual</span>
            <strong class="conv-from-unit"></strong>
            <span class="conv-from-note"></span>`;
        box.querySelector('.conv-from-unit').textContent =
            `${formatQty(item.quantity)} ${item.unit} × ${formatARS(item.unit_price)}`;
        box.querySelector('.conv-from-note').textContent =
            `Total ${formatARS(item.quantity * item.unit_price)} — no cambia`;
    }

    function renderConvertTargets() {
        const box = $('#conv-targets');
        box.innerHTML = '';
        if (!convertOptions.length) {
            box.innerHTML = '<p class="field-hint">Esta unidad no se puede convertir a ninguna otra. Las horas, los días y los montos globales no son medidas.</p>';
            return;
        }
        for (const opt of convertOptions) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'conv-target' + (convertTarget?.label === opt.label ? ' active' : '');
            btn.innerHTML = `<span class="conv-target-unit"></span><span class="conv-target-need"></span>`;
            btn.querySelector('.conv-target-unit').textContent = opt.label;
            btn.querySelector('.conv-target-need').textContent =
                opt.needs.length ? `pide ${opt.needs.join(' y ')}` : 'directo';
            btn.addEventListener('click', () => {
                convertTarget = opt;
                renderConvertTargets();
                renderConvertMeasures();
            });
            box.appendChild(btn);
        }
    }

    const MEASURE_LABEL = { largo: 'Largo (m)', ancho: 'Ancho (m)', alto: 'Alto o espesor (m)' };

    function renderConvertMeasures() {
        const box = $('#conv-measures');
        if (!convertTarget) { box.hidden = true; return; }

        // Camino B (geometría de la pieza): solo tiene sentido cuando el item está
        // contado en unidades sueltas y hay que expresarlo como medida —
        // "12 plateas de 1.10 × 2 × 0.15" a m³. Para el resto sobra y estorba.
        const origen = convertScope?.all ? unidadMasComun() : items[convertScope.index]?.unit;
        $('#conv-geometry').hidden = !esConteo(origen);

        box.innerHTML = '';
        if (!convertTarget.needs.length) {
            box.hidden = true;
            refreshConvertPreview();
            return;
        }

        // El item casi siempre ya tiene la medida escrita ("platea 0.80m x 0.50m
        // x 0.15m"): se lee de ahí en vez de pedírsela de nuevo. Solo aplica a un
        // item puntual — en "convertir todo" cada uno trae su propio texto, y
        // completar con el de uno solo sería inventarle la medida a los demás.
        let autocompletado = null;
        if (!convertScope?.all) {
            const item = items[convertScope.index];
            const texto = `${item?.name || ''}\n${item?.detail || ''}`;
            const { valores, fuente } = Medidas.medidasPara(convertTarget.needs, texto);
            if (Object.keys(valores).length) autocompletado = { valores, fuente };
        }

        for (const m of convertTarget.needs) {
            const label = document.createElement('label');
            label.className = 'opt-field';
            label.innerHTML = `<span></span><input type="text" inputmode="decimal" placeholder="0" data-measure="${m}">`;
            label.querySelector('span').textContent = MEASURE_LABEL[m] || m;
            const input = label.querySelector('input');
            if (autocompletado?.valores[m] !== undefined) {
                input.value = formatQty(autocompletado.valores[m]);
                // Se distingue visualmente que vino solo, no porque haga falta
                // confiar ciegamente: sigue siendo un input común, editable.
                input.classList.add('opt-field-auto');
            }
            input.addEventListener('input', () => {
                input.classList.remove('opt-field-auto');   // ya no es lo que se leyó, es lo que tipeó
                refreshConvertPreview();
            });
            box.appendChild(label);
        }

        if (autocompletado) {
            const hint = document.createElement('p');
            hint.className = 'field-hint conv-measures-hint';
            hint.textContent = `Tomado de la descripción ("${autocompletado.fuente}") — revisalo y corregilo si hace falta.`;
            box.appendChild(hint);
        }

        box.hidden = false;
        requestAnimationFrame(() => {
            // Si ya se completó solo, no hace falta forzar el foco ni el teclado.
            if (!autocompletado) box.querySelector('input')?.focus();
        });
        refreshConvertPreview();
    }

    function esConteo(unit) {
        const u = unitCatalog.find(x => x.label === unit);
        return u ? u.kind === 'count' : false;
    }

    function leerMedidas() {
        const out = {};
        $('#conv-measures').querySelectorAll('input[data-measure]').forEach(inp => {
            out[inp.dataset.measure] = parseQty(inp.value) || 0;
        });
        const geo = $('#conv-geometry');
        if (!geo.hidden && geo.open) {
            out.pieces = parseQty($('#conv-pieces').value) || 0;
            out.largo  = parseQty($('#conv-largo').value) || out.largo || 0;
            out.ancho  = parseQty($('#conv-ancho').value) || out.ancho || 0;
            out.alto   = parseQty($('#conv-alto').value)  || out.alto  || 0;
        }
        return out;
    }

    // Pide la conversión al servidor y muestra cómo quedaría, sin aplicar nada.
    let previewTimer = null;
    let previewOps = [];
    function refreshConvertPreview() {
        clearTimeout(previewTimer);
        previewTimer = setTimeout(async () => {
            if (!convertTarget) return;
            const medidas = leerMedidas();
            const faltan = (convertTarget.needs || []).filter(m => !(medidas[m] > 0));
            const box = $('#conv-preview');

            if (faltan.length && !(medidas.pieces > 0)) {
                box.hidden = false;
                box.className = 'conv-preview conv-preview-wait';
                box.textContent = `Cargá ${faltan.map(m => (MEASURE_LABEL[m] || m).toLowerCase()).join(' y ')} para ver el resultado.`;
                $('#convert-apply').disabled = true;
                previewOps = [];
                return;
            }

            try {
                const { ops, warnings } = await API.convertUnits({
                    items,
                    target_unit: convertTarget.label,
                    ...(convertScope.all ? { all: true } : { num: convertScope.index + 1 }),
                    ...medidas,
                });
                previewOps = ops || [];
                renderPreviewBox(previewOps, warnings || []);
            } catch (err) {
                box.hidden = false;
                box.className = 'conv-preview conv-preview-error';
                box.textContent = err.message;
                $('#convert-apply').disabled = true;
                previewOps = [];
            }
        }, 180);
    }

    function renderPreviewBox(ops, warnings) {
        const box = $('#conv-preview');
        box.hidden = false;
        box.innerHTML = '';

        if (!ops.length) {
            box.className = 'conv-preview conv-preview-error';
            box.textContent = warnings[0] || 'No se pudo convertir con esas medidas.';
            $('#convert-apply').disabled = true;
            return;
        }

        box.className = 'conv-preview';
        for (const op of ops.slice(0, 6)) {
            const cur = items[op.num - 1];
            const row = document.createElement('div');
            row.className = 'conv-preview-row';
            row.innerHTML = `<span class="conv-preview-name"></span><span class="conv-preview-calc"></span>`;
            row.querySelector('.conv-preview-name').textContent = cur?.name || `Item ${op.num}`;
            row.querySelector('.conv-preview-calc').textContent =
                `${formatQty(cur?.quantity)} ${cur?.unit} → ${formatQty(op.fields.quantity)} ${op.fields.unit} · ${formatARS(op.fields.unit_price)}/${op.fields.unit}`;
            box.appendChild(row);
        }
        if (ops.length > 6) {
            const mas = document.createElement('div');
            mas.className = 'conv-preview-more';
            mas.textContent = `y ${ops.length - 6} item${ops.length - 6 === 1 ? '' : 's'} más`;
            box.appendChild(mas);
        }
        for (const w of warnings.slice(0, 4)) {
            const av = document.createElement('div');
            av.className = 'conv-preview-warn';
            av.textContent = w;
            box.appendChild(av);
        }
        $('#convert-apply').disabled = false;
    }

    function hideConvertModal(session) {
        // Llegó tarde: ya hay una apertura más nueva dueña del estado. Tocarlo
        // ahora sería el bug que esto arregla (ver el comentario en convertSession).
        if (session !== convertSession) return;
        $('#convert-modal').hidden = true;
        document.body.classList.remove('modal-open');
        convertScope = null;
        convertTarget = null;
        previewOps = [];
    }
    function closeConvertModal() { Nav.popLayer(); }

    $('#convert-apply').addEventListener('click', () => {
        if (!previewOps.length) return;
        const ops = previewOps;
        const esTodo = convertScope?.all === true;
        closeConvertModal();

        for (const op of ops) {
            const idx = op.num - 1;
            if (items[idx]) Object.assign(items[idx], op.fields);
        }
        renderItems();
        scheduleSave();
        toast(esTodo
            ? `${ops.length} item${ops.length === 1 ? '' : 's'} convertido${ops.length === 1 ? '' : 's'}`
            : 'Unidad convertida a ' + ops[0].fields.unit);
    });

    ['#conv-pieces', '#conv-largo', '#conv-ancho', '#conv-alto'].forEach(sel => {
        $(sel).addEventListener('input', refreshConvertPreview);
    });
    $('#conv-geometry').addEventListener('toggle', refreshConvertPreview);
    $('#convert-modal-close').addEventListener('click', closeConvertModal);
    $('#convert-modal').addEventListener('click', (e) => { if (e.target.id === 'convert-modal') closeConvertModal(); });
    $('#btn-convert-all').addEventListener('click', () => openConvertModal({ all: true }));

    // Escape en la compu equivale al gesto de volver en el celular: cierra la
    // capa de arriba, sea la que sea.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') Nav.popLayer();
    });

    // ================= Sugerencias IA (dentro de la modal) =================
    // Antes esto llamaba a hideSuggest() en CADA tecla y volvía a mostrar 600 ms
    // después. Como la caja estaba en el flujo, colapsaba y expandía todo el rato.
    // Ahora las sugerencias viejas se quedan hasta que llegan las nuevas, y la
    // caja flota (ver .modal-suggest en el CSS), así que ya no empuja nada.
    function scheduleSuggest(inputEl, item) {
        clearTimeout(suggestTimer);
        const query = inputEl.value.trim();
        if (query.length < 3) { hideSuggest(); return; }

        suggestTimer = setTimeout(async () => {
            try {
                const { suggestions } = await API.aiSuggest(query, items);
                // Si mientras tanto se fue del campo o cambió lo que escribió,
                // no pisamos nada.
                if (document.activeElement !== inputEl) return;
                if (!suggestions.length) { hideSuggest(); return; }
                showSuggest(suggestions, item);
            } catch { /* sugerencias son best-effort */ }
        }, 600);
    }

    function showSuggest(suggestions, item) {
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
                scheduleSave();
                hideSuggest();
            });
            box.appendChild(chip);
        }
        box.hidden = false;
    }

    function hideSuggest() {
        const b = $('#item-modal-suggest');
        if (b) { b.hidden = true; b.innerHTML = ''; }
    }

    // ================= Texto libre → IA =================
    $('#btn-ai-text').addEventListener('click', () => {
        hideDraft();
        $('#ai-panel').hidden = false;
        $('#ai-text').focus();
    });
    $('#btn-ai-cancel').addEventListener('click', hideAIPanel);

    function hideAIPanel() { $('#ai-panel').hidden = true; }

    $('#btn-ai-send').addEventListener('click', async () => {
        const text = $('#ai-text').value.trim();
        if (!text) return;
        const btn = $('#btn-ai-send');
        btn.disabled = true;
        btn.textContent = 'Procesando…';
        try {
            const { ops, summary } = await API.aiCommand(text, items);
            if (!ops.length) {
                toast(summary || 'La IA no encontró cambios para hacer', true);
            } else {
                $('#ai-text').value = '';
                hideAIPanel();
                showOps(ops, summary);
            }
        } catch (err) {
            toast(err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Aplicar con IA';
        }
    });

    // ================= Borrador de cambios IA (agregar / editar / borrar) =================
    // Envoltorio para que el flujo de importar archivos (que solo agrega items nuevos)
    // reuse el mismo panel de confirmación que los comandos de la IA.
    function itemsToAddOps(parsedItems) {
        return parsedItems.map(item => ({ action: 'add', item }));
    }

    function describeOp(op) {
        if (op.action === 'add') {
            const d = op.item;
            return {
                tag: '+ Nuevo', tagClass: 'draft-op-add',
                title: d.name,
                detail: `${formatQty(d.quantity)} ${d.unit} × ${formatARS(d.unit_price)}`,
            };
        }
        const cur = items[op.num - 1];
        if (op.action === 'update') {
            const f = op.fields;
            const changes = [];
            if (f.quantity !== undefined || f.unit !== undefined) {
                changes.push(`${formatQty(cur?.quantity)} ${cur?.unit} → ${formatQty(f.quantity ?? cur?.quantity)} ${f.unit ?? cur?.unit}`);
            }
            if (f.unit_price !== undefined) changes.push(`${formatARS(cur?.unit_price)} → ${formatARS(f.unit_price)}`);
            if (f.name !== undefined) changes.push(`nombre → "${f.name}"`);
            if (f.detail !== undefined) changes.push('detalle actualizado');
            return {
                tag: `✎ Item ${op.num}`, tagClass: 'draft-op-update',
                title: cur ? cur.name : `Item ${op.num}`,
                detail: changes.join(' · '),
            };
        }
        // remove
        return {
            tag: `✕ Borrar item ${op.num}`, tagClass: 'draft-op-remove',
            title: cur ? cur.name : `Item ${op.num}`,
            detail: '',
        };
    }

    function showOps(ops, summary) {
        draftOps = ops;
        const listEl = $('#draft-list');
        listEl.innerHTML = '';
        if (summary) {
            const s = document.createElement('p');
            s.className = 'draft-summary';
            s.textContent = summary;
            listEl.appendChild(s);
        }
        for (const op of ops) {
            const d = describeOp(op);
            const row = document.createElement('div');
            row.className = 'draft-item';
            row.innerHTML = `
                <div class="draft-item-main">
                    <span class="draft-op-tag ${d.tagClass}">${d.tag}</span>
                    <span>${d.title}</span>
                </div>
                <span class="draft-item-detail">${d.detail}</span>`;
            listEl.appendChild(row);
        }
        // Una hoja puede leerse bien y no proponer ningún cambio aplicable (todo
        // fue a "no encontré a qué item corresponde"). Ahí el resumen importa,
        // pero ofrecer "Aplicar" no tendría sentido.
        $('#btn-draft-add').hidden = !ops.length;
        $('#draft-panel').hidden = false;
    }

    function hideDraft() {
        $('#draft-panel').hidden = true;
        $('#btn-draft-add').hidden = false;
        draftOps = [];
    }

    $('#btn-draft-cancel').addEventListener('click', hideDraft);
    $('#btn-draft-add').addEventListener('click', () => {
        // Orden importante para no romper la numeración: primero editar (índices intactos),
        // después borrar (de mayor a menor num, así no se corren los índices todavía por procesar),
        // recién al final agregar los nuevos.
        draftOps.filter(o => o.action === 'update').forEach(op => {
            const idx = op.num - 1;
            if (items[idx]) Object.assign(items[idx], op.fields);
        });
        draftOps.filter(o => o.action === 'remove').map(o => o.num).sort((a, b) => b - a).forEach(num => {
            items.splice(num - 1, 1);
        });
        draftOps.filter(o => o.action === 'add').forEach(op => items.push(op.item));
        hideDraft();
        renderItems();
        scheduleSave();
        toast('Cambios aplicados');
    });

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
            renderItems();
            if (changed) {
                scheduleSave();
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

    // ================= Importar archivo (PDF / Excel / CSV) =================
    const EXT_ARCHIVO = ['pdf', 'xlsx', 'csv'];
    const EXT_FOTO    = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

    $('#btn-import').addEventListener('click', () => {
        // Con items cargados, una foto puede ser dos cosas muy distintas: una
        // lista para importar, o la hoja de cambios que le devolvió el municipio.
        // Preguntarlo es más barato que adivinar mal.
        if (items.length) { openImportChoice(); return; }
        pedirArchivo('import');
    });

    let importMode = 'import';
    function pedirArchivo(mode) {
        importMode = mode;
        const input = $('#import-file');
        input.accept = mode === 'changes'
            ? 'image/*'
            : '.pdf,.xlsx,.csv,image/*';
        input.click();
    }

    function openImportChoice() {
        $('#import-choice').hidden = false;
        document.body.classList.add('modal-open');
        Nav.pushLayer('import-choice', () => {
            $('#import-choice').hidden = true;
            document.body.classList.remove('modal-open');
        });
    }
    $('#import-choice-close').addEventListener('click', () => Nav.popLayer());
    $('#import-choice').addEventListener('click', (e) => { if (e.target.id === 'import-choice') Nav.popLayer(); });
    $('#choice-changes').addEventListener('click', () => { Nav.popLayer(); pedirArchivo('changes'); });
    $('#choice-import').addEventListener('click',  () => { Nav.popLayer(); pedirArchivo('import'); });

    $('#import-file').addEventListener('change', async (e) => {
        const file = e.target.files[0];
        e.target.value = '';   // permite re-subir el mismo archivo
        if (!file) return;
        const ext = (file.name.split('.').pop() || '').toLowerCase();
        const esFoto = EXT_FOTO.includes(ext);

        if (!esFoto && !EXT_ARCHIVO.includes(ext)) {
            toast('Subí una foto, un PDF, un Excel (.xlsx) o un CSV', true);
            return;
        }
        if (importMode === 'changes' && !esFoto) {
            toast('La hoja de cambios tiene que ser una foto', true);
            return;
        }

        const btn = $('#btn-import');
        const lbl = $('#import-label');
        const prev = lbl.textContent;
        btn.disabled = true;
        lbl.textContent = 'Leyendo…';
        hideAIPanel();
        hideDraft();
        try {
            if (importMode === 'changes') {
                // Las ops vienen numeradas contra lo que está GUARDADO, así que
                // hay que asegurarse de que no quede nada pendiente de guardar.
                await flushSave();
                const { ops, summary } = await API.readChangeSheet(file, ext, currentBudget.id);
                if (!ops.length) {
                    toast(summary || 'No encontré cambios en esa hoja', true);
                    if (summary) showOps([], summary);
                } else {
                    showOps(ops, summary);
                    toast(`${ops.length} cambio${ops.length === 1 ? '' : 's'} propuesto${ops.length === 1 ? '' : 's'}`);
                }
            } else {
                const { items: parsed } = esFoto
                    ? await API.readPhotoItems(file, ext)
                    : await API.importFile(file, ext);
                if (!parsed.length) {
                    toast('No encontré items en ese archivo', true);
                } else {
                    showOps(itemsToAddOps(parsed), '');
                    toast(`${parsed.length} item${parsed.length === 1 ? '' : 's'} detectado${parsed.length === 1 ? '' : 's'}`);
                }
            }
        } catch (err) {
            toast(err.message, true);
        } finally {
            btn.disabled = false;
            lbl.textContent = prev;
        }
    });

    // ================= Voz =================
    const voiceBtn = $('#btn-voice');
    const voiceLabel = $('#voice-label');

    voiceBtn.addEventListener('click', () => {
        if (!Voice.isSupported()) {
            toast('Tu navegador no soporta grabación de audio. Actualizalo.', true);
            return;
        }
        if (Voice.isActive()) {
            Voice.stop();
            return;
        }
        hideAIPanel();
        hideDraft();

        Voice.start({
            onTick(secs) {
                voiceBtn.classList.add('recording');
                const mm = String(Math.floor(secs / 60));
                const ss = String(secs % 60).padStart(2, '0');
                voiceLabel.textContent = `Grabando ${mm}:${ss} — tocá para parar`;
            },
            async onStop(blob) {
                voiceBtn.classList.remove('recording');
                if (blob.size < 1500) {
                    voiceLabel.textContent = 'Dictar';
                    toast('La grabación quedó muy corta', true);
                    return;
                }
                voiceLabel.textContent = 'Transcribiendo…';
                try {
                    const { text } = await API.aiTranscribe(blob);
                    voiceLabel.textContent = 'Armando items…';
                    const { ops, summary } = await API.aiCommand(text, items);
                    if (!ops.length) toast(summary || `Se escuchó "${text.slice(0, 60)}" pero no se encontraron cambios`, true);
                    else showOps(ops, summary);
                } catch (err) {
                    toast(err.message, true);
                } finally {
                    voiceLabel.textContent = 'Dictar';
                }
            },
            onError(msg) {
                voiceBtn.classList.remove('recording');
                voiceLabel.textContent = 'Dictar';
                toast(msg, true);
            },
        });
    });

    // ================= PDF =================
    $('#btn-pdf').addEventListener('click', async () => {
        await flushSave();
        const budget = {
            ...currentBudget,
            name: $('#budget-name').value,
            client: $('#budget-client').value,
            location: $('#budget-location').value,
            advance_pct: Number($('#budget-advance').value) || 0,
            validity_days: Number($('#budget-validity').value) || 0,
            format: currentBudget.format || 'original',
            client_role: $('#budget-client-role').value,
            client_address: $('#budget-client-address').value,
            client_cp: $('#budget-client-cp').value,
            client_phone: $('#budget-client-phone').value,
            client_email: $('#budget-client-email').value,
        };
        const validItems = items.filter(i => i.name.trim());
        if (!validItems.length) {
            toast('Agregá al menos un item antes de exportar', true);
            return;
        }
        exportBudgetPDF(budget, validItems);
    });

    // ================= Init =================
    (async function init() {
        Theme.init();

        // El chat no toca los items por su cuenta: se le pasan los enganches y
        // todo lo que modifica el presupuesto sigue pasando por acá.
        Chat.init({
            getBudgetId: () => currentBudget?.id,
            getItems: () => items,
            applyOps: (ops) => {
                // Mismo orden que el panel de borrador: primero editar (los
                // índices siguen intactos), después borrar de mayor a menor, y
                // recién al final agregar.
                ops.filter(o => o.action === 'update').forEach(op => {
                    if (items[op.num - 1]) Object.assign(items[op.num - 1], op.fields);
                });
                ops.filter(o => o.action === 'remove').map(o => o.num).sort((a, b) => b - a)
                    .forEach(num => items.splice(num - 1, 1));
                ops.filter(o => o.action === 'add').forEach(op => items.push(op.item));
                renderItems();
                scheduleSave();
                toast('Cambios aplicados');
            },
            toast,
        });

        // Pestañas del editor: Presupuesto · Asistente · PDF
        tabs = Nav.setupTabs({
            track: $('#editor-track'),
            buttons: [...document.querySelectorAll('.tab-btn')],
            onChange: (i) => {
                // El total no aporta nada en la pestaña del asistente y ahí el
                // espacio vertical se necesita para la conversación.
                $('#view-editor').querySelector('.totalbar').hidden = (i === 1);
            },
        });

        if (!API.getToken()) return show('login');
        try {
            await openList();
        } catch {
            show('login');
        }
    })();
})();
