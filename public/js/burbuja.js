// La burbuja: el orbe flotando encima de otras apps.
//
// La idea es la del modo voz de ChatGPT en Android: tener el pliego abierto en
// WhatsApp, leerlo en voz alta y que el presupuesto se vaya cargando solo, con
// el orbe a la vista para saber si escucha, piensa o carga.
//
// Una página web no puede dibujar encima de otras apps. Lo que sí puede es
// mandar un video a "imagen en imagen" (PiP): Android lo muestra en una
// ventanita que queda arriba de todo, se arrastra a cualquier parte de la
// pantalla y mantiene viva la página que la abrió (el micrófono sigue
// abierto). Así que el orbe se pinta en un canvas, el canvas se convierte en
// video con captureStream() y ese video es el que flota.
//
// Lo que no se puede: tocar la burbuja como un botón. Android solo le pone
// sus controles (volver a la app, cerrar) y el de reproducir/pausa, que acá
// es pausar y seguir escuchando.

const Burbuja = (() => {
    const LADO = 320;   // px del video; Android lo achica a la ventanita
    let canvas = null, g2d = null, video = null, reloj = null;
    let activa = false;
    let alPausar = () => {};
    let error = '';

    function soportada() {
        return Boolean(document.pictureInPictureEnabled
            && HTMLCanvasElement.prototype.captureStream
            && HTMLVideoElement.prototype.requestPictureInPicture);
    }

    function preparar() {
        if (video) return;
        canvas = document.createElement('canvas');
        canvas.width = canvas.height = LADO;
        g2d = canvas.getContext('2d');
        video = document.createElement('video');
        video.muted = true;
        video.playsInline = true;
        video.srcObject = canvas.captureStream(20);
        // Tiene que estar en la página para que algunos navegadores lo dejen
        // flotar, pero no se ve.
        video.className = 'burbuja-video';
        video.setAttribute('aria-hidden', 'true');
        document.body.appendChild(video);

        // El botón de pausa de la ventanita: deja de escuchar sin cerrarla.
        video.addEventListener('pause', () => { if (activa) alPausar(true); });
        video.addEventListener('play', () => { if (activa) alPausar(false); });
        video.addEventListener('leavepictureinpicture', () => cerrar());
    }

    // requestAnimationFrame se frena cuando la página no está a la vista, que
    // es justo cuando flota: se pinta con un intervalo.
    // Solo el orbe, lo más grande que entra, sobre negro: la ventanita de
    // Android siempre es un rectángulo y no puede ser transparente, así que
    // el negro es lo que más se parece a "nada". El color y el movimiento ya
    // dicen en qué anda; en pausa el video se congela y el orbe queda quieto.
    const ESCALA = 1.15;   // más grande no: hablando, el borde se saldría
    function pintarCuadro() {
        const lado = LADO * ESCALA;
        g2d.fillStyle = '#000';
        g2d.fillRect(0, 0, LADO, LADO);
        g2d.save();
        g2d.translate((LADO - lado) / 2, (LADO - lado) / 2);
        Orbe.pintar(g2d, lado, performance.now(), { fondo: '#000' });
        g2d.restore();
    }

    /**
     * Abre la burbuja. Tiene que llamarse desde un toque: el navegador no deja
     * abrir la ventanita por su cuenta.
     */
    let abriendo = false;
    async function abrir({ onPausa } = {}) {
        if (!soportada()) return false;
        // Un doble toque abría dos veces: el segundo play() cortaba al primero
        // y la burbuja quedaba flotando en pausa.
        if (abriendo || activa) return activa;
        abriendo = true;
        try { return await abrirYa(onPausa); } finally { abriendo = false; }
    }

    async function abrirYa(onPausa) {
        error = '';
        if (onPausa) alPausar = onPausa;
        preparar();
        pintarCuadro();
        clearInterval(reloj);
        reloj = setInterval(pintarCuadro, 50);
        try {
            await video.play();
            await video.requestPictureInPicture();
            activa = true;
            if ('mediaSession' in navigator) {
                navigator.mediaSession.metadata = new MediaMetadata({ title: 'Presupuesto', artist: 'Te escucho' });
            }
            return true;
        } catch (err) {
            console.warn('[burbuja] no se pudo abrir', err);
            // Se muestra en el aviso: desde el celular es la única forma de saber por qué.
            error = [err?.name, err?.message].filter(Boolean).join(': ').slice(0, 120);
            cerrar();
            return false;
        }
    }

    function cerrar() {
        const estaba = activa;
        activa = false;
        clearInterval(reloj);
        reloj = null;
        if (document.pictureInPictureElement === video) document.exitPictureInPicture().catch(() => {});
        video?.pause();
        // Si se cerró en pausa, que no quede sin escuchar sin saberlo.
        if (estaba) alPausar(false);
    }

    return { soportada, abrir, cerrar, activa: () => activa, ultimoError: () => error };
})();
