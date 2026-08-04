// Content-Security-Policy: la red que atrapa lo que se nos escape.
//
// Por qué está acá y no en una constante: el <head> del index tiene un <script>
// inline (el que aplica el tema antes de pintar, para que no haya un flash del
// color equivocado). Para permitirlo sin abrir la puerta a todo hace falta el
// hash de su contenido exacto — y un hash escrito a mano se desincroniza la
// primera vez que alguien toca ese script, dejando la página rota o, peor, con
// la CSP desactivada de hecho.
//
// Así que el hash se calcula al arrancar, leyendo el HTML real. No puede quedar
// viejo.

import crypto from 'node:crypto';
import fs from 'node:fs';

/** Hashes sha256 de todos los <script> sin src del HTML, en formato CSP. */
function hashesDeScriptsInline(html) {
    const hashes = [];
    // Solo los que NO tienen src: esos son los que la CSP bloquea por defecto.
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html)) !== null) {
        const contenido = m[1];
        if (!contenido.trim()) continue;
        const hash = crypto.createHash('sha256').update(contenido, 'utf8').digest('base64');
        hashes.push(`'sha256-${hash}'`);
    }
    return hashes;
}

/**
 * Arma la cabecera leyendo el index.html de una vez, al arrancar.
 * Si el archivo no está, devuelve null y el servidor sigue sin CSP: es una capa
 * de defensa, no algo que deba impedir que la app levante.
 */
export function buildCsp(indexPath) {
    let html;
    try {
        html = fs.readFileSync(indexPath, 'utf8');
    } catch {
        console.warn('[csp] no pude leer index.html, arranco sin CSP');
        return null;
    }

    const inline = hashesDeScriptsInline(html).join(' ');

    return [
        "default-src 'self'",
        // jsPDF viene de cdnjs; el resto es local. El hash cubre el script del tema.
        `script-src 'self' https://cdnjs.cloudflare.com ${inline}`.trim(),
        // 'unsafe-inline' por el atributo style= que queda en el HTML y porque el
        // PDF y las animaciones escriben el.style.*. Es la parte más floja de esta
        // política; sacarla implica limpiar esos estilos primero.
        "style-src 'self' 'unsafe-inline'",
        // data: para el favicon SVG y las fotos en base64; blob: para la vista
        // previa de lo que se adjunta en el chat.
        "img-src 'self' data: blob:",
        "font-src 'self'",
        "connect-src 'self'",
        // Nada de esta app va adentro de un iframe.
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'",
    ].join('; ');
}
