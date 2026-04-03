import { Database } from "bun:sqlite";
import { AsyncLocalStorage } from "node:async_hooks";
import { mkdirSync } from "node:fs";
import postgres, { type Sql } from "postgres";
import { dirname, resolve } from "node:path";

type RunResult = {
  lastInsertRowid: number;
  changes: number;
};

type PreparedQuery = {
  get: (...params: unknown[]) => Promise<unknown | null>;
  all: (...params: unknown[]) => Promise<unknown[]>;
  run: (...params: unknown[]) => Promise<RunResult>;
};

type DbAdapter = {
  provider: "sqlite" | "postgres";
  query: (sql: string) => PreparedQuery;
  exec: (sql: string) => Promise<void>;
  transaction: <T>(fn: () => Promise<T>) => Promise<T>;
};

type DbLike = {
  provider: "sqlite" | "postgres";
  query: (sql: string) => PreparedQuery;
  exec: (sql: string) => Promise<void>;
};

function nowIso() {
  return new Date().toISOString();
}

function convertPlaceholders(sqlText: string) {
  let inSingleQuote = false;
  let index = 1;
  let output = "";

  for (let i = 0; i < sqlText.length; i++) {
    const char = sqlText[i];

    if (char === "'" && sqlText[i - 1] !== "\\") {
      inSingleQuote = !inSingleQuote;
      output += char;
      continue;
    }

    if (!inSingleQuote && char === "?") {
      output += `$${index++}`;
      continue;
    }

    output += char;
  }

  return output;
}

function createSqliteAdapter() {
  const dbPath = resolve(process.cwd(), "data", "market.db");
  mkdirSync(dirname(dbPath), { recursive: true });
  const sqlite = new Database(dbPath, { create: true });

  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");

  const adapter: DbAdapter = {
    provider: "sqlite",
    query(sqlText) {
      return {
        get: async (...params: unknown[]) => sqlite.query(sqlText).get(...params),
        all: async (...params: unknown[]) => sqlite.query(sqlText).all(...params),
        run: async (...params: unknown[]) => {
          const result = sqlite.query(sqlText).run(...params);
          return {
            lastInsertRowid: Number(result.lastInsertRowid || 0),
            changes: Number(result.changes || 0),
          };
        },
      };
    },
    exec: async (sqlText) => {
      sqlite.exec(sqlText);
    },
    transaction: async <T>(fn: () => Promise<T>) => {
      sqlite.exec("BEGIN IMMEDIATE");
      try {
        const result = await fn();
        sqlite.exec("COMMIT");
        return result;
      } catch (error) {
        sqlite.exec("ROLLBACK");
        throw error;
      }
    },
  };

  return adapter;
}

function createPostgresAdapter() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for postgres provider");
  }

  const rootSql = postgres(databaseUrl, {
    max: Number(process.env.PG_POOL_MAX || 10),
    idle_timeout: 20,
    connect_timeout: 20,
    prepare: false,
  });
  const txStore = new AsyncLocalStorage<Sql<{}>>();

  function currentSql() {
    return txStore.getStore() || rootSql;
  }

  const adapter: DbAdapter = {
    provider: "postgres",
    query(sqlText) {
      const converted = convertPlaceholders(sqlText);
      return {
        get: async (...params: unknown[]) => {
          const rows = (await currentSql().unsafe(converted, params as never[])) as unknown[];
          return rows[0] ?? null;
        },
        all: async (...params: unknown[]) => {
          const rows = (await currentSql().unsafe(converted, params as never[])) as unknown[];
          return rows;
        },
        run: async (...params: unknown[]) => {
          const rows = (await currentSql().unsafe(converted, params as never[])) as unknown[] & {
            count?: number;
          };
          return {
            lastInsertRowid: Number((rows[0] as Record<string, unknown> | undefined)?.id || 0),
            changes: Number(rows.count || rows.length || 0),
          };
        },
      };
    },
    exec: async (sqlText) => {
      await currentSql().unsafe(sqlText);
    },
    transaction: async <T>(fn: () => Promise<T>) => {
      return rootSql.begin(async (tx) => txStore.run(tx, fn));
    },
  };

  return adapter;
}

const usePostgres = process.env.DB_PROVIDER === "postgres" || Boolean(process.env.DATABASE_URL);
const adapter = usePostgres ? createPostgresAdapter() : createSqliteAdapter();

export const db: DbLike = {
  provider: adapter.provider,
  query: adapter.query,
  exec: adapter.exec,
};

export { nowIso };

export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  return adapter.transaction(fn);
}

async function initSqliteSchema() {
  await db.exec(`
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

  try {
    await db.exec("ALTER TABLE markets ADD COLUMN resolved_by INTEGER;");
  } catch {
    // Column already exists.
  }

  await db.exec(`
    UPDATE markets
    SET resolved_by = created_by
    WHERE status = 'resolved' AND resolved_by IS NULL;
  `);
}

async function initPostgresSchema() {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user','admin')),
      balance DOUBLE PRECISION NOT NULL DEFAULT 1000,
      total_winnings DOUBLE PRECISION NOT NULL DEFAULT 0,
      api_key_hash TEXT,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      expires_at TIMESTAMPTZ NOT NULL
    );

    CREATE TABLE IF NOT EXISTS markets (
      id BIGSERIAL PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','resolved','archived')),
      created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      resolved_by BIGINT,
      winning_outcome_id BIGINT,
      total_pool DOUBLE PRECISION NOT NULL DEFAULT 0,
      participant_count INTEGER NOT NULL DEFAULT 0,
      payout_distributed BOOLEAN NOT NULL DEFAULT FALSE,
      refund_distributed BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS outcomes (
      id BIGSERIAL PRIMARY KEY,
      market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      total_amount_staked DOUBLE PRECISION NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS bets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      outcome_id BIGINT NOT NULL REFERENCES outcomes(id) ON DELETE CASCADE,
      amount DOUBLE PRECISION NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','won','lost','refunded')),
      payout_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      refunded_amount DOUBLE PRECISION NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL,
      resolved_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK(type IN ('initial_balance','bet_placed','payout','refund','adjustment')),
      amount DOUBLE PRECISION NOT NULL,
      market_id BIGINT REFERENCES markets(id) ON DELETE SET NULL,
      bet_id BIGINT REFERENCES bets(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL,
      meta TEXT
    );

    CREATE TABLE IF NOT EXISTS market_snapshots (
      id BIGSERIAL PRIMARY KEY,
      market_id BIGINT NOT NULL REFERENCES markets(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL,
      data_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_markets_status_created_at ON markets(status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bets_user_status ON bets(user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_bets_market ON bets(market_id);
    CREATE INDEX IF NOT EXISTS idx_outcomes_market ON outcomes(market_id);
    CREATE INDEX IF NOT EXISTS idx_market_snapshots_market_created_at ON market_snapshots(market_id, created_at);
  `);

  await db.exec("ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolved_by BIGINT;");
  await db.exec(`
    UPDATE markets
    SET resolved_by = created_by
    WHERE status = 'resolved' AND resolved_by IS NULL;
  `);
}

export async function initSchema() {
  if (db.provider === "postgres") {
    await initPostgresSchema();
    return;
  }

  await initSqliteSchema();
}

