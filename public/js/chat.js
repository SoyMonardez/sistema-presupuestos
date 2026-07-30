// El asistente del presupuesto (pestaña 2).
//
// Se inicializa desde app.js con los enganches que necesita, en vez de hablarle
// directo al estado del editor: así este archivo no sabe nada de cómo se guardan
// los items, y app.js sigue siendo el único que los toca.
//
// La confirmación de un cambio es conversacional, como pide el plan: él puede
// tocar "Aplicar" en la tarjeta o escribir "sí, dale". Las dos hacen lo mismo.
// Poner encima un segundo panel de confirmación arriba de un "sí" que ya dijo
// sería redundante y molesto.

const Chat = (() => {
    let cfg = null;         // { getBudgetId, getItems, applyOps, toast }
    let chatId = null;
    let enviando = false;
    let itemFoco = null;    // item señalado desde el atajo de la tarjeta

    const $ = (sel) => document.querySelector(sel);

    // "sí", "dale", "aplicalo"… El usuario responde en castellano, no toca botones.
    const CONFIRMA = /^\s*(s[ií]+|dale|ok(ey)?|listo|aplica(lo|r)?|hacelo|obvio|correcto|perfecto|va|vale|confirmo|adelante)\b/i;
    const RECHAZA  = /^\s*(no|nel|nop|dej[aá](lo)?|olvidalo|cancel(a|ar|alo)?|mejor no)\b/i;

    let opsPendientes = null;   // lo último que propuso, esperando un sí o un no

    function init(config) {
        cfg = config;

        $('#chat-form').addEventListener('submit', (e) => {
            e.preventDefault();
            enviar($('#chat-input').value);
        });

        // Enter manda, Shift+Enter hace salto de línea. En el celular el teclado
        // trae su propia tecla de enviar, así que solo aplica en la compu.
        $('#chat-input').addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey && window.matchMedia('(min-width: 600px)').matches) {
                e.preventDefault();
                enviar($('#chat-input').value);
            }
        });

        $('#chat-input').addEventListener('input', autoGrow);

        document.querySelectorAll('.chat-chip').forEach(chip => {
            chip.addEventListener('click', () => enviar(chip.textContent));
        });
    }

    function autoGrow() {
        const el = $('#chat-input');
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }

    /** Se llama al abrir un presupuesto: limpia y engancha la conversación. */
    async function open() {
        chatId = null;
        opsPendientes = null;
        itemFoco = null;
        $('#chat-messages').innerHTML = '';
        $('#chat-empty').hidden = false;
        $('#chat-input').value = '';
        autoGrow();

        const budgetId = cfg.getBudgetId();
        if (!budgetId) return;
        try {
            // Se retoma la última conversación de este presupuesto, si hay.
            const { chats } = await API.listChats(budgetId);
            if (chats.length) {
                chatId = chats[0].id;
                const { messages } = await API.chatMessages(chatId);
                if (messages.length) {
                    $('#chat-empty').hidden = true;
                    messages.forEach(m => pintar(m.role, m.content, m.data, { scroll: false }));
                    scrollAbajo();
                }
            }
        } catch {
            // Sin historial se arranca de cero; no vale la pena molestarlo con esto.
        }
    }

    /** Atajo desde una tarjeta de item: abre el chat hablando de ese item. */
    function focusItem(num, nombre) {
        itemFoco = num;
        const el = $('#chat-input');
        el.placeholder = `Sobre el item ${num} (${String(nombre || '').slice(0, 30)})…`;
        el.focus();
    }

    async function enviar(texto) {
        texto = String(texto || '').trim();
        if (!texto || enviando) return;

        // Si hay algo esperando confirmación, un "sí" suelto lo aplica: la frase
        // ES la confirmación, no hace falta que además toque el botón.
        if (opsPendientes) {
            if (CONFIRMA.test(texto)) {
                aplicar(opsPendientes);
                $('#chat-input').value = '';
                autoGrow();
                pintar('user', texto);
                pintar('assistant', 'Listo, lo apliqué.');
                return;
            }
            if (RECHAZA.test(texto)) {
                opsPendientes = null;
                marcarTarjetasResueltas('Descartado');
                $('#chat-input').value = '';
                autoGrow();
                pintar('user', texto);
                pintar('assistant', 'Dale, lo dejo como estaba.');
                return;
            }
        }

        $('#chat-input').value = '';
        autoGrow();
        $('#chat-empty').hidden = true;
        pintar('user', texto);

        enviando = true;
        $('#chat-send').disabled = true;
        const pensando = pintarPensando();

        try {
            if (!chatId) {
                const chat = await API.createChat(cfg.getBudgetId());
                chatId = chat.id;
            }
            const { message } = await API.sendChatMessage(chatId, texto, itemFoco);
            itemFoco = null;
            $('#chat-input').placeholder = 'Escribile al asistente…';
            pensando.remove();
            pintar('assistant', message.content, message.data);
        } catch (err) {
            pensando.remove();
            pintar('assistant', err.message || 'No pude responder, probá de nuevo.');
        } finally {
            enviando = false;
            $('#chat-send').disabled = false;
        }
    }

    function pintarPensando() {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-assistant';
        el.innerHTML = `<div class="chat-bubble chat-thinking"><span></span><span></span><span></span></div>`;
        $('#chat-messages').appendChild(el);
        scrollAbajo();
        return el;
    }

    function pintar(role, texto, data, { scroll = true } = {}) {
        $('#chat-empty').hidden = true;
        const wrap = document.createElement('div');
        wrap.className = `chat-msg chat-msg-${role === 'user' ? 'user' : 'assistant'}`;

        const burbuja = document.createElement('div');
        burbuja.className = 'chat-bubble';
        burbuja.textContent = texto;
        wrap.appendChild(burbuja);

        if (data?.simulation) wrap.appendChild(tarjetaSimulacion(data.simulation, data.ops));
        else if (data?.ops?.length) wrap.appendChild(tarjetaCambios(data.ops));

        if (data?.warnings?.length) {
            const av = document.createElement('div');
            av.className = 'chat-warns';
            data.warnings.slice(0, 4).forEach(w => {
                const p = document.createElement('p');
                p.textContent = w;
                av.appendChild(p);
            });
            wrap.appendChild(av);
        }
        if (data?.sources?.length) wrap.appendChild(fuentes(data.sources));

        $('#chat-messages').appendChild(wrap);
        if (data?.ops?.length) opsPendientes = data.ops;
        if (scroll) scrollAbajo();
        return wrap;
    }

    // La tarjeta de simulación: números reales, y nada aplicado todavía.
    function tarjetaSimulacion(sim, ops) {
        const card = document.createElement('div');
        card.className = 'chat-card';

        if (!sim.ok) {
            card.classList.add('chat-card-error');
            card.textContent = sim.reason;
            return card;
        }

        const sube = sim.delta > 0;
        card.innerHTML = `
            <div class="chat-card-head"></div>
            <div class="chat-card-totals">
                <div><span class="ct-label">Ahora</span><span class="ct-value"></span></div>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="18" height="18"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg>
                <div><span class="ct-label">Quedaría</span><span class="ct-value ct-after"></span></div>
            </div>
            <div class="chat-card-delta"></div>
            <div class="chat-card-lines"></div>`;

        card.querySelector('.chat-card-head').textContent = sim.label;
        card.querySelectorAll('.ct-value')[0].textContent = formatARS(sim.before);
        card.querySelector('.ct-after').textContent = formatARS(sim.after);
        card.querySelector('.chat-card-delta').textContent =
            `${sube ? '+' : ''}${formatARS(sim.delta)} ${sube ? 'más' : 'menos'}`;
        card.querySelector('.chat-card-delta').classList.add(sube ? 'delta-up' : 'delta-down');

        const lineas = card.querySelector('.chat-card-lines');
        (sim.lines || []).forEach(l => {
            const row = document.createElement('div');
            row.className = 'chat-card-line';
            row.innerHTML = `<span class="ccl-name"></span><span class="ccl-detail"></span>`;
            row.querySelector('.ccl-name').textContent = `${l.num}. ${l.name}`;
            row.querySelector('.ccl-detail').textContent = l.detalle;
            lineas.appendChild(row);
        });
        if (sim.truncated) {
            const mas = document.createElement('div');
            mas.className = 'chat-card-more';
            mas.textContent = `y ${sim.truncated} item(s) más`;
            lineas.appendChild(mas);
        }

        if (ops?.length) card.appendChild(acciones(ops));
        return card;
    }

    function tarjetaCambios(ops) {
        const card = document.createElement('div');
        card.className = 'chat-card';
        card.innerHTML = `<div class="chat-card-head">Cambios propuestos</div><div class="chat-card-lines"></div>`;
        const lineas = card.querySelector('.chat-card-lines');
        const items = cfg.getItems();

        ops.slice(0, 8).forEach(op => {
            const row = document.createElement('div');
            row.className = 'chat-card-line';
            row.innerHTML = `<span class="ccl-name"></span><span class="ccl-detail"></span>`;
            const cur = items[op.num - 1];
            if (op.action === 'add') {
                row.querySelector('.ccl-name').textContent = `+ ${op.item.name}`;
                row.querySelector('.ccl-detail').textContent =
                    `${op.item.quantity} ${op.item.unit} × ${formatARS(op.item.unit_price)}`;
            } else if (op.action === 'remove') {
                row.querySelector('.ccl-name').textContent = `✕ ${cur?.name || 'Item ' + op.num}`;
                row.querySelector('.ccl-detail').textContent = 'se saca';
            } else {
                const f = op.fields || {};
                row.querySelector('.ccl-name').textContent = `${op.num}. ${cur?.name || ''}`;
                const partes = [];
                if (f.quantity !== undefined || f.unit !== undefined) {
                    partes.push(`${cur?.quantity} ${cur?.unit} → ${f.quantity ?? cur?.quantity} ${f.unit ?? cur?.unit}`);
                }
                if (f.unit_price !== undefined) partes.push(`${formatARS(cur?.unit_price)} → ${formatARS(f.unit_price)}`);
                row.querySelector('.ccl-detail').textContent = partes.join(' · ');
            }
            lineas.appendChild(row);
        });
        if (ops.length > 8) {
            const mas = document.createElement('div');
            mas.className = 'chat-card-more';
            mas.textContent = `y ${ops.length - 8} cambio(s) más`;
            lineas.appendChild(mas);
        }
        card.appendChild(acciones(ops));
        return card;
    }

    function acciones(ops) {
        const box = document.createElement('div');
        box.className = 'chat-card-actions';
        box.innerHTML = `
            <button type="button" class="btn btn-ghost cca-no">Dejalo así</button>
            <button type="button" class="btn btn-primary cca-si">Aplicar</button>`;
        box.querySelector('.cca-si').addEventListener('click', () => aplicar(ops));
        box.querySelector('.cca-no').addEventListener('click', () => {
            opsPendientes = null;
            marcarTarjetasResueltas('Descartado');
        });
        return box;
    }

    function aplicar(ops) {
        cfg.applyOps(ops);
        opsPendientes = null;
        marcarTarjetasResueltas('Aplicado');
    }

    /** Una propuesta ya resuelta no puede volver a aplicarse desde el historial. */
    function marcarTarjetasResueltas(etiqueta) {
        document.querySelectorAll('#chat-messages .chat-card-actions').forEach(box => {
            const sello = document.createElement('span');
            sello.className = 'chat-card-done';
            sello.textContent = etiqueta;
            box.replaceWith(sello);
        });
    }

    function fuentes(lista) {
        const box = document.createElement('div');
        box.className = 'chat-sources';
        box.innerHTML = '<span class="chat-sources-label">Fuentes</span>';
        lista.forEach(s => {
            const a = document.createElement('a');
            a.href = s.url;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = s.title || s.url;
            box.appendChild(a);
        });
        return box;
    }

    function scrollAbajo() {
        const el = $('#chat-scroll');
        requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    }

    return { init, open, focusItem };
})();
