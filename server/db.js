import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

export default db;
