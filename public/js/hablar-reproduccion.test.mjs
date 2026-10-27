// Una locución cancelada puede emitir onend tarde: no debe cortar otra lectura.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const fuente = fs.readFileSync(path.join(dir, 'hablar.js'), 'utf8');
const locuciones = [];
const synth = {
    paused: false, speaking: false, pending: false,
    getVoices: () => [], addEventListener: () => {},
    speak(u) { locuciones.push(u); this.speaking = true; },
    cancel() { this.speaking = false; this.pending = false; },
    pause() { this.paused = true; },
    resume() { this.paused = false; this.speaking = true; },
};
class Utterance { constructor(text) { this.text = text; } }
const Hablar = new Function('window', 'speechSynthesis', 'SpeechSynthesisUtterance', `${fuente}; return Hablar;`)({ speechSynthesis: synth }, synth, Utterance);
let estado = null;
Hablar.alHablar(e => { estado = e; });
Hablar.decir('Primera frase. Segunda frase.', 'viejo');
const vieja = locuciones.slice();
Hablar.decir('Mensaje nuevo.', 'nuevo');
const nueva = locuciones.at(-1);
vieja.at(-1).onend();
if (!Hablar.estaHablando() || Hablar.leyendoId() !== 'nuevo') throw new Error('Un onend viejo cortó la lectura nueva');
Hablar.pausar();
if (!Hablar.estaPausado() || estado?.id !== 'nuevo') throw new Error('No conserva el mensaje al pausar');
Hablar.reanudar();
if (Hablar.estaPausado() || Hablar.leyendoId() !== 'nuevo') throw new Error('No reanuda el mismo mensaje');
nueva.onend();
if (Hablar.estaHablando()) throw new Error('No finalizó al terminar el mensaje');

// En navegadores que no pausan de verdad, pause() no cambia paused y se usa
// cancel(). Su onend tardío tampoco puede tocar la lectura reanudada.
synth.pause = function () { this.paused = false; };
Hablar.decir('Pausa alternativa.', 'alternativa');
const antesDePausa = locuciones.at(-1);
Hablar.pausar();
Hablar.reanudar();
antesDePausa.onend();
if (!Hablar.estaHablando() || Hablar.leyendoId() !== 'alternativa') {
    throw new Error('Un onend de la pausa alternativa cortó la reanudación');
}
Hablar.callar();
console.log('OK   reproducción: cambio de mensaje y pausa');
