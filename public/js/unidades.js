// Unidades: el catálogo, el selector, y la conversión.
//
// El campo de la unidad era texto libre, así que en la base convivían "m2", "M²"
// y "metros cuadrados" — con eso ninguna conversión era confiable. Ahora se elige
// de una lista y siempre se guarda la etiqueta canónica.
//
// La cuenta de convertir la hace el servidor (server/lib/units.js), no este
// archivo: es el mismo motor que usan los comandos de la IA, así el botón manual
// y el pedido hablado no se pueden desincronizar.

const Unidades = (() => {
    const { $, toast, parseQty, formatQty } = UI;

    // La identidad del array no cambia nunca (ver estado.js), así que alcanza con
    // pedirlo una vez.
    const items = Estado.lista();

    let catalogo = [];
    let pickTarget = null;   // { onPick(label) }

    const KIND_LABEL = {
        length: 'largo', area: 'superficie', volume: 'volumen',
        count: 'cantidad', weight: 'peso', time: 'tiempo', other: '',
    };

    async function cargarCatalogo() {
        if (catalogo.length) return;
        try {
            const { units } = await API.getUnits();
            catalogo = units || [];
        } catch {
            catalogo = [];   // sin catálogo el selector cae a texto: no bloquea el trabajo
        }
    }

    // ================= Selector de unidad =================
    function abrirPicker(currentLabel, onPick) {
        if (!catalogo.length) return false;
        pickTarget = { onPick };
        const list = $('#unit-list');
        list.innerHTML = '';
        for (const u of catalogo) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'unit-option' + (u.label === currentLabel ? ' active' : '');
            btn.innerHTML = `<span class="unit-option-label"></span><span class="unit-option-kind"></span>`;
            btn.querySelector('.unit-option-label').textContent = u.label;
            btn.querySelector('.unit-option-kind').textContent = KIND_LABEL[u.kind] || '';
            btn.addEventListener('click', () => {
                const cb = pickTarget?.onPick;
                cerrarPicker();
                cb?.(u.label);
            });
            list.appendChild(btn);
        }
        $('#unit-modal').hidden = false;
        document.body.classList.add('modal-open');
        Nav.pushLayer('unit-modal', ocultarPicker);
        return true;
    }

    function ocultarPicker() {
        $('#unit-modal').hidden = true;
        document.body.classList.remove('modal-open');
        pickTarget = null;
    }
    function cerrarPicker() { Nav.popLayer(); }

    $('#unit-modal-close').addEventListener('click', cerrarPicker);
    $('#unit-modal').addEventListener('click', (e) => { if (e.target.id === 'unit-modal') cerrarPicker(); });

    // ================= Modal de conversión =================
    // El camino normal necesita UNA sola medida: para pasar 20 m² a m³ alcanza con
    // el espesor. Ese número viene en la hoja que le da el municipio.
    let convertScope = null;    // { all: true } | { index }
    let convertOptions = [];    // destinos posibles según la unidad de origen
    let convertTarget = null;   // opción elegida

    // Quién es "dueño" de convertScope/convertTarget en este momento.
    //
    // El cierre de una modal pasa por Nav.popLayer() -> history.back(), que es
    // asincrónico: el onClose (ocultarConversion) recién corre cuando llega el
    // popstate, no en el momento del clic. Si en el medio se abre otra conversión
    // (otro item, o "convertir todo"), ese cierre atrasado terminaba pisando el
    // estado de la apertura nueva y dejaba convertScope en null a mitad de un
    // render — con un item convertido a medias mostrando las medidas del anterior.
    //
    // Cada apertura saca un número de sesión y se lo lleva pegado a su propio
    // callback de cierre y a su propia promesa de red. Si cuando alguno de esos
    // dos vuelve la sesión ya cambió, es que llegó tarde: no toca nada.
    let convertSession = 0;

    const MEASURE_LABEL = { largo: 'Largo (m)', ancho: 'Ancho (m)', alto: 'Alto o espesor (m)' };

    async function abrirConversion(scope) {
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
        renderFrom(from, esTodo);

        $('#conv-targets').innerHTML = '<p class="field-hint">Cargando…</p>';
        $('#conv-measures').hidden = true;
        $('#conv-preview').hidden = true;
        $('#conv-geometry').hidden = true;
        $('#convert-apply').disabled = true;

        $('#convert-modal').hidden = false;
        document.body.classList.add('modal-open');
        Nav.pushLayer('convert-modal', () => ocultarConversion(session));

        try {
            const { options } = await API.unitPlan(from);
            if (session !== convertSession) return;   // se cerró/reabrió mientras esperaba la red
            convertOptions = options || [];
        } catch {
            if (session !== convertSession) return;
            convertOptions = [];
        }
        renderTargets();
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

    function renderFrom(from, esTodo) {
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

    function renderTargets() {
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
                renderTargets();
                renderMeasures();
            });
            box.appendChild(btn);
        }
    }

    function renderMeasures() {
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
            refreshPreview();
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
                refreshPreview();
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
        refreshPreview();
    }

    function esConteo(unit) {
        const u = catalogo.find(x => x.label === unit);
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

    function refreshPreview() {
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

    function ocultarConversion(session) {
        // Llegó tarde: ya hay una apertura más nueva dueña del estado. Tocarlo
        // ahora sería el bug que esto arregla (ver el comentario en convertSession).
        if (session !== convertSession) return;
        $('#convert-modal').hidden = true;
        document.body.classList.remove('modal-open');
        convertScope = null;
        convertTarget = null;
        previewOps = [];
    }
    function cerrarConversion() { Nav.popLayer(); }

    $('#convert-apply').addEventListener('click', () => {
        if (!previewOps.length) return;
        const ops = previewOps;
        const esTodo = convertScope?.all === true;
        cerrarConversion();

        for (const op of ops) {
            const idx = op.num - 1;
            if (items[idx]) Object.assign(items[idx], op.fields);
        }
        Estado.render();
        Estado.scheduleSave();
        toast(esTodo
            ? `${ops.length} item${ops.length === 1 ? '' : 's'} convertido${ops.length === 1 ? '' : 's'}`
            : 'Unidad convertida a ' + ops[0].fields.unit);
    });

    ['#conv-pieces', '#conv-largo', '#conv-ancho', '#conv-alto'].forEach(sel => {
        $(sel).addEventListener('input', refreshPreview);
    });
    $('#conv-geometry').addEventListener('toggle', refreshPreview);
    $('#convert-modal-close').addEventListener('click', cerrarConversion);
    $('#convert-modal').addEventListener('click', (e) => { if (e.target.id === 'convert-modal') cerrarConversion(); });
    $('#btn-convert-all').addEventListener('click', () => abrirConversion({ all: true }));

    return { cargarCatalogo, abrirPicker, abrirConversion };
})();
