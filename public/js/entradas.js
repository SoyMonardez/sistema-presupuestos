// Las tres formas de meter items sin escribirlos a mano: texto libre, dictado y
// archivo/foto.
//
// Son tres entradas distintas pero terminan igual: producen operaciones y las
// mandan al panel de borrador para que él confirme. Ninguna toca los items por su
// cuenta.

const Entradas = (() => {
    const { $, toast } = UI;

    const items = Estado.lista();   // identidad estable, ver estado.js

    // ================= Texto libre → IA =================
    function ocultarPanel() { $('#ai-panel').hidden = true; }

    $('#btn-ai-text').addEventListener('click', () => {
        Borrador.ocultar();
        $('#ai-panel').hidden = false;
        $('#ai-text').focus();
    });
    $('#btn-ai-cancel').addEventListener('click', ocultarPanel);

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
                ocultarPanel();
                Borrador.mostrar(ops, summary);
            }
        } catch (err) {
            toast(err.message, true);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Aplicar con IA';
        }
    });

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
        ocultarPanel();
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
        ocultarPanel();
        Borrador.ocultar();

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
                    else Borrador.mostrar(ops, summary);
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

    return { ocultarPanel };
})();
