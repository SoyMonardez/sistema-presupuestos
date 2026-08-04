// El panel de "esto es lo que voy a cambiar, ¿lo aplico?".
//
// Es el único camino por el que la IA toca el presupuesto: todo lo que proponen
// el texto libre, el dictado, la foto y la hoja de cambios del municipio termina
// mostrado acá y no se aplica hasta que él toca Aplicar. La regla del proyecto es
// esa — la IA extrae y propone, el servidor calcula y el usuario confirma.

const Borrador = (() => {
    const { $, toast, formatQty } = UI;

    const items = Estado.lista();   // identidad estable, ver estado.js

    let draftOps = [];              // lo propuesto, pendiente de confirmar

    /** Envoltorio para que importar un archivo (que solo agrega) use este mismo panel. */
    function deItems(parsedItems) {
        return parsedItems.map(item => ({ action: 'add', item }));
    }

    function describir(op) {
        if (op.action === 'add') {
            const d = op.item;
            return {
                tag: '+ Nuevo', tagClass: 'draft-op-add',
                title: d.name,
                detail: `${formatQty(d.quantity)} ${d.unit} × ${formatARS(d.unit_price)}`,
            };
        }
        const cur = items[op.num - 1];
        if (op.action === 'update') {
            const f = op.fields;
            const changes = [];
            if (f.quantity !== undefined || f.unit !== undefined) {
                changes.push(`${formatQty(cur?.quantity)} ${cur?.unit} → ${formatQty(f.quantity ?? cur?.quantity)} ${f.unit ?? cur?.unit}`);
            }
            if (f.unit_price !== undefined) changes.push(`${formatARS(cur?.unit_price)} → ${formatARS(f.unit_price)}`);
            if (f.name !== undefined) changes.push(`nombre → "${f.name}"`);
            if (f.detail !== undefined) changes.push('detalle actualizado');
            return {
                tag: `✎ Item ${op.num}`, tagClass: 'draft-op-update',
                title: cur ? cur.name : `Item ${op.num}`,
                detail: changes.join(' · '),
            };
        }
        // remove
        return {
            tag: `✕ Borrar item ${op.num}`, tagClass: 'draft-op-remove',
            title: cur ? cur.name : `Item ${op.num}`,
            detail: '',
        };
    }

    function mostrar(ops, summary) {
        draftOps = ops;
        const listEl = $('#draft-list');
        listEl.innerHTML = '';
        if (summary) {
            const s = document.createElement('p');
            s.className = 'draft-summary';
            s.textContent = summary;
            listEl.appendChild(s);
        }
        for (const op of ops) {
            const d = describir(op);
            const row = document.createElement('div');
            row.className = 'draft-item';

            // Estructura primero, contenido con textContent después.
            //
            // Acá antes se interpolaba d.title y d.detail directo en innerHTML, y
            // eso era un XSS de verdad, no teórico: el nombre de un item no lo
            // escribe solo el usuario — sale de un Excel o un PDF que le manda un
            // municipio, o de una foto que interpreta la IA. Un nombre con
            // <img src=x onerror=...> ejecutaba en el momento de mostrar el
            // borrador, y desde ahí se lee el token de localStorage.
            row.innerHTML = `
                <div class="draft-item-main">
                    <span class="draft-op-tag"></span>
                    <span class="draft-item-title"></span>
                </div>
                <span class="draft-item-detail"></span>`;

            const tag = row.querySelector('.draft-op-tag');
            tag.classList.add(d.tagClass);          // clase controlada por nosotros, no por el dato
            tag.textContent = d.tag;
            row.querySelector('.draft-item-title').textContent = d.title;
            row.querySelector('.draft-item-detail').textContent = d.detail;

            listEl.appendChild(row);
        }
        // Una hoja puede leerse bien y no proponer ningún cambio aplicable (todo
        // fue a "no encontré a qué item corresponde"). Ahí el resumen importa,
        // pero ofrecer "Aplicar" no tendría sentido.
        $('#btn-draft-add').hidden = !ops.length;
        $('#draft-panel').hidden = false;
    }

    function ocultar() {
        $('#draft-panel').hidden = true;
        $('#btn-draft-add').hidden = false;
        draftOps = [];
    }

    $('#btn-draft-cancel').addEventListener('click', ocultar);
    $('#btn-draft-add').addEventListener('click', () => {
        const ops = draftOps;
        ocultar();
        Estado.aplicarYGuardar(ops);
        toast('Cambios aplicados');
    });

    return { mostrar, ocultar, deItems };
})();
