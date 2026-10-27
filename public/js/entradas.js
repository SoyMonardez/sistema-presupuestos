// Meter items sin escribirlos a mano desde un archivo o una foto.
//
// Produce operaciones y las manda al panel de borrador para que él confirme: no
// toca los items por su cuenta. (El texto libre y el dictado que vivían acá se
// sacaron: los reemplazó el modo conversación, ver conversacion.js.)

const Entradas = (() => {
    const { $, toast } = UI;

    const items = Estado.lista();   // identidad estable, ver estado.js

    // ================= Importar archivo (PDF / Excel / CSV / foto) =================
    const EXT_ARCHIVO = ['pdf', 'xlsx', 'csv'];
    const EXT_FOTO    = ['jpg', 'jpeg', 'png', 'webp', 'heic', 'heif'];

    let importMode = 'import';

    $('#btn-import').addEventListener('click', () => {
        // Con items cargados, una foto puede ser dos cosas muy distintas: una
        // lista para importar, o la hoja de cambios que le devolvió el municipio.
        // Preguntarlo es más barato que adivinar mal.
        if (items.length) { abrirEleccion(); return; }
        pedirArchivo('import');
    });

    function pedirArchivo(mode) {
        importMode = mode;
        const input = $('#import-file');
        input.accept = mode === 'changes'
            ? 'image/*'
            : '.pdf,.xlsx,.csv,image/*';
        input.click();
    }

    function abrirEleccion() {
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
        Borrador.ocultar();
        try {
            if (importMode === 'changes') {
                // Las ops vienen numeradas contra lo que está GUARDADO, así que
                // hay que asegurarse de que no quede nada pendiente de guardar.
                await Estado.flushSave();
                const { ops, summary } = await API.readChangeSheet(file, ext, Estado.actual().id);
                if (!ops.length) {
                    toast(summary || 'No encontré cambios en esa hoja', true);
                    if (summary) Borrador.mostrar([], summary);
                } else {
                    Borrador.mostrar(ops, summary);
                    toast(`${ops.length} cambio${ops.length === 1 ? '' : 's'} propuesto${ops.length === 1 ? '' : 's'}`);
                }
            } else {
                const { items: parsed } = esFoto
                    ? await API.readPhotoItems(file, ext)
                    : await API.importFile(file, ext);
                if (!parsed.length) {
                    toast('No encontré items en ese archivo', true);
                } else {
                    Borrador.mostrar(Borrador.deItems(parsed), '');
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

    return {};
})();
