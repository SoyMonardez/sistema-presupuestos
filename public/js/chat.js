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
    let modo = 'presupuestador';   // 'asistente' | 'investigador' | 'presupuestador'

    const $ = (sel) => document.querySelector(sel);

    // Cada modo tiene su propia forma de responder (ver server/routes/chat.js:
    // solo "presupuestador" toca el presupuesto de verdad). Esto es lo que
    // cambia en pantalla al elegir uno: el placeholder y la pantalla vacía.
    const MODOS = {
        asistente: {
            nombre: 'Asistente',
            pensando: 'Pensando…',
            placeholder: 'Contale qué estás pensando…',
            titulo: 'Preguntale o pensá en voz alta',
            sub: 'Para validar una idea, discutir un número o tener con qué responderle a quien te pregunte.',
            chips: [
                '¿Cuánto puedo cobrar por esto?',
                '¿Me conviene hacerlo por mi cuenta o subcontratarlo?',
                '¿Este número me deja ganancia?',
            ],
        },
        investigador: {
            nombre: 'Investigador',
            pensando: 'Analizando el pedido…',
            placeholder: 'Qué querés que investigue…',
            titulo: 'Pedile que investigue',
            sub: 'Precios de mercado, rendimientos, normativa municipal — busca en internet y cita la fuente.',
            chips: [
                '¿A cuánto está la bolsa de cemento hoy?',
                '¿Cuánto rinde una bolsa de cal en revoque?',
                '¿Esta obra necesita permiso municipal?',
            ],
        },
        presupuestador: {
            nombre: 'Presupuestador',
            pensando: 'Armando los números…',
            placeholder: 'Escribile al asistente…',
            titulo: 'Preguntale lo que quieras',
            sub: 'Conoce los items de este presupuesto, tu tarifario y lo que cobraste antes por trabajos parecidos.',
            chips: [
                '¿Cuánto me da si le bajo un 10%?',
                'Pasá todo a metros cúbicos',
                '¿Cuánto cobré antes por revoque?',
            ],
        },
    };

    // "sí", "dale", "aplicalo"… El usuario responde en castellano, no toca botones.
    //
    // Tienen que cubrir el mensaje ENTERO. Con un \b al final, "si, pero bajale el
    // precio" contaba como confirmación y aplicaba los cambios en vez de escuchar
    // el pedido nuevo, que es lo contrario de lo que pidió.
    const CONFIRMA = /^\s*(s[ií]+|dale|ok(ey)?|listo|aplica(lo|r)?|hacelo|obvio|correcto|perfecto|va|vale|confirmo|adelante|de una)[\s.,!]*$/i;
    const RECHAZA  = /^\s*(no|nel|nop|dej[aá](lo)?|olvidalo|cancel(a|ar|alo)?|mejor no)[\s.,!]*$/i;

    // Lo último que propuso, esperando un sí o un no. Vale SOLO para el último
    // mensaje del asistente: si contestó de nuevo sin proponer nada, la propuesta
    // vieja ya no está en pantalla y un "sí" no puede resucitarla.
    let opsPendientes = null;

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

        $('#chat-attach').addEventListener('click', () => $('#chat-file').click());
        $('#chat-file').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            e.target.value = '';           // permite volver a elegir la misma foto
            if (file) await adjuntar(file);
        });
        $('#chat-attach-remove').addEventListener('click', quitarAdjunto);

        conectarPegar();
        conectarArrastre();

        $('#chat-new').addEventListener('click', nuevaConversacion);
        $('#chat-history').addEventListener('click', abrirListaChats);
        $('#chats-modal-close').addEventListener('click', () => Nav.popLayer());
        $('#chats-modal').addEventListener('click', (e) => { if (e.target.id === 'chats-modal') Nav.popLayer(); });

        $('#chat-mic').addEventListener('click', dictar);
        $('#chat-speak').addEventListener('click', alternarVoz);
        // El botón se prende y apaga solo mientras habla, para que sirva también
        // como "callate" sin tener que apagar la función entera.
        Hablar.alHablar((hablando) => {
            $('#chat-speak').classList.toggle('leyendo', hablando);
        });
        aplicarVozUI();

        $('#chat-mode-trigger').addEventListener('click', () => {
            menuModoAbierto() ? cerrarMenuModo() : abrirMenuModo();
        });
        document.querySelectorAll('.chat-mode-item').forEach(btn => {
            btn.addEventListener('click', () => {
                cerrarMenuModo();
                cambiarModo(btn.dataset.mode);
            });
        });
        // Tocar afuera cierra, como cualquier menú. En captura para enterarse
        // antes de que el clic haga otra cosa.
        document.addEventListener('click', (e) => {
            if (!menuModoAbierto()) return;
            if (e.target.closest('.chat-mode')) return;
            cerrarMenuModo();
        }, true);
    }

    // ================= Hablarle al asistente =================
    // La transcripción la hace Whisper en el servidor, igual que el dictado de
    // la pestaña de presupuesto: la Web Speech API del navegador entiende mucho
    // peor el rioplatense y las palabras de obra ("contrapiso", "H21").
    //
    // Lo que entendió va al cuadro de texto y NO se manda solo, a propósito: si
    // escuchó mal una medida o un precio, se ve antes de mandarlo. Un número mal
    // entendido acá termina en un presupuesto.
    function dictar() {
        const btn = $('#chat-mic');

        if (Voice.isActive()) { Voice.stop(); return; }

        if (!Voice.isSupported()) {
            cfg.toast('Tu navegador no soporta grabar audio. Actualizalo.', true);
            return;
        }

        // Que no se pisen: si está leyendo una respuesta, primero se calla.
        Hablar.callar();

        Voice.start({
            onTick(secs) {
                btn.classList.add('grabando');
                btn.title = `Grabando ${secs}s — tocá para parar`;
            },
            async onStop(blob) {
                btn.classList.remove('grabando');
                btn.title = 'Hablar en vez de escribir';
                if (blob.size < 1500) {
                    cfg.toast('No llegué a escuchar nada, probá de nuevo', true);
                    return;
                }
                btn.classList.add('transcribiendo');
                btn.disabled = true;
                try {
                    const { text } = await API.aiTranscribe(blob);
                    const limpio = String(text || '').trim();
                    if (!limpio) {
                        cfg.toast('No se entendió lo que dijiste, probá de nuevo', true);
                        return;
                    }
                    const el = $('#chat-input');
                    // Se agrega a lo que ya haya escrito, no lo pisa.
                    el.value = el.value.trim() ? `${el.value.trim()} ${limpio}` : limpio;
                    el.focus();
                    autoGrow();
                } catch (err) {
                    cfg.toast(err.message, true);
                } finally {
                    btn.classList.remove('transcribiendo');
                    btn.disabled = false;
                }
            },
            onError(msg) {
                btn.classList.remove('grabando');
                btn.title = 'Hablar en vez de escribir';
                cfg.toast(msg, true);
            },
        });
    }

    // ================= Que el asistente hable =================
    const VOZ_KEY = 'presu_voz';
    let vozPrendida = localStorage.getItem(VOZ_KEY) === '1';

    function aplicarVozUI() {
        const btn = $('#chat-speak');
        btn.setAttribute('aria-pressed', vozPrendida ? 'true' : 'false');
        $('#chat-speak-label').textContent = vozPrendida ? 'Voz' : 'Voz';
        btn.title = vozPrendida
            ? `Leyendo con ${Hablar.vozActual()}. Tocá para apagar (o para cortar lo que esté leyendo).`
            : 'Leer las respuestas en voz alta';
    }

    function alternarVoz() {
        // Si está leyendo, el primer toque corta la lectura sin apagar la función:
        // es lo que uno espera cuando ya escuchó lo que necesitaba.
        if (vozPrendida && Hablar.estaHablando()) { Hablar.callar(); return; }

        vozPrendida = !vozPrendida;
        localStorage.setItem(VOZ_KEY, vozPrendida ? '1' : '0');
        if (vozPrendida) {
            // iOS exige que la primera locución salga de un toque del usuario.
            Hablar.destrabar();
            cfg.toast('Voy a leer las respuestas en voz alta');
        } else {
            Hablar.callar();
        }
        aplicarVozUI();
    }

    /** Lee una respuesta, si la voz está prendida. */
    function leerSiCorresponde(texto) {
        if (vozPrendida && texto) Hablar.decir(texto);
    }

    // ================= Menú de modo =================
    // Pasa por Nav igual que las modales: así Escape y el gesto de volver del
    // celular lo cierran por el mismo camino que todo lo demás. Sin esto, Escape
    // cerraría la capa de abajo dejando el menú abierto encima.
    const menuModoAbierto = () => !$('#chat-mode-menu').hidden;

    function abrirMenuModo() {
        $('#chat-mode-menu').hidden = false;
        $('#chat-mode-trigger').setAttribute('aria-expanded', 'true');
        Nav.pushLayer('chat-mode-menu', ocultarMenuModo);
    }
    function ocultarMenuModo() {
        $('#chat-mode-menu').hidden = true;
        $('#chat-mode-trigger').setAttribute('aria-expanded', 'false');
    }
    function cerrarMenuModo() {
        if (menuModoAbierto()) Nav.popLayer();
    }

    /** Cambia el modo activo: la pantalla al toque, el servidor si hay conversación creada. */
    async function cambiarModo(nuevo) {
        if (!MODOS[nuevo] || nuevo === modo) return;
        modo = nuevo;
        actualizarModoUI();
        if (chatId) {
            try {
                await API.setChatMode(chatId, modo);
            } catch (err) {
                cfg.toast(err.message, true);
            }
        }
    }

    function actualizarModoUI() {
        document.querySelectorAll('.chat-mode-item').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.mode === modo);
        });
        const info = MODOS[modo];
        $('#chat-mode-label').textContent = info.nombre;
        $('#chat-input').placeholder = info.placeholder;
        // La pantalla vacía cambia de foco según el modo: no tiene sentido
        // ofrecer "pasá todo a m³" en Investigador ni "¿a cuánto está el
        // cemento?" en Presupuestador si lo que se busca es cargarlo, no leerlo.
        if (!$('#chat-empty').hidden) pintarVacio();
    }

    function pintarVacio() {
        const info = MODOS[modo];
        $('#chat-empty-title').textContent = info.titulo;
        $('#chat-empty-sub').textContent = info.sub;
        const chips = $('#chat-empty-chips');
        chips.innerHTML = '';
        info.chips.forEach(texto => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'chat-chip';
            btn.textContent = texto;
            btn.addEventListener('click', () => enviar(texto));
            chips.appendChild(btn);
        });
    }

    function limpiarPantalla(titulo = 'Asistente') {
        chatId = null;
        opsPendientes = null;
        itemFoco = null;
        modo = 'presupuestador';
        // Cambiar de conversación o salir del presupuesto tiene que callar la
        // voz: si no, sigue leyendo un mensaje que ya no está en pantalla.
        Hablar.callar();
        if (Voice.isActive()) Voice.stop();
        quitarAdjunto();
        $('#chat-messages').innerHTML = '';
        $('#chat-empty').hidden = false;
        $('#chat-title').textContent = titulo;
        $('#chat-input').value = '';
        actualizarModoUI();
        pintarVacio();
        autoGrow();
    }

    function nuevaConversacion() {
        limpiarPantalla();
        $('#chat-input').focus();
    }

    async function abrirListaChats() {
        const budgetId = cfg.getBudgetId();
        if (!budgetId) return;

        const lista = $('#chats-list');
        lista.innerHTML = '<p class="field-hint">Cargando…</p>';
        $('#chats-modal').hidden = false;
        document.body.classList.add('modal-open');
        Nav.pushLayer('chats-modal', () => {
            $('#chats-modal').hidden = true;
            document.body.classList.remove('modal-open');
        });

        try {
            const { chats } = await API.listChats(budgetId);
            lista.innerHTML = '';
            if (!chats.length) {
                lista.innerHTML = '<p class="field-hint">Todavía no hablaste con el asistente sobre este presupuesto.</p>';
                return;
            }
            for (const c of chats) {
                const fila = document.createElement('div');
                fila.className = 'chat-row' + (c.id === chatId ? ' active' : '');
                fila.innerHTML = `
                    <button type="button" class="chat-row-open">
                        <span class="chat-row-title"></span>
                        <span class="chat-row-date"></span>
                    </button>
                    <button type="button" class="chat-row-del" aria-label="Borrar conversación">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="17" height="17"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                    </button>`;
                fila.querySelector('.chat-row-title').textContent = c.title || 'Sin título';
                fila.querySelector('.chat-row-date').textContent = formatDate(c.updated_at);
                fila.querySelector('.chat-row-open').addEventListener('click', () => {
                    Nav.popLayer();
                    cargarConversacion(c.id, c.title, c.mode);
                });
                fila.querySelector('.chat-row-del').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        await API.deleteChat(c.id);
                        if (c.id === chatId) limpiarPantalla();
                        fila.remove();
                        if (!lista.querySelector('.chat-row')) {
                            lista.innerHTML = '<p class="field-hint">No quedan conversaciones.</p>';
                        }
                    } catch (err) { cfg.toast(err.message, true); }
                });
                lista.appendChild(fila);
            }
        } catch (err) {
            lista.innerHTML = '';
            const p = document.createElement('p');
            p.className = 'field-hint';
            p.textContent = err.message;
            lista.appendChild(p);
        }
    }

    async function cargarConversacion(id, titulo, modoConv) {
        limpiarPantalla(titulo || 'Asistente');
        chatId = id;
        if (MODOS[modoConv]) { modo = modoConv; actualizarModoUI(); }
        try {
            const { messages } = await API.chatMessages(id);
            if (messages.length) {
                $('#chat-empty').hidden = true;
                messages.forEach(m => pintar(m.role, m.content, m.data, { scroll: false }));
                // Lo que ya se aplicó o descartó no puede volver a aplicarse desde
                // el historial; al recargar no sabemos qué pasó, así que se sella todo.
                marcarTarjetasResueltas('Ya resuelto');
                opsPendientes = null;
                scrollAbajo();
            }
        } catch (err) {
            cfg.toast(err.message, true);
        }
    }

    function autoGrow() {
        const el = $('#chat-input');
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 140) + 'px';
    }

    // ================= Adjuntar una foto =================
    // La foto se achica ACÁ, antes de subirla. El servidor igual la vuelve a
    // achicar, pero eso no ayuda con lo que importa en la obra: subir 4 MB con
    // media barra de señal. Achicada son unos 150 kb y sube al toque.
    const FOTO_ANCHO_MAX = 1400;
    const FOTO_MAX_BYTES = 8 * 1024 * 1024;

    let adjunto = null;   // { data (base64 sin encabezado), mediaType, nombre }

    function achicarFoto(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const img = new Image();
            img.onload = () => {
                URL.revokeObjectURL(url);
                const escala = Math.min(1, FOTO_ANCHO_MAX / img.width);
                const w = Math.round(img.width * escala);
                const h = Math.round(img.height * escala);
                const canvas = document.createElement('canvas');
                canvas.width = w;
                canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                const dataUrl = canvas.toDataURL('image/jpeg', 0.82);
                resolve({ data: dataUrl.split(',')[1], mediaType: 'image/jpeg' });
            };
            img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('formato no soportado')); };
            img.src = url;
        });
    }

    function leerCrudo(file) {
        return new Promise((resolve, reject) => {
            const fr = new FileReader();
            fr.onload = () => resolve({
                data: String(fr.result).split(',')[1],
                mediaType: file.type || 'image/jpeg',
            });
            fr.onerror = () => reject(new Error('No se pudo leer el archivo'));
            fr.readAsDataURL(file);
        });
    }

    async function adjuntar(file) {
        if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|heic|heif)$/i.test(file.name)) {
            cfg.toast('Por ahora solo puedo leer fotos', true);
            return;
        }
        if (file.size > FOTO_MAX_BYTES) {
            cfg.toast('Esa foto es muy pesada. Sacale una con menos resolución.', true);
            return;
        }
        try {
            let datos;
            try {
                datos = await achicarFoto(file);
            } catch {
                // El navegador no supo dibujarla (pasa con HEIC fuera de iPhone):
                // se manda tal cual y la achica el servidor.
                datos = await leerCrudo(file);
            }
            // Una captura pegada del portapapeles llega sin nombre o como
            // "image.png", que no le dice nada a nadie.
            const nombre = (!file.name || /^image\.\w+$/i.test(file.name))
                ? 'Captura pegada'
                : file.name;

            adjunto = { ...datos, nombre };
            $('#chat-attach-img').src = `data:${adjunto.mediaType};base64,${adjunto.data}`;
            $('#chat-attach-name').textContent = nombre;
            $('#chat-attach-preview').hidden = false;
            $('#chat-input').focus();
        } catch (err) {
            cfg.toast(err.message || 'No pude leer esa foto', true);
        }
    }

    function quitarAdjunto() {
        adjunto = null;
        $('#chat-attach-preview').hidden = true;
        $('#chat-attach-img').removeAttribute('src');
    }

    /** ¿La pestaña del asistente es la que se está viendo? */
    function chatVisible() {
        const btns = [...document.querySelectorAll('.tab-btn')];
        return btns[1]?.classList.contains('active')
            && !document.querySelector('#view-editor')?.hidden;
    }

    /** Saca la primera imagen de un DataTransfer (portapapeles o arrastre). */
    function primeraImagen(dt) {
        if (!dt) return null;
        // Los archivos sueltos vienen en .files; una captura pegada desde el
        // portapapeles llega en .items y hay que pedirle el File.
        for (const f of dt.files || []) {
            if (/^image\//.test(f.type)) return f;
        }
        for (const it of dt.items || []) {
            if (it.kind === 'file' && /^image\//.test(it.type)) {
                const f = it.getAsFile();
                if (f) return f;
            }
        }
        return null;
    }

    // ---- Pegar (Ctrl+V en la compu, "Pegar" del teclado en el celular) ----
    // Se escucha en el documento y no solo en el campo de texto: uno saca la
    // captura y pega, sin acordarse de hacer clic en el input primero. Igual se
    // ignora si el chat no está a la vista o si está escribiendo en otro lado,
    // para no robarle el pegado a la descripción de un item.
    function conectarPegar() {
        document.addEventListener('paste', async (e) => {
            if (!chatVisible()) return;
            const activo = document.activeElement;
            const escribiendoEnOtroLado = activo
                && activo !== $('#chat-input')
                && /^(INPUT|TEXTAREA)$/.test(activo.tagName);
            if (escribiendoEnOtroLado) return;

            const file = primeraImagen(e.clipboardData);
            if (!file) return;              // pegó texto: que siga su curso normal
            e.preventDefault();
            await adjuntar(file);
        });
    }

    // ---- Arrastrar y soltar ----
    function conectarArrastre() {
        const pane = $('#pane-chat');
        const capa = $('#chat-drop');
        // dragenter/dragleave se disparan también al pasar por los hijos, así que
        // se cuentan las entradas y salidas en vez de confiar en un solo evento.
        let dentro = 0;

        const traeArchivo = (e) =>
            [...(e.dataTransfer?.types || [])].includes('Files');

        pane.addEventListener('dragenter', (e) => {
            if (!traeArchivo(e)) return;
            e.preventDefault();
            dentro++;
            capa.hidden = false;
        });
        pane.addEventListener('dragover', (e) => {
            if (!traeArchivo(e)) return;
            e.preventDefault();             // sin esto el navegador no deja soltar
            e.dataTransfer.dropEffect = 'copy';
        });
        pane.addEventListener('dragleave', () => {
            if (dentro > 0) dentro--;
            if (!dentro) capa.hidden = true;
        });
        pane.addEventListener('drop', async (e) => {
            if (!traeArchivo(e)) return;
            e.preventDefault();
            dentro = 0;
            capa.hidden = true;
            const file = primeraImagen(e.dataTransfer);
            if (!file) { cfg.toast('Eso no es una foto', true); return; }
            await adjuntar(file);
        });

        // Soltar fuera del chat abriría la imagen y te sacaría de la app.
        window.addEventListener('dragover', (e) => { if (traeArchivo(e)) e.preventDefault(); });
        window.addEventListener('drop', (e) => { if (traeArchivo(e)) e.preventDefault(); });
    }

    /** Se llama al abrir un presupuesto: retoma la última conversación, si hay. */
    async function open() {
        limpiarPantalla();
        const budgetId = cfg.getBudgetId();
        if (!budgetId) return;
        try {
            const { chats } = await API.listChats(budgetId);
            if (chats.length) await cargarConversacion(chats[0].id, chats[0].title, chats[0].mode);
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
        if (enviando) return;
        // Con una foto adjunta se puede mandar sin escribir nada: la foto ES el
        // mensaje. Se le pone un texto por defecto para que el modelo sepa qué
        // hacer con ella.
        if (!texto && adjunto) texto = '¿Qué ves en esta foto? Si es una hoja de cambios, decime qué piden.';
        if (!texto) return;

        // Si hay algo esperando confirmación, un "sí" suelto lo aplica: la frase
        // ES la confirmación, no hace falta que además toque el botón.
        if (opsPendientes) {
            if (CONFIRMA.test(texto)) {
                const hecho = aplicar(opsPendientes);
                $('#chat-input').value = '';
                autoGrow();
                pintar('user', texto);
                // Se cuenta lo que se aplicó de verdad. Decir "listo" sin mirar es
                // como quedó el bug de antes: el mensaje decía que sí y el
                // presupuesto seguía igual.
                pintar('assistant', hecho ? `Listo, ${hecho}.` : 'No había nada para aplicar.');
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

        // La foto se saca del estado ANTES de mandarla, así la barra queda libre
        // para escribir el siguiente mensaje mientras este viaja.
        // Si estaba leyendo la respuesta anterior, se calla: ya está preguntando
        // otra cosa y escuchar lo viejo mientras espera lo nuevo confunde.
        Hablar.callar();

        const foto = adjunto;
        quitarAdjunto();

        $('#chat-input').value = '';
        autoGrow();
        $('#chat-empty').hidden = true;
        pintar('user', texto, foto ? { image: foto } : null);

        enviando = true;
        $('#chat-send').disabled = true;
        let pensando = pintarEstado(MODOS[modo].pensando);

        try {
            if (!chatId) {
                const chat = await API.createChat(cfg.getBudgetId(), modo);
                chatId = chat.id;
            }

            // Burbuja que se va llenando con lo que escribe el modelo. Aparece
            // recién con el primer pedazo de texto, así el indicador se ve
            // mientras piensa y no queda una burbuja vacía en el medio.
            let burbuja = null;
            let acumulado = '';
            const onDelta = (trozo) => {
                if (!trozo) return;
                if (!burbuja) {
                    pensando.remove();
                    burbuja = pintar('assistant', '').querySelector('.chat-bubble');
                }
                acumulado += trozo;
                burbuja.textContent = acumulado;
                scrollAbajo();
            };

            // Cuando sale a buscar a internet, lo que ya se había escrito era el
            // "dame un segundo que busco": se descarta y en su lugar va el
            // indicador. Si no, esa frase se queda quieta en pantalla y parece
            // que terminó ahí — que es justo lo que confundía.
            const onStatus = ({ fase, query }) => {
                if (fase === 'buscando') {
                    burbuja?.closest('.chat-msg')?.remove();
                    burbuja = null;
                    acumulado = '';
                    pensando = reemplazarEstado(pensando, 'Buscando en internet…', query);
                } else if (fase === 'redactando') {
                    pensando = reemplazarEstado(pensando, 'Leyendo lo que encontré…');
                }
                scrollAbajo();
            };

            const out = await API.streamChatMessage(chatId, texto, itemFoco, onDelta, foto, onStatus);
            itemFoco = null;
            $('#chat-input').placeholder = 'Escribile al asistente…';
            pensando.remove();
            if (out.title) $('#chat-title').textContent = out.title;

            const { message } = out;
            if (burbuja && !out.replaced) {
                // Ya está casi todo en pantalla: se completa el texto final y se
                // le cuelgan las tarjetas, sin volver a dibujar el mensaje.
                burbuja.textContent = message.content;
                completar(burbuja.closest('.chat-msg'), message.data);
                marcarPendientes(message.data);
            } else {
                // No hubo streaming (o la respuesta se rehízo tras buscar en
                // internet, y lo que se mostró quedó viejo): se pinta de nuevo.
                burbuja?.closest('.chat-msg')?.remove();
                pintar('assistant', message.content, message.data);
            }
            // Recién cuando está el texto final: leer lo que se streameó a medias
            // sería empezar a hablar de algo que todavía puede cambiar.
            leerSiCorresponde(message.content);
            scrollAbajo();
        } catch (err) {
            pensando.remove();
            pintar('assistant', err.message || 'No pude responder, probá de nuevo.');
        } finally {
            enviando = false;
            $('#chat-send').disabled = false;
        }
    }

    /**
     * El cartel de "estoy en esto": anillo girando + qué está haciendo.
     * `extra` es el detalle chico de abajo (la consulta que fue a buscar).
     */
    function pintarEstado(fase, extra) {
        const el = document.createElement('div');
        el.className = 'chat-msg chat-msg-assistant';
        el.innerHTML = `
            <div class="chat-bubble chat-status">
                <span class="chat-status-ring"></span>
                <span class="chat-status-text">
                    <span class="chat-status-fase"></span>
                    <span class="chat-status-extra" hidden></span>
                </span>
            </div>`;
        el.querySelector('.chat-status-fase').textContent = fase;
        if (extra) {
            const ex = el.querySelector('.chat-status-extra');
            // textContent y no innerHTML: la consulta la escribe el modelo.
            ex.textContent = `“${extra}”`;
            ex.hidden = false;
        }
        $('#chat-messages').appendChild(el);
        scrollAbajo();
        return el;
    }

    /** Cambia el cartel por otro, devolviendo el nuevo. */
    function reemplazarEstado(anterior, fase, extra) {
        anterior?.remove();
        return pintarEstado(fase, extra);
    }

    function pintar(role, texto, data, { scroll = true } = {}) {
        $('#chat-empty').hidden = true;
        const wrap = document.createElement('div');
        wrap.className = `chat-msg chat-msg-${role === 'user' ? 'user' : 'assistant'}`;

        // La foto que mandó, arriba de su texto.
        if (data?.image) {
            const img = document.createElement('img');
            img.className = 'chat-photo';
            img.alt = 'Foto adjunta';
            img.src = `data:${data.image.mediaType};base64,${data.image.data}`;
            wrap.appendChild(img);
        }

        const burbuja = document.createElement('div');
        burbuja.className = 'chat-bubble';
        burbuja.textContent = texto;
        wrap.appendChild(burbuja);

        completar(wrap, data);
        if (role !== 'user') marcarPendientes(data);

        $('#chat-messages').appendChild(wrap);
        if (scroll) scrollAbajo();
        return wrap;
    }

    /**
     * Deja anotado lo que quedó "sobre la mesa" esperando un sí o un no.
     *
     * Cada respuesta del asistente reemplaza a la anterior: si esta no propone
     * nada, lo de antes deja de estar pendiente. Aplicar una propuesta de tres
     * mensajes atrás porque dijo "sí" a otra cosa es justamente el bug a evitar.
     *
     * Se llama desde los dos caminos —el normal y el de streaming— a propósito:
     * cuando esto vivía adentro de pintar(), el streaming no pasaba por ahí y las
     * propuestas quedaban sin registrar, así que decir "sí" no aplicaba nada.
     */
    function marcarPendientes(data) {
        opsPendientes = data?.ops?.length ? data.ops : null;
    }

    /** Cuelga las tarjetas (simulación, cambios, avisos, fuentes) de un mensaje. */
    function completar(wrap, data) {
        if (!wrap || !data) return;

        if (data.simulation) wrap.appendChild(tarjetaSimulacion(data.simulation, data.ops));
        else if (data.ops?.length) wrap.appendChild(tarjetaCambios(data.ops));

        if (data.warnings?.length) {
            const av = document.createElement('div');
            av.className = 'chat-warns';
            data.warnings.slice(0, 4).forEach(w => {
                const p = document.createElement('p');
                p.textContent = w;
                av.appendChild(p);
            });
            wrap.appendChild(av);
        }
        if (data.sources?.length) wrap.appendChild(fuentes(data.sources));
        if (data.sugerirPresupuestar) wrap.appendChild(botonArmarPresupuesto());
    }

    /**
     * El botón que ofrece pasar de Asistente/Investigador a Presupuestador con
     * lo que se habló. Un solo clic hace las dos cosas: cambia de modo (así el
     * próximo mensaje ya lo contesta el modo que arma presupuestos) y manda el
     * pedido de armarlo — no hace falta que él lo escriba de nuevo, ya está
     * todo en el historial de esta misma conversación.
     */
    function botonArmarPresupuesto() {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-primary chat-card-switch';
        btn.textContent = 'Armar presupuesto con esto →';
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            btn.textContent = 'Pasando a Presupuestador…';
            await cambiarModo('presupuestador');
            await enviar('Armá el presupuesto con todo lo que hablamos hasta acá.');
            btn.remove();
        });
        return btn;
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

    /**
     * Aplica y devuelve en castellano qué pasó ("agregué 1 item y cambié 2"),
     * o null si no había nada. El que llama lo muestra tal cual: así lo que dice
     * el chat y lo que quedó en el presupuesto no se pueden separar.
     */
    function aplicar(ops) {
        if (!ops?.length) return null;
        cfg.applyOps(ops);
        opsPendientes = null;
        marcarTarjetasResueltas('Aplicado');

        const n = (a) => ops.filter(o => o.action === a).length;
        const partes = [];
        if (n('add'))    partes.push(`agregué ${n('add')} item${n('add') === 1 ? '' : 's'}`);
        if (n('update')) partes.push(`cambié ${n('update')} item${n('update') === 1 ? '' : 's'}`);
        if (n('remove')) partes.push(`saqué ${n('remove')} item${n('remove') === 1 ? '' : 's'}`);
        if (!partes.length) return null;
        return partes.join(' y ');
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

    /** Solo http(s). Una URL de un buscador no debería traer otra cosa, pero
     *  `javascript:` en un href es código que corre con un clic, y el título que
     *  se ve al lado lo puede disfrazar de link normal. */
    function urlSegura(url) {
        try {
            const u = new URL(String(url), location.origin);
            return (u.protocol === 'http:' || u.protocol === 'https:') ? u.href : null;
        } catch {
            return null;
        }
    }

    function fuentes(lista) {
        const box = document.createElement('div');
        box.className = 'chat-sources';
        box.innerHTML = '<span class="chat-sources-label">Fuentes</span>';
        lista.forEach(s => {
            const href = urlSegura(s.url);
            if (!href) return;
            const a = document.createElement('a');
            a.href = href;
            a.target = '_blank';
            a.rel = 'noopener noreferrer';
            a.textContent = s.title || href;
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
