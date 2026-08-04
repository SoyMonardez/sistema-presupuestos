// El coordinador: qué pantalla se ve, quién entra, qué presupuesto está abierto.
//
// Este archivo tenía 1469 líneas y hacía todo. El problema no era el largo sino
// que las veinte variables de estado estaban sueltas al alcance de las cincuenta
// y pico de funciones: cualquiera podía pisarle el estado a cualquiera, que es
// exactamente cómo apareció el bug del conversor de unidades.
//
// Ahora cada área vive en su archivo y este solo pega las partes:
//
//   ui.js         piezas comunes ($, toast, números)
//   estado.js     el presupuesto abierto, sus items y el guardado
//   items.js      la lista de items y su modal
//   unidades.js   catálogo, selector y conversión
//   borrador.js   el panel de confirmar cambios de la IA
//   entradas.js   texto libre, dictado, importar archivo/foto
//   precios.js    tarifario y márgenes
//
// Lo que queda acá: login, lista de presupuestos, abrir/cerrar el editor, los
// datos de cabecera (cliente, obra, formato) y el PDF.

(() => {
    const { $, toast } = UI;

    const views = {
        login:  $('#view-login'),
        list:   $('#view-list'),
        editor: $('#view-editor'),
        prices: $('#view-prices'),
    };

    let tabs = null;            // control de las pestañas del editor (nav.js)

    // ================= Navegación =================
    function show(name) {
        Object.values(views).forEach(v => v.hidden = true);
        views[name].hidden = false;
        window.scrollTo(0, 0);
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
        Estado.cerrar();
        Nav.closeAll();     // que no queden capas colgadas en el historial
        show('login');
    });

    window.addEventListener('auth-expired', () => {
        toast('Tu sesión venció, entrá de nuevo', true);
        Estado.cerrar();
        Nav.closeAll();
        show('login');
    });

    // ================= Lista =================
    async function openList() {
        // El catálogo se pide una sola vez por sesión: lo necesitan el selector de
        // unidad de cada item y el conversor.
        Unidades.cargarCatalogo();
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

    // ================= Editor =================
    async function openEditor(id) {
        const data = await API.getBudget(id);
        Estado.abrir({
            id: data.id, name: data.name, client: data.client, notes: data.notes,
            location: data.location || '', validity_days: data.validity_days ?? 10, advance_pct: data.advance_pct ?? 25,
            format: data.format === 'municipal' ? 'municipal' : 'original',
            client_role: data.client_role || '', client_address: data.client_address || '',
            client_cp: data.client_cp || '', client_phone: data.client_phone || '', client_email: data.client_email || '',
        }, data.items.map(i => ({
            name: i.name, detail: i.detail || '', quantity: i.quantity, unit: i.unit, unit_price: i.unit_price,
        })));

        const b = Estado.actual();
        $('#budget-name').value = data.name;
        $('#budget-client').value = data.client;
        $('#budget-location').value = b.location;
        $('#budget-advance').value = b.advance_pct;
        $('#budget-validity').value = b.validity_days;
        $('#budget-client-role').value = b.client_role;
        $('#budget-client-address').value = b.client_address;
        $('#budget-client-cp').value = b.client_cp;
        $('#budget-client-phone').value = b.client_phone;
        $('#budget-client-email').value = b.client_email;
        applyFormatUI(b.format);
        Borrador.ocultar();
        Entradas.ocultarPanel();
        Estado.render();
        show('editor');
        tabs?.go(0, { animate: false });
        Chat.open();

        // El editor es una capa: el gesto de volver del celular lleva a la lista,
        // no saca de la app.
        Nav.pushLayer('editor', async () => {
            await Estado.flushSave();
            await openList();
        });
    }

    // La flecha de volver y el gesto del celular hacen exactamente lo mismo.
    $('#btn-back').addEventListener('click', () => Nav.popLayer());

    $('#btn-delete').addEventListener('click', async () => {
        if (!confirm('¿Borrar este presupuesto? No se puede deshacer.')) return;
        await API.deleteBudget(Estado.actual().id);
        Estado.cerrar();   // flushSave se saltea solo si no hay presupuesto
        Nav.popLayer();
    });

    // ===== Cabecera del presupuesto =====
    // Cómo se lee el formulario. Lo usa Estado cada vez que guarda; vive acá
    // porque estos #id son de esta pantalla y de ninguna otra.
    function leerCampos() {
        const b = Estado.actual() || {};
        return {
            name: $('#budget-name').value,
            client: $('#budget-client').value,
            notes: b.notes,
            location: $('#budget-location').value,
            advance_pct: Number($('#budget-advance').value) || 0,
            validity_days: Number($('#budget-validity').value) || 0,
            format: b.format || 'original',
            client_role: $('#budget-client-role').value,
            client_address: $('#budget-client-address').value,
            client_cp: $('#budget-client-cp').value,
            client_phone: $('#budget-client-phone').value,
            client_email: $('#budget-client-email').value,
        };
    }

    [
        '#budget-name', '#budget-client', '#budget-location', '#budget-advance', '#budget-validity',
        '#budget-client-role', '#budget-client-address', '#budget-client-cp',
        '#budget-client-phone', '#budget-client-email',
    ].forEach(sel => $(sel).addEventListener('input', Estado.scheduleSave));

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
            if (!Estado.hayPresupuesto()) return;
            Estado.set('format', btn.dataset.format);
            applyFormatUI(btn.dataset.format);
            Estado.scheduleSave();
        });
    });

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
        if (filled) Estado.scheduleSave();
        return filled;
    }

    // Auto: al salir del campo "Nombre del cliente", si es conocido completa lo que esté vacío
    $('#budget-client').addEventListener('blur', () => {
        if (Estado.actual()?.format !== 'municipal') return;
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

    // Escape en la compu equivale al gesto de volver en el celular: cierra la
    // capa de arriba, sea la que sea.
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') Nav.popLayer();
    });

    // ================= PDF =================
    $('#btn-pdf').addEventListener('click', async () => {
        await Estado.flushSave();
        const budget = { ...Estado.actual(), ...leerCampos() };
        const validItems = Estado.lista().filter(i => i.name.trim());
        if (!validItems.length) {
            toast('Agregá al menos un item antes de exportar', true);
            return;
        }
        exportBudgetPDF(budget, validItems);
    });

    // ================= Init =================
    (async function init() {
        Theme.init();

        // Estado sabe guardar, pero no sabe de esta pantalla: acá se le enseña a
        // leer el formulario. Quién repinta la lista de items lo registra items.js.
        Estado.conectar({ campos: leerCampos });

        Precios.init({ mostrar: show, alSalir: openList });

        // El chat no toca los items por su cuenta: se le pasan los enganches y
        // todo lo que modifica el presupuesto sigue pasando por Estado.
        Chat.init({
            getBudgetId: () => Estado.actual()?.id,
            getItems: () => Estado.lista(),
            applyOps: (ops) => {
                Estado.aplicarYGuardar(ops);
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
