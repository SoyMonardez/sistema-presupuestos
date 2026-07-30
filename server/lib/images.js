// Preparación de imágenes antes de mandarlas a un modelo de visión.
//
// Una foto sacada con el celular viene en 3000-4000 px y pesa varios MB. Eso son
// miles de tokens por request y, en el tier gratuito de Groq, directamente no
// entra (corta en 8000 TPM). Bajarla a ~1600 px no le saca legibilidad a una hoja
// impresa —que es exactamente lo que se fotografía acá— y abarata cada lectura.
//
// De paso normaliza el formato: los iPhone sacan HEIC y varios modelos no lo
// aceptan; después de esto siempre sale JPEG.
//
// Se apoya en Pillow, que ya está instalado para el lector de archivos, así que
// no suma dependencias nuevas.

import { spawn } from 'node:child_process';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, '..', 'scripts', 'shrink.py');
const PYTHON = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3');

const ANCHO_MAX = Number(process.env.VISION_MAX_WIDTH) || 1600;

function runShrink(entrada, salida, anchoMax) {
    return new Promise((resolve, reject) => {
        let py;
        try {
            py = spawn(PYTHON, [SCRIPT, entrada, salida, String(anchoMax)], {
                env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
            });
        } catch {
            return reject(new Error('No se pudo ejecutar Python'));
        }
        let out = '', err = '';
        py.stdout.on('data', d => { out += d; });
        py.stderr.on('data', d => { err += d; });
        py.on('error', () => reject(new Error('No se pudo ejecutar Python')));
        py.on('close', () => {
            const line = out.trim().split('\n').filter(Boolean).pop();
            if (!line) return reject(new Error(err.slice(0, 200) || 'El redimensionador no devolvió nada'));
            try {
                const data = JSON.parse(line);
                if (data.error) return reject(new Error(data.error));
                resolve(data);
            } catch {
                reject(new Error('Respuesta inválida del redimensionador'));
            }
        });
    });
}

/**
 * Corre una lectura con imagen y, si el proveedor la rechaza por tamaño,
 * reintenta con una versión más chica en vez de devolverle un error al usuario.
 *
 * Cuánto mide la imagen decide cuántos tokens cuesta la lectura, y los límites
 * por minuto son bajos en los planes gratuitos. Una hoja impresa —que es lo que
 * se fotografía acá— se sigue leyendo bien bastante más abajo de lo que sale de
 * la cámara, así que bajar la resolución es mejor que fallar.
 *
 * @param {(imagen: {type:'image', data:string, mediaType:string}) => Promise<any>} fn
 * @param {number[]} anchos  de mayor a menor
 */
export async function conReintentoDeTamaño(buffer, mediaType, fn, anchos = [1100, 900, 700]) {
    let ultimoError;
    for (const ancho of anchos) {
        const preparada = await prepareForVision(buffer, mediaType, { maxWidth: ancho });
        try {
            return await fn({ type: 'image', ...preparada });
        } catch (err) {
            // Solo tiene sentido reintentar si se quejó por el tamaño.
            const porTamaño = /\b413\b|too large|rate_limit_exceeded|tokens per minute/i.test(err.message);
            ultimoError = err;
            if (!porTamaño) throw err;
            console.warn(`[vision] ${ancho}px no entró, reintento más chico`);
        }
    }
    throw ultimoError;
}

/**
 * Deja una imagen lista para el modelo de visión.
 *
 * Si algo falla al achicarla, devuelve la original en vez de romper: es mejor
 * intentar la lectura con la foto pesada (y que el modelo se queje si no entra)
 * que negarle al usuario la función entera por un problema de Pillow.
 *
 * @returns {Promise<{ data: string, mediaType: string }>} base64 listo para mandar
 */
export async function prepareForVision(buffer, mediaType, { maxWidth = ANCHO_MAX } = {}) {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const entrada = path.join(os.tmpdir(), `presu_vis_in_${id}`);
    const salida  = path.join(os.tmpdir(), `presu_vis_out_${id}.jpg`);

    try {
        fs.writeFileSync(entrada, buffer);
        const info = await runShrink(entrada, salida, maxWidth);
        const shrunk = fs.readFileSync(salida);
        console.log(`[vision] imagen ${info.original_width}x${info.original_height} → ${info.width}x${info.height} (${Math.round(buffer.length / 1024)}kb → ${Math.round(shrunk.length / 1024)}kb)`);
        return { data: shrunk.toString('base64'), mediaType: 'image/jpeg' };
    } catch (err) {
        console.warn('[vision] no se pudo achicar la imagen, va la original:', err.message);
        return { data: buffer.toString('base64'), mediaType };
    } finally {
        fs.unlink(entrada, () => {});
        fs.unlink(salida, () => {});
    }
}
