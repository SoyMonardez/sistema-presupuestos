// El presupuesto abierto: quién es, qué items tiene, y cuándo se guarda.
//
// Por qué existe este archivo: antes `currentBudget` e `items` eran dos variables
// sueltas adentro del IIFE de app.js, y cualquiera de las 54 funciones que vivían
// ahí podía escribirlas. El bug de la conversión de unidades salió exactamente de
// eso —una función pisándole el estado a otra— y encontrarlo costó tres intentos
// porque no había un solo lugar donde mirar.
//
// Ahora el estado está acá y afuera solo se ve a través de funciones. Las reglas
// que se ganan con eso:
//
//   - `items` es SIEMPRE el mismo array. Nunca se reemplaza, se vacía y se
//     rellena. Varios módulos se lo guardan por referencia (el chat, el
//     conversor), y si se cambiara por otro se quedarían apuntando al viejo.
//   - Guardar es de uno solo: `hacerGuardado` no vuelve a leer el estado después
//     de un `await`, y hay una cola para que dos guardados no lleguen al servidor
//     fuera de orden.
//   - Quién repinta la pantalla y quién sabe leer el formulario del editor se
//     registran una vez (`conectar`), así este módulo no depende de ningún #id.

const Estado = (() => {
    const { $, toast } = UI;

    let presupuesto = null;     // { id, name, client, notes, format, ... }
    const items = [];           // [{ name, detail, quantity, unit, unit_price }]

    // Los enganches con el resto de la app. Vacíos por defecto para que este
    // módulo se pueda cargar (y probar) sin nada más alrededor.
    let leerCampos = () => ({});
    let repintar = () => {};

    let saveTimer = null;

    /**
     * Le enseña al estado dos cosas que solo el editor sabe: cómo leer su
     * formulario y cómo repintar la lista de items.
     */
    function conectar({ campos, onRender }) {
        if (campos) leerCampos = campos;
        if (onRender) repintar = onRender;
    }

    // ---------- Lectura ----------
    const actual = () => presupuesto;
    const lista  = () => items;
    const hayPresupuesto = () => Boolean(presupuesto);

    // ---------- Escritura ----------
    function abrir(datos, nuevosItems) {
        presupuesto = datos;
        reemplazarItems(nuevosItems);
    }

    /** Cierra el presupuesto abierto. flushSave se saltea solo cuando no hay ninguno. */
    function cerrar() {
        presupuesto = null;
    }

    /** Vacía y rellena en el sitio: la identidad del array no cambia (ver arriba). */
    function reemplazarItems(nuevos) {
        items.length = 0;
        for (const i of nuevos || []) items.push(i);
    }

    function agregarItem(item) {
        items.push(item);
        return items.length - 1;
    }

    function sacarItem(index) {
        if (index >= 0 && index < items.length) items.splice(index, 1);
    }

    /** Cambia un campo suelto del presupuesto (formato, notas). */
    function set(campo, valor) {
        if (presupuesto) presupuesto[campo] = valor;
    }

    function render() { repintar(); }

    // ---------- Guardado ----------
    function scheduleSave() {
        $('#save-status').textContent = 'Guardando…';
        clearTimeout(saveTimer);
        saveTimer = setTimeout(flushSave, 900);
    }

    // Un guardado a la vez.
    //
    // `saveItems` reemplaza la lista entera. Si se solapan dos guardados y llegan
    // fuera de orden —cosa fácil si escribe mientras uno está en vuelo—, el viejo
    // pisa al nuevo y se pierde la última edición sin que nada lo avise. Con esto,
    // el que llega mientras hay uno corriendo espera a que termine y recién ahí
    // manda el estado actual, que además ya incluye lo que se escribió mientras
    // tanto.
    let guardadoEnCurso = null;

    function flushSave() {
        clearTimeout(saveTimer);
        if (!presupuesto) return Promise.resolve();
        guardadoEnCurso = (guardadoEnCurso || Promise.resolve())
            .then(hacerGuardado, hacerGuardado);
        return guardadoEnCurso;
    }

    async function hacerGuardado() {
        // Se relee acá: entre que se encoló y le toca el turno, puede haber
        // salido del presupuesto.
        if (!presupuesto) return;

        // El id y los items se congelan ANTES del primer await. Leerlos después
        // de una ida al servidor es pedir que, si mientras tanto abrió otro
        // presupuesto, la segunda llamada escriba en el que no es.
        const id = presupuesto.id;
        const aGuardar = items.map(i => ({ ...i }));
        const campos = leerCampos();

        try {
            await API.updateBudget(id, campos);
            await API.saveItems(id, aGuardar);
            $('#save-status').textContent = 'Guardado';
            setTimeout(() => { if ($('#save-status').textContent === 'Guardado') $('#save-status').textContent = ''; }, 1500);
        } catch (err) {
            $('#save-status').textContent = '';
            toast('No se pudo guardar: ' + err.message, true);
        }
    }

    // ---------- Operaciones de la IA ----------
    /**
     * Aplica operaciones sobre `items`, en el sitio.
     *
     * Esta función existía escrita tres veces —el panel de borrador, el chat, y
     * applyOps() del servidor— con el mismo orden sutil copiado a mano. El orden
     * no es un detalle: si se toca, hay que acordarse de los tres lugares, y el
     * que se olvide corrompe presupuestos en silencio. Acá queda una sola vez
     * para el cliente; el servidor tiene la suya en server/lib/ops.js porque
     * trabaja sobre una copia, no sobre el estado de la pantalla.
     *
     * El orden: primero editar (los índices siguen valiendo), después borrar de
     * mayor a menor (así los que faltan procesar no se corren), y recién al final
     * agregar los nuevos (que no tienen número previo que respetar).
     */
    function aplicarOps(ops) {
        ops.filter(o => o.action === 'update').forEach(op => {
            const idx = op.num - 1;
            if (items[idx]) Object.assign(items[idx], op.fields);
        });
        ops.filter(o => o.action === 'remove')
            .map(o => o.num)
            .sort((a, b) => b - a)
            .forEach(num => items.splice(num - 1, 1));
        ops.filter(o => o.action === 'add').forEach(op => items.push(op.item));
    }

    /** Lo de arriba más repintar y guardar: es lo que quiere casi todo el que llama. */
    function aplicarYGuardar(ops) {
        aplicarOps(ops);
        render();
        scheduleSave();
    }

    return {
        conectar,
        actual, lista, hayPresupuesto,
        abrir, cerrar, reemplazarItems, agregarItem, sacarItem, set,
        render, scheduleSave, flushSave,
        aplicarOps, aplicarYGuardar,
    };
})();
