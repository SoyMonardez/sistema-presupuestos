// Pruebas de las piezas del servidor de la conversación por voz que no
// necesitan un modelo: los atajos del cortador, su red de seguridad, la
// validación del encabezado y la lectura de las ops antes de que termine el JSON.

import { atajo, normalizarCorte, quedaColgado, quitarEstimados } from './cortador.js';
import { normalizeEncabezado } from './ops.js';
import { objectBefore } from './partial-json.js';
import { vocabularioVoz, promptWhisper, esAlucinacion } from './vocabulario.js';
import { segmentoCreible } from '../ai/providers/groq.js';

let ok = 0, total = 0;
function prueba(nombre, condicion) {
    total++;
    if (condicion) { ok++; console.log(`OK   ${nombre}`); }
    else console.log(`FALLA  ${nombre}`);
}

// ---- atajos ----
for (const [texto, tipo] of [
    ['sí', 'confirmar'], ['Dale.', 'confirmar'], ['si, dale', 'confirmar'], ['metelo', 'confirmar'],
    ['sí a todo', 'confirmar_todo'], ['aplicá todo', 'confirmar_todo'],
    ['no', 'rechazar'], ['dejalo así', 'rechazar'], ['mejor no', 'rechazar'],
    ['deshacé eso', 'deshacer'], ['volvé atrás', 'deshacer'], ['deshacelo', 'deshacer'],
    ['listo, terminamos', 'salir'], ['chau', 'salir'], ['eso es todo, gracias', 'salir'],
]) {
    prueba(`atajo: "${texto}" → ${tipo}`, atajo(texto) === tipo);
}
for (const texto of [
    'sí, pero bajale el precio',
    'no, el precio es 300 mil',
    'agregá un item de demolición',
    'deshacé el item 3 y poné otro',
    '',
]) {
    prueba(`atajo: "${texto}" no es atajo`, atajo(texto) === null);
}

// ---- normalizarCorte ----
{
    const r = normalizarCorte({ instrucciones: [{ texto: 'agregá demolición', tipo: 'pedido' }, { texto: 'x', tipo: 'raro' }], resto: 'y un contrapiso de', acuse: 'Dale' }, '');
    prueba('corte: conserva los pedidos', r.instrucciones.length === 2 && r.instrucciones[0].texto === 'agregá demolición');
    prueba('corte: un tipo desconocido pasa a pedido', r.instrucciones[1].tipo === 'pedido');
    prueba('corte: conserva el resto', r.resto === 'y un contrapiso de');
}
{
    const r = normalizarCorte({ instrucciones: [], resto: 'agregá pintura a' }, 'agregá pintura a', { final: true });
    prueba('corte: al cerrar el turno, el resto se manda como pedido', r.resto === '' && r.instrucciones.length === 1 && r.instrucciones[0].texto === 'agregá pintura a');
}
{
    const r = normalizarCorte(null, 'agregá demolición a 300 mil');
    prueba('corte: si el modelo no devolvió nada, queda esperando', r.resto === 'agregá demolición a 300 mil' && !r.instrucciones.length);
    const f = normalizarCorte(null, 'agregá demolición a 300 mil', { final: true });
    prueba('corte: si el modelo falló al cerrar, todo es un pedido', f.instrucciones.length === 1 && f.instrucciones[0].tipo === 'pedido');
}

{
    // Lo que pasó probándolo: el modelo dio por completo un pedido que cortaba
    // antes del precio, y el precio llegaba como otro pedido.
    const r = normalizarCorte({ instrucciones: [
        { texto: 'revoque grueso 35 metros a 12 mil', tipo: 'pedido' },
        { texto: 'y colocación de cerámica 18 metros cuadrados a', tipo: 'pedido' },
    ], resto: '' }, '');
    prueba('corte: un pedido que termina colgado vuelve a esperar', r.instrucciones.length === 1 && r.resto === 'y colocación de cerámica 18 metros cuadrados a');
    const f = normalizarCorte({ instrucciones: [{ texto: 'cerámica 18 metros a', tipo: 'pedido' }], resto: '' }, '', { final: true });
    prueba('corte: al cerrar el turno, lo colgado se manda igual', f.instrucciones.length === 1 && f.resto === '');
    for (const t of ['contrapiso 20 metros a', 'pintura con', 'un item de', 'el precio es', 'demolición y']) {
        prueba(`colgado: "${t}"`, quedaColgado(t));
    }
    for (const t of ['contrapiso 20 metros a 15 lucas', 'agregá demolición', 'poné de título Casa Pérez']) {
        prueba(`no colgado: "${t}"`, !quedaColgado(t));
    }
}

