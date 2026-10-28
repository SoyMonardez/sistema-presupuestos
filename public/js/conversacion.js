// El modo conversación: dictarle el presupuesto de corrido, como el modo voz
// de ChatGPT.
//
// Cómo viaja un pedido:
//
//   Escucha (Scribe, palabra por palabra)
//     └─ pedazo cerrado ─▶ /api/voz/cortar (Groq): ¿qué parte ya es un pedido?
//                            ├─ "sí", "no", "deshacé", "terminamos" → se resuelve acá
//                            └─ pedidos ─▶ cola ─▶ /api/voz/turno (Claude)
//                                                   ├─ pensamiento → tarjeta
//                                                   ├─ ops → Auto: se aplican con animación
//                                                   │        Manual: esperan un "sí"
//                                                   └─ respuesta → se dice en voz alta
//
// Tres reglas que hacen que se sienta una conversación y no un formulario:
//
//   1. No le habla encima. Mientras él sigue dictando, lo que el asistente
//      tiene para decir se junta; cada cambio aplicado suena con un "tic".
//      Cuando hace una pausa, dice UN resumen. Es lo que permite leerle una
//      planilla entera de corrido.
//   2. Si él habla mientras el asistente habla, el asistente se calla.
//   3. Si pensar tarda, contesta algo corto al toque ("dale, lo anoto") para
//      que no parezca colgado.
//
// La lógica que no depende de la pantalla (proyectar pendientes, qué índices
// tocó una tanda, armar el resumen) está en `Logica`, para poder probarla en
// node (ver conversacion.test.mjs).

