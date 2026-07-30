import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_UNITS, canonicalLabel } from './lib/units.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'presupuestos.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS budgets (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    client     TEXT NOT NULL DEFAULT '',
    notes      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS items (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_id  INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    name       TEXT NOT NULL,
    quantity   REAL NOT NULL DEFAULT 1,
    unit       TEXT NOT NULL DEFAULT 'un.',
    unit_price REAL NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_items_budget ON items(budget_id);

CREATE TABLE IF NOT EXISTS price_refs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    unit       TEXT NOT NULL DEFAULT 'un.',
    price      REAL NOT NULL DEFAULT 0,
    position   INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Catálogo de unidades. Antes la unidad era texto libre y convivían "m2", "M²" y
-- "metros cuadrados"; ahora hay una sola fuente de verdad, que además el usuario
-- puede ampliar con las suyas ("viaje de arena") desde Precios base.
CREATE TABLE IF NOT EXISTS units (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    code      TEXT NOT NULL UNIQUE,
    label     TEXT NOT NULL,
    kind      TEXT NOT NULL DEFAULT 'other',
    factor    REAL,                              -- NULL = no convertible por escala
    dims      TEXT NOT NULL DEFAULT '[]',        -- JSON: medidas para el camino de geometría
    is_custom INTEGER NOT NULL DEFAULT 0,
    position  INTEGER NOT NULL DEFAULT 0
);

-- Chat por presupuesto, con varias conversaciones (estilo ChatGPT).
CREATE TABLE IF NOT EXISTS chat_conversations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    budget_id  INTEGER NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
    title      TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_conv_budget ON chat_conversations(budget_id);

CREATE TABLE IF NOT EXISTS chat_messages (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
    role            TEXT NOT NULL,
    content         TEXT NOT NULL DEFAULT '',
    tool_json       TEXT NOT NULL DEFAULT '',    -- llamadas a herramientas y sus resultados
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_chat_msg_conv ON chat_messages(conversation_id);
`);

// Migraciones simples: agrega columnas si faltan (la DB puede venir de una versión anterior)
function addColumnIfMissing(table, column, ddl) {
    const exists = db.prepare(`SELECT 1 FROM pragma_table_info(?) WHERE name = ?`).get(table, column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

addColumnIfMissing('budgets', 'location',      `location TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('budgets', 'validity_days', `validity_days INTEGER NOT NULL DEFAULT 10`);
addColumnIfMissing('budgets', 'advance_pct',   `advance_pct REAL NOT NULL DEFAULT 25`);
addColumnIfMissing('items',   'detail',        `detail TEXT NOT NULL DEFAULT ''`);

// Formato del PDF: 'original' (Etan Construcción, color) o 'municipal' (blanco y negro, formal)
addColumnIfMissing('budgets', 'format',          `format TEXT NOT NULL DEFAULT 'original'`);
// Datos del cliente para el formato municipal (cabecera formal)
addColumnIfMissing('budgets', 'client_role',     `client_role TEXT NOT NULL DEFAULT ''`);     // Ej: "Intendente: Dra. Susana Laciar"
addColumnIfMissing('budgets', 'client_address',  `client_address TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('budgets', 'client_cp',       `client_cp TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('budgets', 'client_phone',    `client_phone TEXT NOT NULL DEFAULT ''`);
addColumnIfMissing('budgets', 'client_email',    `client_email TEXT NOT NULL DEFAULT ''`);

// Siembra el catálogo de unidades la primera vez. Después no se toca: si el
// usuario borra una unidad de fábrica, es porque no la usa y no queremos que
// reaparezca en cada reinicio.
const seedUnits = db.transaction(() => {
    const insert = db.prepare(
        `INSERT INTO units (code, label, kind, factor, dims, is_custom, position)
         VALUES (?, ?, ?, ?, ?, 0, ?)`
    );
    DEFAULT_UNITS.forEach((u, i) => {
        insert.run(u.code, u.label, u.kind, u.factor, JSON.stringify(u.dims || []), i);
    });
});

if (db.prepare('SELECT COUNT(*) AS n FROM units').get().n === 0) {
    seedUnits();
}

// Lee el catálogo con los dims ya parseados. Es la fuente de verdad en runtime
// (incluye las unidades propias del usuario), no la lista de DEFAULT_UNITS.
export function loadUnitCatalog() {
    return db.prepare('SELECT * FROM units ORDER BY position, id').all().map(u => ({
        ...u,
        is_custom: Boolean(u.is_custom),
        dims: (() => { try { return JSON.parse(u.dims); } catch { return []; } })(),
    }));
}

// ---------------------------------------------------------------------------
// Migraciones de datos (una sola vez, marcadas con PRAGMA user_version)
// ---------------------------------------------------------------------------
const SCHEMA_VERSION = 1;
const currentVersion = db.pragma('user_version', { simple: true });

if (currentVersion < 1) {
    // v1 — Las unidades venían de un campo de texto libre, así que en la base hay
    // "m2", "M²", "mts2" y "metros cuadrados" mezclados. Sin esto, los presupuestos
    // que ya existen quedan afuera del sistema de conversión.
    const catalog = loadUnitCatalog();
    const normalizeExisting = db.transaction(() => {
        const rows = db.prepare('SELECT id, unit FROM items').all();
        const update = db.prepare('UPDATE items SET unit = ? WHERE id = ?');
        let changed = 0;
        for (const row of rows) {
            const canonical = canonicalLabel(row.unit, catalog);
            if (canonical !== row.unit) { update.run(canonical, row.id); changed++; }
        }
        // El tarifario tiene el mismo problema y alimenta los prompts de la IA.
        const priceRows = db.prepare('SELECT id, unit FROM price_refs').all();
        const updatePrice = db.prepare('UPDATE price_refs SET unit = ? WHERE id = ?');
        for (const row of priceRows) {
            const canonical = canonicalLabel(row.unit, catalog);
            if (canonical !== row.unit) { updatePrice.run(canonical, row.id); changed++; }
        }
        return changed;
    });
    const changed = normalizeExisting();
    if (changed) console.log(`[presupuestos] Unidades normalizadas: ${changed}`);
    db.pragma(`user_version = ${SCHEMA_VERSION}`);
}

export default db;
