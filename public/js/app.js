// Estado y navegación de la SPA.
(() => {
    const $ = (sel) => document.querySelector(sel);

    const views = {
        login:  $('#view-login'),
        list:   $('#view-list'),
        editor: $('#view-editor'),
    };

    let currentBudget = null;   // { id, name, client, notes }
    let items = [];             // [{ name, quantity, unit, unit_price }]
    let draftItems = [];        // items propuestos por la IA, pendientes de confirmar
    let saveTimer = null;
    let suggestTimer = null;
    let suggestTarget = null;   // input de nombre activo para sugerencias

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
        show('login');
    });

    window.addEventListener('auth-expired', () => {
        toast('Tu sesión venció, entrá de nuevo', true);
        show('login');
    });

    // ================= Lista =================
    async function openList() {
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
        currentBudget = { id: data.id, name: data.name, client: data.client, notes: data.notes };
        items = data.items.map(i => ({ name: i.name, quantity: i.quantity, unit: i.unit, unit_price: i.unit_price }));
        $('#budget-name').value = data.name;
        $('#budget-client').value = data.client;
        hideDraft();
        hideAIPanel();
        renderItems();
        show('editor');
    }

    $('#btn-back').addEventListener('click', async () => {
        await flushSave();
        await openList();
    });

    $('#btn-delete').addEventListener('click', async () => {
        if (!confirm('¿Borrar este presupuesto? No se puede deshacer.')) return;
        await API.deleteBudget(currentBudget.id);
        currentBudget = null;
        await openList();
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

    // ================= Items =================
    function renderItems() {
        const listEl = $('#items-list');
        listEl.innerHTML = '';
        items.forEach((item, index) => {
            const row = document.createElement('div');
            row.className = 'item-row';
            row.innerHTML = `
                <input type="text" class="f-name" placeholder="Descripción" autocomplete="off">
                <input type="number" class="f-qty" inputmode="decimal" min="0" step="any">
                <input type="text" class="f-unit" autocomplete="off">
                <input type="number" class="f-price" inputmode="numeric" min="0" step="any">
                <button class="item-remove" title="Quitar">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </button>
                <div class="item-subtotal"></div>`;

            const nameEl  = row.querySelector('.f-name');
            const qtyEl   = row.querySelector('.f-qty');
            const unitEl  = row.querySelector('.f-unit');
            const priceEl = row.querySelector('.f-price');
            const subEl   = row.querySelector('.item-subtotal');

            nameEl.value  = item.name;
            qtyEl.value   = item.quantity || '';
            unitEl.value  = item.unit;
            priceEl.value = item.unit_price || '';
            subEl.textContent = 'Subtotal: ' + formatARS(item.quantity * item.unit_price);

            nameEl.addEventListener('input', () => {
                item.name = nameEl.value;
                scheduleSave();
                scheduleSuggest(nameEl, item);
            });
            nameEl.addEventListener('blur', () => setTimeout(hideSuggest, 250));
            qtyEl.addEventListener('input', () => {
                item.quantity = Number(qtyEl.value) || 0;
                subEl.textContent = 'Subtotal: ' + formatARS(item.quantity * item.unit_price);
                updateTotal();
                scheduleSave();
            });
            unitEl.addEventListener('input', () => { item.unit = unitEl.value; scheduleSave(); });
            priceEl.addEventListener('input', () => {
                item.unit_price = Number(priceEl.value) || 0;
                subEl.textContent = 'Subtotal: ' + formatARS(item.quantity * item.unit_price);
                updateTotal();
                scheduleSave();
            });
            row.querySelector('.item-remove').addEventListener('click', () => {
                items.splice(index, 1);
                renderItems();
                scheduleSave();
            });

            listEl.appendChild(row);
        });
        updateTotal();
    }

    function updateTotal() {
        const total = items.reduce((sum, i) => sum + (i.quantity * i.unit_price || 0), 0);
        $('#total-amount').textContent = formatARS(total);
    }

    $('#btn-add-item').addEventListener('click', () => {
        items.push({ name: '', quantity: 1, unit: 'un.', unit_price: 0 });
        renderItems();
        const inputs = document.querySelectorAll('#items-list .f-name');
        inputs[inputs.length - 1]?.focus();
    });

    // ================= Sugerencias IA =================
    function scheduleSuggest(inputEl, item) {
        clearTimeout(suggestTimer);
        hideSuggest();
        const query = inputEl.value.trim();
        if (query.length < 3) return;
        suggestTimer = setTimeout(async () => {
            try {
                const { suggestions } = await API.aiSuggest(query, items);
                if (!suggestions.length || document.activeElement !== inputEl) return;
                showSuggest(suggestions, inputEl, item);
            } catch { /* sugerencias son best-effort */ }
        }, 600);
    }

    function showSuggest(suggestions, inputEl, item) {
        const box = $('#suggest-box');
        box.innerHTML = '';
        suggestTarget = inputEl;
        for (const s of suggestions) {
            const chip = document.createElement('button');
            chip.className = 'suggest-chip';
            chip.innerHTML = `<span></span><span class="suggest-chip-price"></span>`;
            chip.firstChild.textContent = `${s.name} (${s.unit})`;
            chip.lastChild.textContent = s.unit_price ? '~' + formatARS(s.unit_price) : '';
            chip.addEventListener('mousedown', (e) => {
                e.preventDefault(); // que no dispare el blur antes del click
                item.name = s.name;
                item.unit = s.unit;
                if (!item.unit_price && s.unit_price) item.unit_price = s.unit_price;
                renderItems();
                scheduleSave();
                hideSuggest();
            });
            box.appendChild(chip);
        }
        box.hidden = false;
    }

    function hideSuggest() {
        $('#suggest-box').hidden = true;
        suggestTarget = null;
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
            const { items: parsed } = await API.aiParse(text);
            if (!parsed.length) {
                toast('La IA no encontró items en el texto', true);
            } else {
                $('#ai-text').value = '';
                hideAIPanel();
                showDraft(parsed);
            }
        } catch (err) {
            toast(err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Convertir en items';
        }
    });

    // ================= Borrador de items IA =================
    function showDraft(parsed) {
        draftItems = parsed;
        const listEl = $('#draft-list');
        listEl.innerHTML = '';
        for (const d of parsed) {
            const row = document.createElement('div');
            row.className = 'draft-item';
            row.innerHTML = `<span></span><span class="draft-item-detail"></span>`;
            row.firstChild.textContent = d.name;
            row.lastChild.textContent = `${d.quantity} ${d.unit} × ${formatARS(d.unit_price)}`;
            listEl.appendChild(row);
        }
        $('#draft-panel').hidden = false;
    }

    function hideDraft() {
        $('#draft-panel').hidden = true;
        draftItems = [];
    }

    $('#btn-draft-cancel').addEventListener('click', hideDraft);
    $('#btn-draft-add').addEventListener('click', () => {
        items.push(...draftItems);
        hideDraft();
        renderItems();
        scheduleSave();
        toast('Items agregados');
    });

    // ================= Voz =================
    const voiceBtn = $('#btn-voice');
    const voiceLabel = $('#voice-label');

    voiceBtn.addEventListener('click', () => {
        if (!Voice.isSupported()) {
            toast('Tu navegador no soporta dictado por voz. Usá Chrome.', true);
            return;
        }
        if (Voice.isActive()) {
            Voice.stop();
            return;
        }
        hideAIPanel();
        hideDraft();
        voiceBtn.classList.add('recording');
        voiceLabel.textContent = 'Escuchando… (tocá para parar)';

        Voice.start({
            onPartial(text) {
                voiceLabel.textContent = text.length > 36 ? '…' + text.slice(-34) : (text || 'Escuchando…');
            },
            async onEnd(finalText) {
                voiceBtn.classList.remove('recording');
                voiceLabel.textContent = 'Dictar items';
                if (!finalText) {
                    toast('No se escuchó nada', true);
                    return;
                }
                voiceLabel.textContent = 'Procesando…';
                try {
                    const { items: parsed } = await API.aiParse(finalText);
                    if (!parsed.length) toast('La IA no encontró items en lo dictado', true);
                    else showDraft(parsed);
                } catch (err) {
                    toast(err.message, true);
                } finally {
                    voiceLabel.textContent = 'Dictar items';
                }
            },
            onError(msg) {
                voiceBtn.classList.remove('recording');
                voiceLabel.textContent = 'Dictar items';
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
        if (!API.getToken()) return show('login');
        try {
            await openList();
        } catch {
            show('login');
        }
    })();
})();