const ConversacionLogica = (() => {
    /** Mismo orden que Estado.aplicarOps, pero sobre una copia. */
    function aplicarCopia(items, ops) {
        const out = items.map(i => ({ ...i }));
        ops.filter(o => o.action === 'update').forEach(op => {
            if (out[op.num - 1]) Object.assign(out[op.num - 1], op.fields);
        });
        ops.filter(o => o.action === 'remove').map(o => o.num).sort((a, b) => b - a)
            .forEach(num => out.splice(num - 1, 1));
        ops.filter(o => o.action === 'add').forEach(op => out.push({ ...op.item }));
        return out;
    }

    /**
     * La lista como quedaría si se aplicaran las tandas pendientes, en orden.
     * Los turnos nuevos se piensan sobre ESTA lista: si hay un "agregá X"
     * esperando el sí, "cambiale el precio al último" tiene que ser X.
     */
    function proyectar(items, tandas) {
        return tandas.reduce((acc, t) => aplicarCopia(acc, t.ops), items);
    }

    /**
     * Saca una tanda pendiente. Las que vienen después se pensaron sobre una
     * lista que la incluía, así que sus cambios por número (update/remove) ya
     * no apuntan a donde deberían: se descartan. Las altas no dependen de
     * ningún número y se conservan.
     */
    function rechazar(tandas, indice) {
        return tandas.filter((_, i) => i !== indice).map((t, i) => {
            if (i < indice) return t;
            const ops = t.ops.filter(o => o.action === 'add');
            return ops.length === t.ops.length ? t : { ...t, ops, recortada: true };
        }).filter(t => t.ops.length || Object.keys(t.encabezado || {}).length);
    }

    /**
     * Qué tarjetas tocó una tanda, en índices de la lista YA aplicada, para
     * animarlas. Las bajas van en índices de antes (se animan antes de borrar).
     */
    function indicesTocados(ops, largoAntes) {
        const bajas = ops.filter(o => o.action === 'remove').map(o => o.num - 1);
        const cambios = ops.filter(o => o.action === 'update')
            .filter(o => !bajas.includes(o.num - 1))
            .map(o => ({ idx: o.num - 1 - bajas.filter(b => b < o.num - 1).length, campos: o.fields }));
        const base = largoAntes - bajas.length;
        const altas = ops.filter(o => o.action === 'add').map((_, k) => base + k);
        return { altas, cambios, bajas };
    }

    /**
     * Lo que se dice después de una pausa. Si hubo una sola respuesta, esa. Si
     * se juntaron varias (estaba dictando de corrido), un resumen corto en vez
     * de leerlas todas seguidas.
     */
    function armarResumen(respuestas, contados) {
        const validas = respuestas.filter(Boolean);
        if (validas.length <= 1) return validas[0] || '';
        const { altas = [], cambios = 0, bajas = 0, sinPrecio = 0 } = contados || {};
        const partes = [];
        if (altas.length) {
            const nombres = altas.slice(0, 3).join(', ');
            partes.push(altas.length === 1 ? `agregué ${nombres}`
                : altas.length <= 3 ? `agregué ${altas.length} items: ${nombres}`
                : `agregué ${altas.length} items, entre ellos ${nombres}`);
        }
        if (cambios) partes.push(cambios === 1 ? 'cambié uno' : `cambié ${cambios}`);
        if (bajas) partes.push(bajas === 1 ? 'saqué uno' : `saqué ${bajas}`);
        if (!partes.length) return validas[validas.length - 1];
        const aviso = !sinPrecio ? ''
            : sinPrecio === 1 ? ' Uno quedó sin precio, dictámelo cuando quieras.'
            : ` ${sinPrecio} quedaron sin precio, dictámelos cuando quieras.`;
        return `Listo, ${partes.join(' y ')}.${aviso} ¿Con qué seguimos?`;
    }

    /**
     * ¿Es momento de hablar? Solo si él no está hablando y ya hizo una pausa.
     * La pausa es larga a propósito: leyendo una planilla respira entre fila y
     * fila, y si el asistente arranca ahí lo pisa (en el celular, además, el
     * micrófono se suelta mientras habla y lo que él dice se pierde).
     */
    function tocaHablar({ hayParaDecir, usuarioHabla, msDesdeQueHablo, ocupado, pausaMs = 1800 }) {
        return hayParaDecir && !usuarioHabla && !ocupado && msDesdeQueHablo >= pausaMs;
    }

    /**
     * ¿Lo que "escuchó" es la voz del propio asistente saliendo por el parlante?
     * La cancelación de eco del navegador no es perfecta, y el reconocedor
     * transcribe lo que se cuela. Si casi todas las palabras están en algo que
     * acaba de decir, es eco y no un pedido.
     */
    //
    // Se comparan pares de palabras seguidas y no palabras sueltas: el eco
    // repite la frase en el mismo orden, mientras que un pedido nuevo comparte
    // palabras sueltas con lo que se acaba de decir ("el contrapiso quedó a 18
    // mil" → "ahora el contrapiso a 21 mil"). Con palabras sueltas, ese pedido
    // se descartaba como eco: pasó probándolo.
    function esEco(texto, dichos) {
        const palabras = (t) => String(t || '').toLowerCase()
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .split(/[^a-z0-9ñ]+/).filter(Boolean);
        const pares = (ps) => ps.slice(1).map((p, i) => ps[i] + ' ' + p);
        const oidos = pares(palabras(texto));
        if (oidos.length < 2) return false;   // menos de tres palabras: no alcanza para decidir
        const dichos2 = new Set(dichos.flatMap(d => pares(palabras(d))));
        if (!dichos2.size) return false;
        const coinciden = oidos.filter(p => dichos2.has(p)).length;
        return coinciden / oidos.length >= 0.6;
    }

    return { aplicarCopia, proyectar, rechazar, indicesTocados, armarResumen, tocaHablar, esEco };
})();

