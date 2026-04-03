import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const dbPath = resolve(process.cwd(), "data", "market.db");
mkdirSync(dirname(dbPath), { recursive: true });

export const db = new Database(dbPath, { create: true });

db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

export function nowIso() {
  return new Date().toISOString();
}

export function initSchema() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user','admin')) DEFAULT 'user',
      balance REAL NOT NULL DEFAULT 1000,
      total_winnings REAL NOT NULL DEFAULT 0,
      api_key_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS markets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL CHECK(status IN ('active','resolved','archived')) DEFAULT 'active',
      created_by INTEGER NOT NULL,
      resolved_by INTEGER,
      winning_outcome_id INTEGER,
      total_pool REAL NOT NULL DEFAULT 0,
      participant_count INTEGER NOT NULL DEFAULT 0,
      payout_distributed INTEGER NOT NULL DEFAULT 0,
      refund_distributed INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      archived_at TEXT,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
    );

    CREATE TABLE IF NOT EXISTS outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      label TEXT NOT NULL,
      total_amount_staked REAL NOT NULL DEFAULT 0,
      FOREIGN KEY(market_id) REFERENCES markets(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS bets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      market_id INTEGER NOT NULL,
      outcome_id INTEGER NOT NULL,
      amount REAL NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','won','lost','refunded')) DEFAULT 'active',
      payout_amount REAL NOT NULL DEFAULT 0,
      refunded_amount REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(market_id) REFERENCES markets(id) ON DELETE CASCADE,
      FOREIGN KEY(outcome_id) REFERENCES outcomes(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('initial_balance','bet_placed','payout','refund','adjustment')),
      amount REAL NOT NULL,
      market_id INTEGER,
      bet_id INTEGER,
      created_at TEXT NOT NULL,
      meta TEXT,
      FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(market_id) REFERENCES markets(id) ON DELETE SET NULL,
      FOREIGN KEY(bet_id) REFERENCES bets(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      market_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      data_json TEXT NOT NULL,
      FOREIGN KEY(market_id) REFERENCES markets(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_markets_status_created_at ON markets(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bets_user_status ON bets(user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_market ON outcomes(market_id);
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_market_created_at ON market_snapshots(market_id, created_at);
  `);

  // Backward-compatible migration for existing databases created before resolved_by was introduced.
  try {
    db.exec("ALTER TABLE markets ADD COLUMN resolved_by INTEGER;");
  } catch {
    // Column already exists.
  }

  // Backfill for older resolved markets created before resolved_by existed.
  db.exec(`
    UPDATE markets
    SET resolved_by = created_by
    WHERE status = 'resolved' AND resolved_by IS NULL;
  `);
}

export function withTransaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
