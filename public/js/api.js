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
    aiParse(text)      { return this.request('/api/ai/parse', { method: 'POST', body: JSON.stringify({ text }) }); },
    aiSuggest(query, items) { return this.request('/api/ai/suggest', { method: 'POST', body: JSON.stringify({ query, items }) }); },
};