const Conversacion = (typeof window === 'undefined') ? null : (() => {
    const { $, toast } = UI;
    const L = ConversacionLogica;

    const CLAVE_AUTO = 'presu_voz_auto';
    // En el celular, mientras el asistente habla se suelta el micrófono: con
    // el micrófono abierto el teléfono queda en "modo llamada" y el sonido sale
    // bajito por el parlante de la oreja (ver Escucha.pausarMic). En la PC no
    // pasa, así que ahí sigue escuchando siempre y se lo puede cortar hablando.
    const ALTAVOZ = window.matchMedia('(pointer: coarse)').matches;
    let reabriendoMic = false;
    // Con la burbuja flotando (ver burbuja.js) el micrófono no se suelta para
    // hablar: él está en otra app, y volver a pedir el micrófono desde atrás
    // puede fallar y dejarlo sin escuchar. La respuesta sale más bajito, pero
    // mientras lee un pliego casi no hace falta oírla.
    const sueltaMic = () => ALTAVOZ && !Burbuja.activa();
    let enPausa = false;            // el botón de pausa de la burbuja
    const CIERRE_TURNO_MS = 2500;   // sin hablar este rato, lo que quedó partido se manda igual
    const ACUSE_MS = 1300;          // si pensar tarda más que esto, contesta algo corto
    const MAX_HISTORIAL = 12;

    let cfg = {};
    let activo = false;
    let auto = leerAuto();

    // Lo que escuchó y todavía no pensó
    let resto = '';                 // pedazo que quedó cortado a mitad de idea
    let ultimoAcuse = '';
    let cortando = Promise.resolve();
    let cortesEnVuelo = 0;
    let colaPedidos = [];
    let pensando = false;
    let aplicando = false;
    let controlador = null;
    // Las tandas se aplican de a una y en orden. Un turno nuevo espera a que
    // termine la anterior antes de sacar la foto de los items: si no, los
    // números de item que piense apuntarían a la lista vieja.
    let aplicaciones = Promise.resolve();

    // Lo que pensó y todavía no se aplicó / no se dijo
    let pendientes = [];            // [{ ops, encabezado, tarjeta }]
    let paraDecir = [];
    let contados = { altas: [], cambios: 0, bajas: 0, sinPrecio: 0 };
    let historial = [];

    let ultimaVozUsuario = 0;
    // Lo que dijo el asistente hace poco, para reconocer su propio eco.
    let dichosRecientes = [];   // [{ texto, hasta }]
    const ECO_MS = 6000;        // cuánto después de terminar de hablar puede llegar el eco
    let estabaHablando = false;
    let reloj = null;
    let timerCierre = null;

    function leerAuto() {
        try { return localStorage.getItem(CLAVE_AUTO) !== '0'; } catch { return true; }
    }

    function init(c) {
        cfg = c;
        Orbe.init({
            onSalir: () => salir(),
            onDeshacer: () => deshacer(),
            onAuto: (v) => {
                auto = v;
                try { localStorage.setItem(CLAVE_AUTO, v ? '1' : '0'); } catch {}
                // Pasar a Auto con cosas esperando es decir "dale a todo".
                if (v && pendientes.length) aplicarHasta(pendientes.length - 1);
            },
            nivel: () => (Hablar.estaHablando() ? Hablar.nivel() : Escucha.nivel()),
            // Tocar el orbe mientras habla lo calla.
            onTocar: () => {
                if (!Hablar.estaHablando()) return false;
                Hablar.callar();
                return true;
            },
        });
        $('#btn-conversar').addEventListener('click', () => (activo ? salir() : entrar()));
        const btnBurbuja = $('#voz-burbuja');
        btnBurbuja.hidden = !Burbuja.soportada();
        btnBurbuja.addEventListener('click', () => abrirBurbuja());
        document.addEventListener('keydown', (e) => { if (activo && e.key === 'Escape') salir(); });
        document.addEventListener('visibilitychange', alCambiarVisibilidad);
    }

    // ---------- La burbuja: seguir escuchando desde otra app ----------
    async function abrirBurbuja() {
        const ok = await Burbuja.abrir({
            onPausa: (si) => {
                enPausa = si;
                if (si) Hablar.callar();
                Orbe.subtitulo(si ? 'En pausa' : '');
            },
        });
        if (!ok) toast(`No pude dejar el orbe flotando (${Burbuja.ultimoError() || 'el navegador no lo permite'})`, true);
    }

    // Probándolo, salió de la app sin tocar "Flotar" y esperaba que el orbe
    // apareciera solo, como en ChatGPT. El navegador no deja abrir la burbuja
    // sin un toque, y sin ella Android frena la página al salir: no escucha
    // más. Así que al volver se le explica qué pasó y qué tocar.
    let seFueSinBurbuja = false;
    function alCambiarVisibilidad() {
        if (!activo) return;
        if (document.hidden) {
            seFueSinBurbuja = !Burbuja.activa();
            return;
        }
        if (!seFueSinBurbuja) return;
        seFueSinBurbuja = false;
        const aviso = Burbuja.soportada()
            ? 'Mientras estabas en otra app no te escuchaba. Para leer desde otra app, tocá «Flotar» antes de salir.'
            : 'Mientras estabas en otra app no te escuchaba: este navegador no deja seguir escuchando desde afuera.';
        toast(aviso);
        Orbe.subtitulo(aviso);
        if (Orbe.estaMini()) Orbe.expandir();
    }

    // ---------- Entrar y salir ----------
    async function entrar() {
        if (activo) return;
        if (!Escucha.soportada()) { toast('Este navegador no permite conversar por voz', true); return; }
        activo = true;
        auto = leerAuto();
        // Todo esto tiene que salir del toque: sin eso, iOS y Chrome dejan el
        // audio mudo.
        Sonidos.contexto();
        Hablar.callar();
        Hablar.destrabar();
        Orbe.abrir({ auto });
        Orbe.permitirDeshacer(Estado.puedeDeshacer());
        $('#btn-conversar').classList.add('activo');
        Sonidos.entrar();
        // Donde Chrome lo permite (por ahora en la PC, en páginas que usan el
        // micrófono), la burbuja se abre sola al cambiar de pestaña o de app.
        // Donde no, esto no hace nada y queda el botón.
        try { navigator.mediaSession?.setActionHandler('enterpictureinpicture', () => abrirBurbuja()); } catch {}

        const ok = await Escucha.iniciar({
            presupuesto: Estado.actual()?.id,
            onParcial: alParcial,
            onSegmento: alSegmento,
            onHabla: (habla) => { if (habla) ultimaVozUsuario = Date.now(); },
            onModo: (modo) => { if (modo === 'respaldo') Orbe.subtitulo('Te escucho (sin subtítulos en vivo)'); },
            onError: (msg) => { toast(msg, true); },
        });
        if (!ok) { salir({ silencioso: true }); return; }

        reloj = setInterval(latido, 200);
        // La primera vez se presenta; las demás alcanza con el sonido.
        if (!historial.length) {
            paraDecir.push(auto
                ? 'Te escucho. Decime qué cargamos.'
                : 'Te escucho. Te voy a mostrar cada cambio antes de hacerlo.');
            ultimaVozUsuario = 0;
        }
    }

    function salir({ silencioso = false } = {}) {
        if (!activo) return;
        activo = false;
        clearInterval(reloj);
        clearTimeout(timerCierre);
        controlador?.abort();
        Escucha.detener();
        Hablar.callar();
        Burbuja.cerrar();
        try { navigator.mediaSession?.setActionHandler('enterpictureinpicture', null); } catch {}
        seFueSinBurbuja = false;
        enPausa = false;
        Orbe.cerrar();
        $('#btn-conversar').classList.remove('activo');
        if (pendientes.length) toast('Quedaron cambios sin aplicar: los descarté');
        resto = ''; colaPedidos = []; pendientes = []; paraDecir = [];
        contados = { altas: [], cambios: 0, bajas: 0, sinPrecio: 0 };
        pensando = false; aplicando = false;
        if (!silencioso) Sonidos.salir();
    }

    // ---------- Lo que escucha ----------
    /** Habla y anota lo que dijo (ver esEco). */
    function decir(texto) {
        // Se estima cuánto va a tardar en decirlo (~14 caracteres por segundo)
        // para saber hasta cuándo su eco puede seguir llegando.
        const dura = (String(texto).length / 14) * 1000;
        dichosRecientes.push({ texto, hasta: Date.now() + dura + ECO_MS });
        // Antes de que empiece a sonar: con el micrófono suelto, el celular
        // usa el altavoz.
        if (sueltaMic()) Escucha.pausarMic();
        Hablar.encolar(texto);
    }

    function esMiEco(texto) {
        const ahora = Date.now();
        dichosRecientes = dichosRecientes.filter(d => d.hasta > ahora);
        return L.esEco(texto, dichosRecientes.map(d => d.texto));
    }

    function alParcial(texto) {
        if (!activo || enPausa) return;
        // Su propio eco no cuenta como que él habló.
        if (esMiEco(texto)) return;
        ultimaVozUsuario = Date.now();
        // Habló encima del asistente: se calla. Con dos o más letras, para que
        // un ruido suelto que se coló como "eh" no lo corte.
        if (texto.length > 2 && Hablar.estaHablando()) Hablar.callar();
        Orbe.subtitulo(texto, { provisorio: true });
    }

    function alSegmento(texto) {
        if (!activo || enPausa) return;
        if (esMiEco(texto)) return;
        ultimaVozUsuario = Date.now();
        if (Hablar.estaHablando()) Hablar.callar();
        Orbe.subtitulo(texto);
        cortar({ nuevo: texto });
    }

    // Los cortes van de a uno: el segundo necesita el "resto" que dejó el primero.
    function cortar({ nuevo = '', final = false }) {
        clearTimeout(timerCierre);
        cortesEnVuelo++;
        cortando = cortando.then(async () => {
            if (!activo) return;
            const previo = resto;
            let r;
            try {
                r = await API.vozCortar({ resto: previo, nuevo, final });
            } catch {
                // Sin cortador, todo lo dictado va como un pedido.
                r = { instrucciones: [{ texto: [previo, nuevo].filter(Boolean).join(' '), tipo: 'pedido' }], resto: '' };
            }
            if (!activo) return;
            resto = r.resto || '';
            if (r.acuse) ultimoAcuse = r.acuse;
            for (const i of r.instrucciones || []) manejar(i);
            if (resto) timerCierre = setTimeout(cerrarTurnoSiCallo, CIERRE_TURNO_MS);
            procesarCola();
        }).finally(() => { cortesEnVuelo--; });
    }

    function cerrarTurnoSiCallo() {
        if (!activo || !resto) return;
        if (Escucha.estaHablando()) { timerCierre = setTimeout(cerrarTurnoSiCallo, 600); return; }
        cortar({ final: true });
    }

    function manejar({ texto, tipo }) {
        switch (tipo) {
            case 'confirmar':
            case 'confirmar_todo':
                if (pendientes.length) aplicarHasta(pendientes.length - 1);
                else colaPedidos.push(texto);   // "sí" sin nada pendiente: que lo interprete Claude
                break;
            case 'rechazar':
                if (pendientes.length) {
                    pendientes.forEach(p => p.tarjeta.descartada());
                    pendientes = [];
                    paraDecir.push('Listo, no lo hago.');
                } else colaPedidos.push(texto);
                break;
            case 'deshacer':
                deshacer();
                break;
            case 'salir':
                Hablar.callar();
                decir('Dale, cualquier cosa me llamás.');
                setTimeout(() => salir(), 2200);
                break;
            default:
                colaPedidos.push(texto);
        }
    }

    // ---------- Pensar ----------
    async function procesarCola() {
        if (!activo || pensando || !colaPedidos.length) return;
        // Todo lo que se juntó va en una sola tanda: si está leyendo una
        // planilla, una vuelta con cinco items es mucho más rápida que cinco.
        const pedidos = colaPedidos.splice(0);
        pensando = true;
        await aplicaciones;
        // Que lo último que se aplicó ya esté guardado: si pide "volvé al
        // cambio anterior", ese cambio tiene que estar en el historial.
        await Estado.flushSave();
        const tarjeta = Orbe.nuevaTarjeta(pedidos);
        let recibioOps = false;
        let respuestaParcial = '';
        let pensamientoParcial = '';

        const acuse = ultimoAcuse;
        ultimoAcuse = '';
        const timerAcuse = setTimeout(() => {
            if (!recibioOps && activo && acuse && !Escucha.estaHablando() && !Hablar.estaHablando()) {
                decir(acuse);
            }
        }, ACUSE_MS);

        controlador = new AbortController();
        try {
            const final = await API.streamVozTurno({
                instrucciones: pedidos,
                presupuesto: Estado.actual()?.id,
                items: L.proyectar(Estado.lista(), pendientes),
                encabezado: cfg.leerEncabezado(),
                historial,
                auto,
            }, {
                onPensamiento: (t) => { pensamientoParcial += t; tarjeta.pensamiento(t); },
                onOps: (tanda) => { recibioOps = true; recibirTanda(tanda, tarjeta); },
                onRespuesta: (t) => { respuestaParcial += t; },
            }, controlador.signal);

            tarjeta.fijarPensamiento(final.pensamiento);
            const respuesta = final.respuesta || respuestaParcial;
            if (respuesta) paraDecir.push(respuesta);
            historial.push(
                { rol: 'usuario', texto: pedidos.join('. ') },
                { rol: 'asistente', texto: [final.pensamiento || pensamientoParcial, respuesta].filter(Boolean).join(' ') },
            );
            historial = historial.slice(-MAX_HISTORIAL);
        } catch (err) {
            if (err.name !== 'AbortError' && activo) {
                tarjeta.error(err.message);
                Sonidos.error();
                paraDecir.push(err.message);
            }
        } finally {
            clearTimeout(timerAcuse);
            controlador = null;
            pensando = false;
            if (activo) procesarCola();
        }
    }

    function recibirTanda({ ops = [], encabezado = {}, warnings = [] }, tarjeta) {
        const hayCambios = ops.length || Object.keys(encabezado).length;
        if (warnings.length) tarjeta.pensamiento('\n⚠ ' + warnings.join(' '));
        if (!hayCambios) { tarjeta.info(); return; }

        const tanda = { ops, encabezado, tarjeta };
        if (auto) {
            encolarAplicacion([tanda]);
            return;
        }
        pendientes.push(tanda);
        Sonidos.pregunta();
        // Se busca por tarjeta y no por objeto: rechazar una tanda anterior
        // puede reemplazar a esta por una copia recortada.
        const posicion = () => pendientes.findIndex(p => p.tarjeta === tarjeta);
        tarjeta.propuesta({
            onAplicar: () => aplicarHasta(posicion()),
            onDejar: () => {
                const i = posicion();
                if (i < 0) return;
                const antes = pendientes;
                pendientes = L.rechazar(pendientes, i);
                tarjeta.descartada();
                // Las que dependían de esta perdieron cambios: se avisa.
                antes.slice(i + 1).forEach(p => {
                    const queda = pendientes.find(q => q.tarjeta === p.tarjeta);
                    if (!queda) p.tarjeta.descartada();
                    else if (queda.recortada) p.tarjeta.pensamiento('\n(Saqué los cambios que dependían del que descartaste.)');
                });
            },
        });
    }

    /** Aplica en orden las pendientes hasta la `indice` inclusive. */
    function aplicarHasta(indice) {
        if (indice < 0) return;
        const tandas = pendientes.splice(0, indice + 1);
        encolarAplicacion(tandas);
        if (!auto && !paraDecir.length) paraDecir.push(tandas.length > 1 ? 'Listo, apliqué todo.' : 'Listo.');
    }

    function encolarAplicacion(tandas) {
        for (const t of tandas) {
            aplicaciones = aplicaciones
                .then(() => (activo ? aplicarTanda(t) : null))
                .catch(err => { aplicando = false; console.error('[conversacion] no se pudo aplicar', err); });
        }
    }

    // ---------- Hacer ----------
    async function aplicarTanda({ ops, encabezado, tarjeta }) {
        aplicando = true;
        tarjeta.haciendo();
        Estado.instantanea();
        const antes = Estado.lista();
        const { altas, cambios, bajas } = L.indicesTocados(ops, antes.length);

        await Promise.all(bajas.map(i => Items.animarBaja(i)));
        Estado.aplicarYGuardar(ops, 'voz');
        altas.forEach((i, k) => setTimeout(() => Items.animarAlta(i), k * 180));
        cambios.forEach(({ idx, campos }) => Items.animarCambio(idx, campos));
        if (Object.keys(encabezado).length) {
            Estado.aplicarEncabezado(encabezado);
            cfg.animarEncabezado?.(encabezado);
        }

        const lista = Estado.lista();
        contados.altas.push(...altas.map(i => lista[i]?.name).filter(Boolean));
        contados.cambios += cambios.length;
        contados.bajas += bajas.length;
        contados.sinPrecio += altas.filter(i => lista[i] && !(Number(lista[i].unit_price) > 0)).length;

        tarjeta.aplicada();
        Sonidos.aplicado();
        Orbe.permitirDeshacer(true);
        await new Promise(r => setTimeout(r, 450));
        aplicando = false;
    }

    function deshacer() {
        Hablar.callar();
        if (Estado.deshacer()) {
            Sonidos.aplicado();
            paraDecir.push('Listo, lo deshice.');
            historial.push({ rol: 'asistente', texto: '(Se deshizo el último cambio.)' });
        } else {
            // En esta sesión no hay nada guardado para deshacer (por ejemplo,
            // recargó la página). El historial del servidor sí lo tiene: se le
            // pide a Claude que revierta el último cambio con eso.
            colaPedidos.push('Deshacé el último cambio que se hizo en el presupuesto.');
            procesarCola();
        }
        Orbe.permitirDeshacer(Estado.puedeDeshacer());
    }

    // ---------- Cada 200 ms: en qué fase está y si toca hablar ----------
    function latido() {
        if (!activo) return;
        const hablando = Hablar.estaHablando();

        // Terminó de hablar: "te toca". En el celular primero se vuelve a abrir
        // el micrófono, y el sonido avisa recién cuando ya está escuchando.
        //
        // No depende de ver el momento justo en que termina: si el micrófono
        // está en pausa y no está hablando (una frase cortísima que terminó
        // entre dos latidos, o una que quedó vacía), se reabre igual.
        if (ALTAVOZ && Escucha.micEnPausa() && !hablando && !reabriendoMic) {
            reabriendoMic = true;
            Escucha.reanudarMic().then(ok => {
                reabriendoMic = false;
                if (ok && activo) Sonidos.teEscucho();
            });
        } else if (!sueltaMic() && estabaHablando && !hablando) {
            Sonidos.teEscucho();
        }
        estabaHablando = hablando;

        const ocupado = pensando || aplicando || cortesEnVuelo > 0 || colaPedidos.length > 0 || Boolean(resto) || hablando;
        if (L.tocaHablar({
            hayParaDecir: paraDecir.length > 0,
            usuarioHabla: Escucha.estaHablando(),
            msDesdeQueHablo: Date.now() - ultimaVozUsuario,
            ocupado,
        })) {
            const texto = L.armarResumen(paraDecir, contados);
            paraDecir = [];
            contados = { altas: [], cambios: 0, bajas: 0, sinPrecio: 0 };
            if (texto) decir(texto);
        }

        Orbe.cambiarFase(
            hablando ? 'hablando'
            : aplicando ? 'haciendo'
            : (pensando || cortesEnVuelo > 0) ? 'pensando'
            : pendientes.length ? 'esperando'
            : 'escuchando');
    }

    return { init, entrar, salir, activo: () => activo };
})();

// Para poder probar la lógica desde node (ver conversacion.test.mjs).
if (typeof module !== 'undefined') module.exports = { ConversacionLogica };