// ---- quitarEstimados ----
{
    const ops = [
        { action: 'add', item: { name: 'Contrapiso', quantity: 1, unit: 'm²', unit_price: 9000, es_costo_directo: true } },
        { action: 'add', item: { name: 'Colocación de cerámica', quantity: 1, unit: 'm²', unit_price: 44900 } },
        { action: 'add', item: { name: 'Flete', quantity: 1, unit: 'global', unit_price: 0 } },
        { action: 'update', num: 1, unit_price: 5000 },
    ];
    const r = quitarEstimados(ops, ['contrapiso', 'colocación de cerámica', 'flete']);
    prueba('estimados: el precio inventado queda en 0', r.ops[0].item.unit_price === 0 && !('es_costo_directo' in r.ops[0].item));
    prueba('estimados: el del tarifario pasa tal cual', r.ops[1].item.unit_price === 44900);
    prueba('estimados: avisa los que quedaron sin precio', r.sinPrecio.join() === 'Contrapiso,Flete');
    prueba('estimados: no toca los cambios', r.ops[3] === ops[3]);
    const pedido = quitarEstimados(ops, ['cargá contrapiso y estimale el precio']);
    prueba('estimados: si pidió estimar, se respeta', pedido.ops[0].item.unit_price === 9000 && pedido.sinPrecio.length === 0);
    prueba('estimados: "poneles precio de mercado" cuenta como pedido', quitarEstimados(ops, ['poneles precio de mercado']).ops[0].item.unit_price === 9000);
}

// ---- normalizeEncabezado ----
{
    const e = normalizeEncabezado({ name: '  Casa   Pérez ', client: '', notes: 'no', format: 'municipal', validity_days: '15', advance_pct: 140, foo: 'bar' });
    prueba('encabezado: limpia espacios', e.name === 'Casa Pérez');
    prueba('encabezado: lo vacío no borra lo que había', !('client' in e));
    prueba('encabezado: lo que no es del formulario se descarta', !('notes' in e) && !('format' in e) && !('foo' in e));
    prueba('encabezado: números con tope', e.validity_days === 15 && e.advance_pct === 100);
    prueba('encabezado: basura no rompe', Object.keys(normalizeEncabezado(null)).length === 0 && Object.keys(normalizeEncabezado('x')).length === 0);
}

// ---- objectBefore ----
{
    const parcial = '{"pensamiento":"Agrego demolición","ops":[{"action":"add","item":{"name":"Demolición","quantity":1,"unit":"m²","unit_price":320000}}],"encabezado":{},"respuesta":"Listo, agr';
    const o = objectBefore(parcial, 'respuesta');
    prueba('objectBefore: lee las ops antes de que termine la respuesta', o?.ops?.[0]?.item?.unit_price === 320000);
    prueba('objectBefore: todavía sin la clave, null', objectBefore('{"pensamiento":"Agre', 'respuesta') === null);
    prueba('objectBefore: con las ops a medio escribir, null', objectBefore('{"ops":[{"action":"add"', 'respuesta') === null);
    const conCerco = objectBefore('```json\n{"pensamiento":"x","ops":[],"respuesta":"', 'respuesta');
    prueba('objectBefore: tolera el cerco de código', Array.isArray(conCerco?.ops));
}

// ---- vocabulario ----
{
    const v = vocabularioVoz({ items: ['Construcción de veredas', 'Demolición'], tarifario: ['Hormigón armado H17', 'demolición'], max: 10 });
    prueba('vocabulario: lo de él va primero', v[0] === 'Construcción de veredas');
    prueba('vocabulario: sin repetidos aunque cambie la mayúscula', v.filter(t => t.toLowerCase() === 'demolición').length === 1);
    prueba('vocabulario: respeta el tope', v.length === 10);
    const p = promptWhisper(vocabularioVoz({ items: ['Construcción de veredas'] }), 200);
    prueba('prompt: incluye los términos y no se pasa del largo', p.includes('Construcción de veredas') && p.length <= 200);
}

// ---- alucinaciones de Whisper ----
for (const t of ['Subtítulos realizados por la comunidad de Amara.org', '¡Gracias por ver!', 'Suscríbete al canal', '...', '', '¡Gracias!', 'Gracias.', 'Muchas gracias.']) {
    prueba(`alucinación: "${t}"`, esAlucinacion(t));
}
for (const t of ['agregá demolición a 300 mil', 'sí', 'el item 3 a 503 pesos']) {
    prueba(`no alucinación: "${t}"`, !esAlucinacion(t));
}

// ---- segmentos de Whisper ----
prueba('segmento: voz clara pasa', segmentoCreible({ no_speech_prob: 0.02, avg_logprob: -0.2, compression_ratio: 1.3 }));
prueba('segmento: silencio se descarta', !segmentoCreible({ no_speech_prob: 0.85, avg_logprob: -0.9, compression_ratio: 1.1 }));
prueba('segmento: adivinado se descarta', !segmentoCreible({ no_speech_prob: 0.1, avg_logprob: -1.5, compression_ratio: 1.2 }));
prueba('segmento: repetición se descarta', !segmentoCreible({ no_speech_prob: 0.1, avg_logprob: -0.3, compression_ratio: 3.1 }));
prueba('segmento: algo de ruido pero confiado pasa', segmentoCreible({ no_speech_prob: 0.7, avg_logprob: -0.2, compression_ratio: 1.2 }));

console.log(`\n${ok}/${total}`);
process.exit(ok === total ? 0 : 1);
