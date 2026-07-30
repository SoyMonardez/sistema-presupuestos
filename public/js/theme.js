// Tema claro / oscuro.
//
// El tema real ya se aplicó en un script inline en el <head>, antes de pintar,
// para que no haya un flash del color equivocado al abrir. Acá va solo la parte
// que necesita interacción: alternarlo y recordarlo.

const Theme = (() => {
    const KEY = 'presu_theme';

    // Lo que va en la barra de estado del celular. Tiene que coincidir con el
    // --bg de cada paleta en app.css.
    const BARRA = { light: '#f6f5f3', dark: '#141416' };

    function actual() {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    function aplicar(tema) {
        document.documentElement.dataset.theme = tema;
        document.querySelector('meta[name="theme-color"]')?.setAttribute('content', BARRA[tema]);
        try { localStorage.setItem(KEY, tema); } catch { /* modo incógnito */ }
        document.querySelectorAll('[data-theme-toggle]').forEach(pintarBoton);
    }

    function alternar() {
        aplicar(actual() === 'dark' ? 'light' : 'dark');
    }

    const SOL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" width="21" height="21"><circle cx="12" cy="12" r="4.2"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
    const LUNA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="21" height="21"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

    // El botón muestra a dónde vas, no dónde estás: en claro se ve la luna.
    function pintarBoton(btn) {
        const oscuro = actual() === 'dark';
        btn.innerHTML = oscuro ? SOL : LUNA;
        btn.title = oscuro ? 'Cambiar a tema claro' : 'Cambiar a tema oscuro';
        btn.setAttribute('aria-label', btn.title);
    }

    function init() {
        document.querySelectorAll('[data-theme-toggle]').forEach(btn => {
            pintarBoton(btn);
            btn.addEventListener('click', alternar);
        });

        // Si nunca eligió a mano, seguir lo que haga el celular.
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', (e) => {
            try { if (localStorage.getItem(KEY)) return; } catch { /* sigue */ }
            document.documentElement.dataset.theme = e.matches ? 'dark' : 'light';
            document.querySelectorAll('[data-theme-toggle]').forEach(pintarBoton);
        });
    }

    return { init, alternar, actual };
})();
