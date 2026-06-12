// Formato peso argentino: $1.500.000,50 (sin decimales cuando es entero)
const arsFormatter = new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
});

function formatARS(value) {
    return arsFormatter.format(Number(value) || 0);
}

function formatDate(isoOrSql) {
    if (!isoOrSql) return '';
    // SQLite guarda "YYYY-MM-DD HH:MM:SS" en UTC
    const date = new Date(isoOrSql.includes('T') ? isoOrSql : isoOrSql.replace(' ', 'T') + 'Z');
    return date.toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}
