// Wrapper de fetch con token. Si el token expira, vuelve al login.
const API = {
    getToken() { return localStorage.getItem('presu_token') || ''; },
    setToken(t) { localStorage.setItem('presu_token', t); },
    clearToken() { localStorage.removeItem('presu_token'); },

    async request(path, options = {}) {
        const res = await fetch(path, {
            ...options,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${this.getToken()}`,
                ...options.headers,
            },
        });
        if (res.status === 401 && path !== '/api/login') {
            this.clearToken();
            window.dispatchEvent(new Event('auth-expired'));
            throw new Error('Sesión vencida');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        return data;
    },

    login(password) {
        return this.request('/api/login', { method: 'POST', body: JSON.stringify({ password }) });
    },
    listBudgets()      { return this.request('/api/budgets'); },
    createBudget(body) { return this.request('/api/budgets', { method: 'POST', body: JSON.stringify(body) }); },
    getBudget(id)      { return this.request(`/api/budgets/${id}`); },
    updateBudget(id, body) { return this.request(`/api/budgets/${id}`, { method: 'PUT', body: JSON.stringify(body) }); },
    deleteBudget(id)   { return this.request(`/api/budgets/${id}`, { method: 'DELETE' }); },
    saveItems(id, items) { return this.request(`/api/budgets/${id}/items`, { method: 'PUT', body: JSON.stringify({ items }) }); },
    getPrices()        { return this.request('/api/prices'); },
    savePrices(prices) { return this.request('/api/prices', { method: 'PUT', body: JSON.stringify({ prices }) }); },
    getSettings()      { return this.request('/api/settings'); },
    saveSettings(body) { return this.request('/api/settings', { method: 'PUT', body: JSON.stringify(body) }); },
    getUnits()         { return this.request('/api/units'); },
    saveUnits(units)   { return this.request('/api/units', { method: 'PUT', body: JSON.stringify({ units }) }); },
    // A qué unidades puede ir `from`, y qué medida hace falta para cada una.
    unitPlan(from)     { return this.request('/api/units/plan', { method: 'POST', body: JSON.stringify({ from }) }); },
    // La cuenta la hace el servidor: devuelve ops listas para confirmar.
    convertUnits(body) { return this.request('/api/units/convert', { method: 'POST', body: JSON.stringify(body) }); },
    aiParse(text)      { return this.request('/api/ai/parse', { method: 'POST', body: JSON.stringify({ text }) }); },
    aiCommand(text, items) { return this.request('/api/ai/command', { method: 'POST', body: JSON.stringify({ text, items }) }); },
    async aiTranscribe(blob) {
        const res = await fetch('/api/ai/transcribe', {
            method: 'POST',
            headers: {
                'Content-Type': blob.type || 'audio/webm',
                'Authorization': `Bearer ${this.getToken()}`,
            },
            body: blob,
        });
        if (res.status === 401) {
            this.clearToken();
            window.dispatchEvent(new Event('auth-expired'));
            throw new Error('Sesión vencida');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        return data;
    },
    aiSuggest(query, items) { return this.request('/api/ai/suggest', { method: 'POST', body: JSON.stringify({ query, items }) }); },
    aiSpellcheck(texts)     { return this.request('/api/ai/spellcheck', { method: 'POST', body: JSON.stringify({ texts }) }); },
    aiClientData(name)      { return this.request('/api/ai/client-data', { method: 'POST', body: JSON.stringify({ name }) }); },
    // ---- Chat del presupuesto ----
    listChats(budgetId)   { return this.request(`/api/budgets/${budgetId}/chats`); },
    createChat(budgetId, mode) { return this.request(`/api/budgets/${budgetId}/chats`, { method: 'POST', body: JSON.stringify({ mode }) }); },
    chatMessages(chatId)  { return this.request(`/api/chats/${chatId}/messages`); },
    deleteChat(chatId)    { return this.request(`/api/chats/${chatId}`, { method: 'DELETE' }); },
    setChatMode(chatId, mode) { return this.request(`/api/chats/${chatId}`, { method: 'PATCH', body: JSON.stringify({ mode }) }); },
    sendChatMessage(chatId, text, itemNum) {
        return this.request(`/api/chats/${chatId}/messages`, {
            method: 'POST',
            body: JSON.stringify({ text, item_num: itemNum || undefined }),
        });
    },
    /**
     * Manda el mensaje y va avisando el texto a medida que llega.
     * EventSource no sirve acá porque solo hace GET, así que se lee el cuerpo
     * de la respuesta a mano.
     * @returns el mismo objeto que sendChatMessage
     */
    async streamChatMessage(chatId, text, itemNum, onDelta, image, onStatus) {
        const res = await fetch(`/api/chats/${chatId}/messages/stream`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${this.getToken()}` },
            // La foto viaja en base64 dentro del JSON. Ya viene achicada del
            // navegador (~150 kb), así que no hace falta multipart ni body crudo.
            body: JSON.stringify({ text, item_num: itemNum || undefined, image: image || undefined }),
        });
        if (res.status === 401) {
            this.clearToken();
            window.dispatchEvent(new Event('auth-expired'));
            throw new Error('Sesión vencida');
        }
        if (!res.ok || !res.body) {
            const data = await res.json().catch(() => ({}));
            throw new Error(data.error || `Error ${res.status}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let final = null;
        let error = null;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            // Los eventos SSE van separados por una línea en blanco.
            const bloques = buffer.split('\n\n');
            buffer = bloques.pop() || '';
            for (const bloque of bloques) {
                const evento = bloque.match(/^event:\s*(.+)$/m)?.[1]?.trim();
                const datos = bloque.match(/^data:\s*(.+)$/m)?.[1];
                if (!evento || !datos) continue;
                let payload;
                try { payload = JSON.parse(datos); } catch { continue; }

                if (evento === 'delta') onDelta?.(payload.text);
                // En qué anda: "buscando en internet", "redactando". Es lo que
                // hace que una búsqueda de diez segundos no parezca un cuelgue.
                else if (evento === 'status') onStatus?.(payload);
                else if (evento === 'done') final = payload;
                else if (evento === 'error') error = payload.error;
            }
        }

        if (error) throw new Error(error);
        if (!final) throw new Error('La respuesta se cortó. Probá de nuevo.');
        return final;
    },

    // ---- Visión: fotos ----
    // Mismo patrón que importFile y el audio: el archivo va como body crudo.
    async _postImage(file, ext, query) {
        const res = await fetch(`/api/ai/vision?ext=${encodeURIComponent(ext)}&${query}`, {
            method: 'POST',
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'Authorization': `Bearer ${this.getToken()}`,
            },
            body: file,
        });
        if (res.status === 401) {
            this.clearToken();
            window.dispatchEvent(new Event('auth-expired'));
            throw new Error('Sesión vencida');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        return data;
    },
    // La hoja que devuelve el municipio: se compara contra el presupuesto guardado.
    readChangeSheet(file, ext, budgetId) {
        return this._postImage(file, ext, `mode=changes&budget=${budgetId}`);
    },
    // Una foto de una lista de trabajos → items nuevos.
    readPhotoItems(file, ext) {
        return this._postImage(file, ext, 'mode=import');
    },
    async importFile(file, ext) {
        const res = await fetch('/api/import?ext=' + encodeURIComponent(ext), {
            method: 'POST',
            headers: {
                'Content-Type': file.type || 'application/octet-stream',
                'Authorization': `Bearer ${this.getToken()}`,
            },
            body: file,
        });
        if (res.status === 401) {
            this.clearToken();
            window.dispatchEvent(new Event('auth-expired'));
            throw new Error('Sesión vencida');
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
        return data;
    },
};
