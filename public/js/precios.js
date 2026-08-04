// Pantalla de "Precios base": el tarifario y los márgenes.
//
// El tarifario es la lista de precios de referencia que usa la IA para sugerir.
// Los márgenes son lo que separa el COSTO (material + mano de obra) del PRECIO
// que se cobra: sin eso la IA presupuestaba a costo y el trabajo quedaba sin
// ganancia — un muro de 9 m a $600.000 no paga proveedores, empleados e
// impuestos. La cuenta la hace el servidor (server/lib/markup.js); acá solo se
// cargan los porcentajes y se muestra el ejemplo.

const Precios = (() => {
    const { $, toast, parseQty } = UI;

    let prices = [];
    let pricesTimer = null;
    let margenTimer = null;

    // Cómo volver a la pantalla anterior. Lo pone app.js, que es quien sabe de
    // vistas; este módulo solo sabe de precios.
    let mostrarVista = () => {};
    let volver = async () => {};

    function init({ mostrar, alSalir }) {
        if (mostrar) mostrarVista = mostrar;
        if (alSalir) volver = alSalir;
    }

    async function abrir() {
        prices = (await API.getPrices()).map(p => ({ name: p.name, unit: p.unit, price: p.price }));
        render();
        cargarMargenes();
        mostrarVista('prices');
        Nav.pushLayer('prices', async () => {
            clearTimeout(pricesTimer);
            // Si el último guardado falla hay que decirlo. Antes esto era un
            // catch vacío: se perdían los precios que acababa de cargar y volvía
            // a la lista convencido de que habían quedado guardados.
            try {
                await API.savePrices(prices);
            } catch (err) {
                toast('No se pudieron guardar los precios: ' + err.message, true);
            }
            await volver();
        });
    }

    // ================= Margen e impuestos =================
    const CAMPOS_MARGEN = {
        '#set-gastos': 'gastos_pct',
        '#set-utilidad': 'utilidad_pct',
        '#set-iibb': 'iibb_pct',
        '#set-iva': 'iva_pct',
    };

    async function cargarMargenes() {
        try {
            const { settings, ejemplo } = await API.getSettings();
            for (const [sel, campo] of Object.entries(CAMPOS_MARGEN)) {
                $(sel).value = String(settings[campo] ?? '').replace('.', ',');
            }
            $('#set-aplica-iva').checked = Boolean(settings.aplica_iva);
            pintarEjemplo(ejemplo);
        } catch { /* si falla se queda con lo que muestre el formulario */ }
    }

    function pintarEjemplo(e) {
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
                pintarEjemplo(ejemplo);
                marcarGuardado();
            } catch (err) {
                $('#prices-status').textContent = '';
                toast('No se pudo guardar: ' + err.message, true);
            }
        }, 700);
    }

    function marcarGuardado() {
        $('#prices-status').textContent = 'Guardado';
        setTimeout(() => {
            if ($('#prices-status').textContent === 'Guardado') $('#prices-status').textContent = '';
        }, 1500);
    }

    Object.keys(CAMPOS_MARGEN).forEach(sel => $(sel).addEventListener('input', guardarMargenes));
    $('#set-aplica-iva').addEventListener('change', guardarMargenes);

    // ================= Tarifario =================
    function agendarGuardado() {
        $('#prices-status').textContent = 'Guardando…';
        clearTimeout(pricesTimer);
        pricesTimer = setTimeout(async () => {
            try {
                await API.savePrices(prices);
                marcarGuardado();
            } catch (err) {
                $('#prices-status').textContent = '';
                toast('No se pudo guardar: ' + err.message, true);
            }
        }, 900);
    }

    function render() {
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
            nameEl.addEventListener('input',  () => { price.name = nameEl.value; agendarGuardado(); });
            unitEl.addEventListener('input',  () => { price.unit = unitEl.value; agendarGuardado(); });
            priceEl.addEventListener('input', () => { price.price = Number(priceEl.value) || 0; agendarGuardado(); });
            row.querySelector('.item-remove').addEventListener('click', () => {
                prices.splice(index, 1);
                render();
                agendarGuardado();
            });
            listEl.appendChild(row);
        });
    }

    $('#btn-prices').addEventListener('click', () => abrir().catch(err => toast(err.message, true)));
    $('#btn-prices-back').addEventListener('click', () => Nav.popLayer());
    $('#btn-add-price').addEventListener('click', () => {
        prices.push({ name: '', unit: 'un.', price: 0 });
        render();
        const inputs = document.querySelectorAll('#prices-list .p-name');
        inputs[inputs.length - 1]?.focus();
    });

    return { init, abrir };
})();
