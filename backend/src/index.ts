import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { db, initSchema, nowIso, withTransaction } from "./db";
import {
  clearSession,
  createSessionAsync,
  generateApiKey,
  getSessionTokenFromContext,
  hashApiKey,
  hashPassword,
  isAuthError,
  requireAdmin,
  requireUser,
  verifyPassword,
} from "./auth";
import {
  calculateOutcomeStats,
  centsToDollars,
  dollarsToCents,
  paginatedResponse,
  parsePagination,
  parsePositiveNumber,
} from "./utils";

type MarketRow = {
  id: number;
  title: string;
  description: string | null;
  status: "active" | "resolved" | "archived";
  createdBy: number;
  winningOutcomeId: number | null;
  totalPool: number;
  participantCount: number;
  createdAt: string;
  resolvedAt: string | null;
  archivedAt: string | null;
};

type OutcomeRow = {
  id: number;
  marketId: number;
  label: string;
  totalAmountStaked: number;
};

async function getOutcomesForMarket(marketId: number) {
  return (await db
    .query(
      `SELECT id, market_id as marketId, label, total_amount_staked as totalAmountStaked
       FROM outcomes
       WHERE market_id = ?
       ORDER BY id ASC`
    )
    .all(marketId)) as OutcomeRow[];
}

async function marketWithComputedFields(market: MarketRow) {
  const outcomes = await getOutcomesForMarket(market.id);
  const totalPool = Number(market.totalPool || 0);

  const mappedOutcomes = outcomes.map((outcome) => ({
    id: outcome.id,
    label: outcome.label,
    ...calculateOutcomeStats(Number(outcome.totalAmountStaked || 0), totalPool),
  }));

  return {
    id: market.id,
    title: market.title,
    description: market.description,
    status: market.status,
    createdBy: market.createdBy,
    winningOutcomeId: market.winningOutcomeId,
    totalPool,
    participantCount: market.participantCount,
    createdAt: market.createdAt,
    resolvedAt: market.resolvedAt,
    archivedAt: market.archivedAt,
    outcomes: mappedOutcomes,
  };
}

async function getMarketById(marketId: number) {
  const market = (await db
    .query(
      `SELECT id, title, description, status, created_by as createdBy, winning_outcome_id as winningOutcomeId,
              total_pool as totalPool, participant_count as participantCount, created_at as createdAt,
              resolved_at as resolvedAt, archived_at as archivedAt
       FROM markets
       WHERE id = ?`
    )
    .get(marketId)) as MarketRow | null;

  if (!market) {
    return null;
  }

  return marketWithComputedFields(market);
}

async function createMarketSnapshot(marketId: number, createdAt = nowIso()) {
  const market = await getMarketById(marketId);
  if (!market) return;

  const snapshotPayload = {
    totalPool: market.totalPool,
    status: market.status,
    outcomes: market.outcomes.map((outcome) => ({
      id: outcome.id,
      label: outcome.label,
      percentage: outcome.percentage,
      odds: outcome.odds,
      stake: outcome.stake,
    })),
  };

  await db.query("INSERT INTO market_snapshots (market_id, created_at, data_json) VALUES (?, ?, ?)").run(
    marketId,
    createdAt,
    JSON.stringify(snapshotPayload)
  );
}

async function ensureHistoryBootstrapped() {
  const marketRows = (await db.query("SELECT id FROM markets").all()) as Array<{ id: number }>;
  for (const row of marketRows) {
    const count = (await db
      .query("SELECT COUNT(*) as total FROM market_snapshots WHERE market_id = ?")
      .get(row.id)) as { total: number };
    if (!count || Number(count.total) === 0) {
      await createMarketSnapshot(row.id);
    }
  }
}

const SESSION_COOKIE_NAME = "pm_session";
const RATE_LIMIT_WINDOW_MS = 10 * 60 * 1000;
const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

function setSessionCookie(set: { headers?: Record<string, string> }, token: string, expiresAt: string) {
  const maxAgeSeconds = Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now()) / 1000));
  set.headers = set.headers || {};
  set.headers["Set-Cookie"] =
    `${SESSION_COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function clearSessionCookie(set: { headers?: Record<string, string> }) {
  set.headers = set.headers || {};
  set.headers["Set-Cookie"] =
    `${SESSION_COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

function consumeRateLimit(request: Request, keyPrefix: string, limit: number) {
  const now = Date.now();
  const forwardedIp = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwardedIp || "local";
  const key = `${keyPrefix}:${ip}`;

  const entry = rateLimitStore.get(key);
  if (!entry || entry.resetAt <= now) {
    rateLimitStore.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (entry.count >= limit) {
    return false;
  }

  entry.count += 1;
  rateLimitStore.set(key, entry);
  return true;
}

async function insertAndGetId(sqlText: string, ...params: unknown[]) {
  if (db.provider === "postgres") {
    const queryWithReturning = sqlText.includes("RETURNING")
      ? sqlText
      : `${sqlText} RETURNING id`;
    const inserted = (await db.query(queryWithReturning).get(...params)) as { id: number } | null;
    if (!inserted) {
      throw new Error("Could not fetch inserted id");
    }
    return Number(inserted.id);
  }

  const result = await db.query(sqlText).run(...params);
  return Number(result.lastInsertRowid);
}

async function findUserByUsernameOrEmail(username: string, email: string | null) {
  if (email) {
    return (await db
      .query("SELECT id FROM users WHERE username = ? OR email = ?")
      .get(username, email)) as { id: number } | null;
  }

  return (await db.query("SELECT id FROM users WHERE username = ?").get(username)) as { id: number } | null;
}

await initSchema();
await ensureHistoryBootstrapped();

const app = new Elysia()
  .use(
    cors({
      origin: true,
      credentials: true,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-API-Key"],
    })
  )
  .get("/health", () => ({ ok: true }))
  .post("/auth/register", async ({ body, set, request }) => {
    if (!consumeRateLimit(request, "auth:register", 20)) {
      set.status = 429;
      return { error: "Too many registration attempts. Please try again later." };
    }

    const payload = (body ?? {}) as { username?: string; email?: string; password?: string };
    const username = payload.username?.trim();
    const email = payload.email?.trim() || null;
    const password = payload.password || "";

    if (!username || username.length < 3) {
      set.status = 400;
      return { error: "Username must be at least 3 characters" };
    }

    if (password.length < 6) {
      set.status = 400;
      return { error: "Password must be at least 6 characters" };
    }

    const existing = await findUserByUsernameOrEmail(username, email);

    if (existing) {
      set.status = 409;
      return { error: "User already exists" };
    }

    const passwordHash = await hashPassword(password);
    const createdAt = nowIso();

    const userId = await insertAndGetId(
      "INSERT INTO users (username, email, password_hash, role, balance, created_at) VALUES (?, ?, ?, 'user', 1000, ?)",
      username,
      email,
      passwordHash,
      createdAt
    );

    await db.query(
      "INSERT INTO transactions (user_id, type, amount, created_at, meta) VALUES (?, 'initial_balance', ?, ?, ?)"
    ).run(userId, 1000, createdAt, "{\"source\":\"register\"}");

    const session = await createSessionAsync(userId);
    setSessionCookie(set, session.token, session.expiresAt);

    return {
      token: session.token,
      user: {
        id: userId,
        username,
        email,
        role: "user",
        balance: 1000,
        totalWinnings: 0,
        createdAt,
      },
    };
  })
  .post("/auth/login", async ({ body, set, request }) => {
    if (!consumeRateLimit(request, "auth:login", 40)) {
      set.status = 429;
      return { error: "Too many login attempts. Please try again later." };
    }

    const payload = (body ?? {}) as { username?: string; password?: string };
    const username = payload.username?.trim();
    const password = payload.password || "";

    if (!username || !password) {
      set.status = 400;
      return { error: "Username and password are required" };
    }

    const user = (await db
      .query(
        `SELECT id, username, email, password_hash as passwordHash, role, balance,
                total_winnings as totalWinnings, created_at as createdAt
         FROM users
         WHERE username = ?`
      )
      .get(username)) as
      | {
          id: number;
          username: string;
          email: string | null;
          passwordHash: string;
          role: "user" | "admin";
          balance: number;
          totalWinnings: number;
          createdAt: string;
        }
      | null;

    if (!user) {
      set.status = 401;
      return { error: "Invalid credentials" };
    }

    const isValid = await verifyPassword(password, user.passwordHash);
    if (!isValid) {
      set.status = 401;
      return { error: "Invalid credentials" };
    }

    const session = await createSessionAsync(user.id);
    setSessionCookie(set, session.token, session.expiresAt);

    return {
      token: session.token,
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        role: user.role,
        balance: user.balance,
        totalWinnings: user.totalWinnings,
        createdAt: user.createdAt,
      },
    };
  })
  .post("/auth/logout", async ({ request, set }) => {
    const sessionToken = getSessionTokenFromContext({ request });
    if (sessionToken) {
      await clearSession(sessionToken);
    }

    clearSessionCookie(set);
    return { success: true };
  })
  .post("/admin/users", async ({ body, request, set }) => {
    const authResult = await requireAdmin({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    const payload = (body ?? {}) as { username?: string; email?: string; password?: string; role?: string };
    const username = payload.username?.trim();
    const email = payload.email?.trim() || null;
    const password = payload.password || "";
    const role = payload.role === "admin" ? "admin" : "user";

    if (!username || username.length < 3) {
      set.status = 400;
      return { error: "Username must be at least 3 characters" };
    }

    if (password.length < 6) {
      set.status = 400;
      return { error: "Password must be at least 6 characters" };
    }

    const existing = await findUserByUsernameOrEmail(username, email);

    if (existing) {
      set.status = 409;
      return { error: "User already exists" };
    }

    const passwordHash = await hashPassword(password);
    const createdAt = nowIso();
    const initialBalance = 1000;

    const userId = await insertAndGetId(
      "INSERT INTO users (username, email, password_hash, role, balance, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      username,
      email,
      passwordHash,
      role,
      initialBalance,
      createdAt
    );

    await db.query(
      "INSERT INTO transactions (user_id, type, amount, created_at, meta) VALUES (?, 'initial_balance', ?, ?, ?)"
    ).run(userId, initialBalance, createdAt, `{"source":"admin_create","createdBy":${authResult.id}}`);

    set.status = 201;
    return {
      user: {
        id: userId,
        username,
        email,
        role,
        balance: initialBalance,
        totalWinnings: 0,
        createdAt,
      },
    };
  })
  .get("/me", async ({ request, set }) => {
    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    return { user: authResult };
  })
  .post("/me/api-key", async ({ request, set }) => {
    if (!consumeRateLimit(request, "api-key:generate", 30)) {
      set.status = 429;
      return { error: "Too many API key requests. Please try again later." };
    }

    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    const rawApiKey = generateApiKey();
    const hash = hashApiKey(rawApiKey);

    await db.query("UPDATE users SET api_key_hash = ? WHERE id = ?").run(hash, authResult.id);

    return { apiKey: rawApiKey };
  })
  .delete("/me/api-key", async ({ request, set }) => {
    if (!consumeRateLimit(request, "api-key:revoke", 30)) {
      set.status = 429;
      return { error: "Too many API key requests. Please try again later." };
    }

    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    await db.query("UPDATE users SET api_key_hash = NULL WHERE id = ?").run(authResult.id);

    return { success: true };
  })
  .get("/me/bets/active", async ({ request, set }) => {
    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    const url = new URL(request.url);
    const { page, limit, offset } = parsePagination(url.searchParams);

    const totalCountRow = (await db
      .query("SELECT COUNT(*) as total FROM bets WHERE user_id = ? AND status = 'active'")
      .get(authResult.id)) as { total: number };

    const rows = (await db
      .query(
        `SELECT b.id, b.amount, b.created_at as createdAt,
                m.id as marketId, m.title as marketTitle, m.status as marketStatus,
                o.id as outcomeId, o.label as outcomeLabel,
                m.total_pool as totalPool, o.total_amount_staked as outcomeStake
         FROM bets b
         JOIN markets m ON m.id = b.market_id
         JOIN outcomes o ON o.id = b.outcome_id
         WHERE b.user_id = ? AND b.status = 'active'
         ORDER BY b.created_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(authResult.id, limit, offset)) as Array<{
      id: number;
      amount: number;
      createdAt: string;
      marketId: number;
      marketTitle: string;
      marketStatus: string;
      outcomeId: number;
      outcomeLabel: string;
      totalPool: number;
      outcomeStake: number;
    }>;

    const items = rows.map((row) => ({
      id: row.id,
      amount: row.amount,
      createdAt: row.createdAt,
      market: {
        id: row.marketId,
        title: row.marketTitle,
        status: row.marketStatus,
      },
      outcome: {
        id: row.outcomeId,
        label: row.outcomeLabel,
      },
      odds: calculateOutcomeStats(row.outcomeStake, row.totalPool).odds,
      percentage: calculateOutcomeStats(row.outcomeStake, row.totalPool).percentage,
    }));

    return paginatedResponse(items, page, limit, Number(totalCountRow.total || 0));
  })
  .get("/me/bets/resolved", async ({ request, set }) => {
    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    const url = new URL(request.url);
    const { page, limit, offset } = parsePagination(url.searchParams);

    const totalCountRow = (await db
      .query("SELECT COUNT(*) as total FROM bets WHERE user_id = ? AND status IN ('won', 'lost', 'refunded')")
      .get(authResult.id)) as { total: number };

    const rows = (await db
      .query(
        `SELECT b.id, b.amount, b.status, b.payout_amount as payoutAmount, b.refunded_amount as refundedAmount,
                b.created_at as createdAt, b.resolved_at as resolvedAt,
                m.id as marketId, m.title as marketTitle,
                o.id as outcomeId, o.label as outcomeLabel
         FROM bets b
         JOIN markets m ON m.id = b.market_id
         JOIN outcomes o ON o.id = b.outcome_id
         WHERE b.user_id = ? AND b.status IN ('won', 'lost', 'refunded')
         ORDER BY COALESCE(b.resolved_at, b.created_at) DESC
         LIMIT ? OFFSET ?`
      )
      .all(authResult.id, limit, offset)) as Array<{
      id: number;
      amount: number;
      status: "won" | "lost" | "refunded";
      payoutAmount: number;
      refundedAmount: number;
      createdAt: string;
      resolvedAt: string | null;
      marketId: number;
      marketTitle: string;
      outcomeId: number;
      outcomeLabel: string;
    }>;

    const items = rows.map((row) => ({
      id: row.id,
      amount: row.amount,
      status: row.status,
      won: row.status === "won",
      payoutAmount: row.payoutAmount,
      refundedAmount: row.refundedAmount,
      createdAt: row.createdAt,
      resolvedAt: row.resolvedAt,
      market: {
        id: row.marketId,
        title: row.marketTitle,
      },
      outcome: {
        id: row.outcomeId,
        label: row.outcomeLabel,
      },
    }));

    return paginatedResponse(items, page, limit, Number(totalCountRow.total || 0));
  })
  .get("/me/markets/resolved-by-me", async ({ request, set }) => {
    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    if (authResult.role !== "admin") {
      set.status = 403;
      return { error: "Admin access required" };
    }

    const url = new URL(request.url);
    const { page, limit, offset } = parsePagination(url.searchParams);

    const totalCountRow = (await db
      .query("SELECT COUNT(*) as total FROM markets WHERE status = 'resolved' AND resolved_by = ?")
      .get(authResult.id)) as { total: number };

    const rows = (await db
      .query(
        `SELECT m.id as marketId, m.title as marketTitle, m.resolved_at as resolvedAt, m.total_pool as totalPool,
                o.id as winningOutcomeId, o.label as winningOutcomeLabel
         FROM markets m
         LEFT JOIN outcomes o ON o.id = m.winning_outcome_id
         WHERE m.status = 'resolved' AND m.resolved_by = ?
         ORDER BY m.resolved_at DESC
         LIMIT ? OFFSET ?`
      )
      .all(authResult.id, limit, offset)) as Array<{
      marketId: number;
      marketTitle: string;
      resolvedAt: string | null;
      totalPool: number;
      winningOutcomeId: number | null;
      winningOutcomeLabel: string | null;
    }>;

    const items = rows.map((row) => ({
      marketId: row.marketId,
      marketTitle: row.marketTitle,
      resolvedAt: row.resolvedAt,
      totalPool: row.totalPool,
      winningOutcome: row.winningOutcomeId
        ? {
            id: row.winningOutcomeId,
            label: row.winningOutcomeLabel,
          }
        : null,
    }));

    return paginatedResponse(items, page, limit, Number(totalCountRow.total || 0));
  })
  .get("/markets", async ({ request, set }) => {
    const url = new URL(request.url);
    const { page, limit, offset } = parsePagination(url.searchParams);
    const status = (url.searchParams.get("status") || "all").toLowerCase();
    const sort = (url.searchParams.get("sort") || "createdAt").trim();
    const order = (url.searchParams.get("order") || "desc").toLowerCase() === "asc" ? "ASC" : "DESC";

    const sortMap: Record<string, string> = {
      createdAt: "created_at",
      totalBetSize: "total_pool",
      participantCount: "participant_count",
    };

    const sortColumn = sortMap[sort] || sortMap.createdAt;

    const whereStatus = status === "all" ? null : status;
    if (whereStatus && !["active", "resolved", "archived"].includes(whereStatus)) {
      set.status = 400;
      return { error: "Invalid status filter" };
    }

    const countRow = whereStatus
      ? ((await db.query("SELECT COUNT(*) as total FROM markets WHERE status = ?").get(whereStatus)) as {
          total: number;
        })
      : ((await db.query("SELECT COUNT(*) as total FROM markets").get()) as { total: number });

    const querySql = whereStatus
      ? `SELECT id, title, description, status, created_by as createdBy, winning_outcome_id as winningOutcomeId,
                total_pool as totalPool, participant_count as participantCount, created_at as createdAt,
                resolved_at as resolvedAt, archived_at as archivedAt
         FROM markets
         WHERE status = ?
         ORDER BY ${sortColumn} ${order}, id DESC
         LIMIT ? OFFSET ?`
      : `SELECT id, title, description, status, created_by as createdBy, winning_outcome_id as winningOutcomeId,
                total_pool as totalPool, participant_count as participantCount, created_at as createdAt,
                resolved_at as resolvedAt, archived_at as archivedAt
         FROM markets
         ORDER BY ${sortColumn} ${order}, id DESC
         LIMIT ? OFFSET ?`;

    const rows = ((whereStatus
      ? await db.query(querySql).all(whereStatus, limit, offset)
      : await db.query(querySql).all(limit, offset)) as MarketRow[]) || [];

    const items = await Promise.all(rows.map((market) => marketWithComputedFields(market)));

    return paginatedResponse(items, page, limit, Number(countRow.total || 0));
  })
  .post("/markets", async ({ body, request, set }) => {
    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }
    if (authResult.role === "admin") {
      set.status = 403;
      return { error: "Admins cannot create bets" };
    }

    const payload = (body ?? {}) as { title?: string; description?: string; outcomes?: unknown[] };
    const title = payload.title?.trim();
    const description = payload.description?.trim() || null;
    const outcomes = (payload.outcomes || [])
      .map((value) => String(value).trim())
      .filter((value, index, array) => value.length > 0 && array.indexOf(value) === index);

    if (!title || title.length < 3) {
      set.status = 400;
      return { error: "Market title must be at least 3 characters" };
    }

    if (outcomes.length < 2) {
      set.status = 400;
      return { error: "Market requires at least 2 outcomes" };
    }

    const createdAt = nowIso();

    const result = await withTransaction(async () => {
      const marketId = await insertAndGetId(
        "INSERT INTO markets (title, description, status, created_by, created_at) VALUES (?, ?, 'active', ?, ?)",
        title,
        description,
        authResult.id,
        createdAt
      );
      for (const label of outcomes) {
        await db
          .query("INSERT INTO outcomes (market_id, label, total_amount_staked) VALUES (?, ?, 0)")
          .run(marketId, label);
      }

      return marketId;
    });

    await createMarketSnapshot(result);

    set.status = 201;
    return { market: await getMarketById(result) };
  })
  .get("/markets/:marketId", async ({ params, set }) => {
    const marketId = Number(params.marketId);
    if (!Number.isInteger(marketId) || marketId <= 0) {
      set.status = 400;
      return { error: "Invalid market id" };
    }

    const market = await getMarketById(marketId);
    if (!market) {
      set.status = 404;
      return { error: "Market not found" };
    }

    return { market };
  })
  .get("/markets/:marketId/history", async ({ params, request, set }) => {
    const marketId = Number(params.marketId);
    if (!Number.isInteger(marketId) || marketId <= 0) {
      set.status = 400;
      return { error: "Invalid market id" };
    }

    const market = await getMarketById(marketId);
    if (!market) {
      set.status = 404;
      return { error: "Market not found" };
    }

    const url = new URL(request.url);
    const range = (url.searchParams.get("range") || "6h") as "15m" | "1h" | "6h" | "1d" | "1w";
    const rangeMap: Record<string, number> = {
      "15m": 15 * 60 * 1000,
      "1h": 60 * 60 * 1000,
      "6h": 6 * 60 * 60 * 1000,
      "1d": 24 * 60 * 60 * 1000,
      "1w": 7 * 24 * 60 * 60 * 1000,
    };
    const duration = rangeMap[range] ?? rangeMap["6h"];
    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - duration);

    const before = (await db
      .query(
        `SELECT created_at as createdAt, data_json as dataJson
         FROM market_snapshots
         WHERE market_id = ? AND created_at < ?
         ORDER BY created_at DESC
         LIMIT 1`
      )
      .get(marketId, fromDate.toISOString())) as { createdAt: string; dataJson: string } | null;

    const rows = (await db
      .query(
        `SELECT created_at as createdAt, data_json as dataJson
         FROM market_snapshots
         WHERE market_id = ? AND created_at >= ? AND created_at <= ?
         ORDER BY created_at ASC`
      )
      .all(marketId, fromDate.toISOString(), toDate.toISOString())) as Array<{
      createdAt: string;
      dataJson: string;
    }>;

    const combinedRows = before ? [before, ...rows] : rows;

    const snapshots = combinedRows.map((row) => ({
      createdAt: row.createdAt,
      ...(JSON.parse(row.dataJson) as {
        totalPool: number;
        status: string;
        outcomes: Array<{ id: number; label: string; percentage: number; odds: number | null; stake: number }>;
      }),
    }));

    return {
      range,
      from: fromDate.toISOString(),
      to: toDate.toISOString(),
      snapshots,
    };
  })
  .post("/markets/:marketId/bets", async ({ params, body, request, set }) => {
    const authResult = await requireUser({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }
    if (authResult.role === "admin") {
      set.status = 403;
      return { error: "Admins cannot place bets" };
    }

    const marketId = Number(params.marketId);
    const payload = (body ?? {}) as { outcomeId?: number; amount?: number };
    const outcomeId = Number(payload.outcomeId);
    const amount = parsePositiveNumber(payload.amount);
    const amountCents = amount !== null ? dollarsToCents(amount) : null;

    if (!Number.isInteger(marketId) || marketId <= 0) {
      set.status = 400;
      return { error: "Invalid market id" };
    }

    if (!Number.isInteger(outcomeId) || outcomeId <= 0) {
      set.status = 400;
      return { error: "Invalid outcome id" };
    }

    if (!amount || !amountCents || amountCents <= 0) {
      set.status = 400;
      return { error: "Bet amount must be a positive number" };
    }

    try {
      const result = await withTransaction(async () => {
        const market = (await db
          .query("SELECT id, status FROM markets WHERE id = ?")
          .get(marketId)) as { id: number; status: string } | null;

        if (!market) {
          throw new Error("Market not found");
        }

        if (market.status !== "active") {
          throw new Error("Bets can only be placed on active markets");
        }

        const outcome = (await db
          .query("SELECT id FROM outcomes WHERE id = ? AND market_id = ?")
          .get(outcomeId, marketId)) as { id: number } | null;

        if (!outcome) {
          throw new Error("Outcome does not belong to this market");
        }

        const currentUser = (await db
          .query("SELECT balance FROM users WHERE id = ?")
          .get(authResult.id)) as { balance: number } | null;

        const currentBalanceCents = currentUser ? dollarsToCents(currentUser.balance) : 0;
        if (!currentUser || currentBalanceCents < amountCents) {
          throw new Error("Insufficient balance");
        }

        const hadParticipation = (await db
          .query("SELECT 1 as value FROM bets WHERE user_id = ? AND market_id = ? LIMIT 1")
          .get(authResult.id, marketId)) as { value: number } | null;

        const updatedBalance = centsToDollars(currentBalanceCents - amountCents);
        await db.query("UPDATE users SET balance = ? WHERE id = ?").run(updatedBalance, authResult.id);

        const createdAt = nowIso();
        const betId = await insertAndGetId(
          "INSERT INTO bets (user_id, market_id, outcome_id, amount, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
          authResult.id,
          marketId,
          outcomeId,
          centsToDollars(amountCents),
          createdAt
        );

        await db.query("UPDATE outcomes SET total_amount_staked = total_amount_staked + ? WHERE id = ?").run(
          centsToDollars(amountCents),
          outcomeId
        );

        await db.query(
          `UPDATE markets
           SET total_pool = total_pool + ?,
               participant_count = participant_count + ?
           WHERE id = ?`
        ).run(centsToDollars(amountCents), hadParticipation ? 0 : 1, marketId);

        await db.query(
          "INSERT INTO transactions (user_id, type, amount, market_id, bet_id, created_at, meta) VALUES (?, 'bet_placed', ?, ?, ?, ?, ?)"
        ).run(authResult.id, -centsToDollars(amountCents), marketId, betId, createdAt, "{\"reason\":\"bet placed\"}");

        return { betId, createdAt };
      });

      await createMarketSnapshot(marketId, result.createdAt);

      return {
        success: true,
        betId: result.betId,
        market: await getMarketById(marketId),
      };
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Could not place bet" };
    }
  })
  .get("/leaderboard", async () => {
    const rows = (await db
      .query(
        `SELECT id, username, total_winnings as totalWinnings
         FROM users
         WHERE role = 'user'
         ORDER BY total_winnings DESC, username ASC`
      )
      .all()) as Array<{ id: number; username: string; totalWinnings: number }>;

    return {
      items: rows,
    };
  })
  .post("/admin/markets/:marketId/resolve", async ({ params, body, request, set }) => {
    const authResult = await requireAdmin({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    const marketId = Number(params.marketId);
    const payload = (body ?? {}) as { winningOutcomeId?: number };
    const winningOutcomeId = Number(payload.winningOutcomeId);

    if (!Number.isInteger(marketId) || marketId <= 0 || !Number.isInteger(winningOutcomeId) || winningOutcomeId <= 0) {
      set.status = 400;
      return { error: "Invalid market or outcome id" };
    }

    try {
      const response = await withTransaction(async () => {
        const market = (await db
          .query(
            "SELECT id, status, total_pool as totalPool, payout_distributed as payoutDistributed FROM markets WHERE id = ?"
          )
          .get(marketId)) as {
          id: number;
          status: string;
          totalPool: number;
          payoutDistributed: number | boolean;
        } | null;

        if (!market) {
          throw new Error("Market not found");
        }

        if (market.status !== "active") {
          throw new Error("Only active markets can be resolved");
        }

        const outcome = (await db
          .query("SELECT id FROM outcomes WHERE id = ? AND market_id = ?")
          .get(winningOutcomeId, marketId)) as { id: number } | null;

        if (!outcome) {
          throw new Error("Winning outcome does not belong to this market");
        }

        const bets = (await db
          .query(
            `SELECT id, user_id as userId, amount, outcome_id as outcomeId
             FROM bets
             WHERE market_id = ? AND status = 'active'`
          )
          .all(marketId)) as Array<{ id: number; userId: number; amount: number; outcomeId: number }>;

        const totalPoolCents = dollarsToCents(Number(market.totalPool || 0));
        const winners = bets
          .filter((bet) => bet.outcomeId === winningOutcomeId)
          .map((bet) => ({ ...bet, amountCents: dollarsToCents(bet.amount) }));
        const losers = bets.filter((bet) => bet.outcomeId !== winningOutcomeId);
        const totalWinningStakeCents = winners.reduce((acc, bet) => acc + bet.amountCents, 0);
        const resolvedAt = nowIso();

        await db.query(
          `UPDATE markets
           SET status = 'resolved', winning_outcome_id = ?, resolved_at = ?, resolved_by = ?
           WHERE id = ?`
        ).run(winningOutcomeId, resolvedAt, authResult.id, marketId);

        if (totalWinningStakeCents > 0 && !market.payoutDistributed) {
          const rawShares = winners.map((winner) => {
            const numerator = winner.amountCents * totalPoolCents;
            const payoutCents = Math.floor(numerator / totalWinningStakeCents);
            const remainder = numerator % totalWinningStakeCents;
            return { winner, payoutCents, remainder };
          });

          let distributed = rawShares.reduce((sum, item) => sum + item.payoutCents, 0);
          let remaining = totalPoolCents - distributed;
          rawShares.sort((a, b) => (b.remainder === a.remainder ? a.winner.id - b.winner.id : b.remainder - a.remainder));
          for (let i = 0; i < rawShares.length && remaining > 0; i += 1, remaining -= 1) {
            rawShares[i].payoutCents += 1;
          }
          distributed = rawShares.reduce((sum, item) => sum + item.payoutCents, 0);

          for (const { winner, payoutCents } of rawShares) {
            const user = (await db
              .query("SELECT balance, total_winnings as totalWinnings FROM users WHERE id = ?")
              .get(winner.userId)) as { balance: number; totalWinnings: number } | null;

            if (!user) {
              throw new Error("Winner user not found");
            }

            const nextBalance = centsToDollars(dollarsToCents(user.balance) + payoutCents);
            const netWinningsCents = Math.max(0, payoutCents - winner.amountCents);
            const nextTotalWinnings = centsToDollars(dollarsToCents(user.totalWinnings) + netWinningsCents);

            await db.query("UPDATE users SET balance = ?, total_winnings = ? WHERE id = ?").run(
              nextBalance,
              nextTotalWinnings,
              winner.userId
            );

            await db.query("UPDATE bets SET status = 'won', payout_amount = ?, resolved_at = ? WHERE id = ?").run(
              centsToDollars(payoutCents),
              resolvedAt,
              winner.id
            );

            await db.query(
              "INSERT INTO transactions (user_id, type, amount, market_id, bet_id, created_at, meta) VALUES (?, 'payout', ?, ?, ?, ?, ?)"
            ).run(
              winner.userId,
              centsToDollars(payoutCents),
              marketId,
              winner.id,
              resolvedAt,
              `{"reason":"market resolved","totalPayoutDistributed":"${centsToDollars(distributed)}"}`
            );
          }
        }

        for (const loser of losers) {
          await db.query("UPDATE bets SET status = 'lost', resolved_at = ? WHERE id = ?").run(resolvedAt, loser.id);
        }

        if (totalWinningStakeCents === 0) {
          for (const noWinnerBet of winners) {
            await db.query("UPDATE bets SET status = 'lost', resolved_at = ? WHERE id = ?").run(resolvedAt, noWinnerBet.id);
          }
        }

        await db.query("UPDATE markets SET payout_distributed = 1 WHERE id = ?").run(marketId);

        return {
          message:
            totalWinningStakeCents > 0
              ? "Market resolved and payouts distributed"
              : "Market resolved with no winners. Pool remains until archive refunds are processed.",
          totalPool: centsToDollars(totalPoolCents),
          totalWinningStake: centsToDollars(totalWinningStakeCents),
          winnerCount: winners.length,
        };
      });

      await createMarketSnapshot(marketId);

      return {
        ...response,
        market: await getMarketById(marketId),
      };
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Could not resolve market" };
    }
  })
  .post("/admin/markets/:marketId/archive", async ({ params, request, set }) => {
    const authResult = await requireAdmin({ request, set });
    if (isAuthError(authResult)) {
      return authResult;
    }

    const marketId = Number(params.marketId);

    if (!Number.isInteger(marketId) || marketId <= 0) {
      set.status = 400;
      return { error: "Invalid market id" };
    }

    try {
      const result = await withTransaction(async () => {
        const market = (await db
          .query(
            `SELECT id, status, winning_outcome_id as winningOutcomeId,
                    archived_at as archivedAt, refund_distributed as refundDistributed
             FROM markets
             WHERE id = ?`
          )
          .get(marketId)) as {
          id: number;
          status: "active" | "resolved" | "archived";
          winningOutcomeId: number | null;
          archivedAt: string | null;
          refundDistributed: number | boolean;
        } | null;

        if (!market) {
          throw new Error("Market not found");
        }

        if (market.status === "archived") {
          throw new Error("Market is already archived");
        }

        const shouldRefundActive = market.status === "active";
        const shouldRefundResolvedNoWinners =
          market.status === "resolved" &&
          market.winningOutcomeId !== null &&
          ((await db
            .query("SELECT COUNT(*) as total FROM bets WHERE market_id = ? AND status = 'won'")
            .get(marketId)) as { total: number }).total === 0;

        let refundableBets: Array<{ id: number; userId: number; amount: number }> = [];

        if (shouldRefundActive && !market.refundDistributed) {
          refundableBets = (await db
            .query("SELECT id, user_id as userId, amount FROM bets WHERE market_id = ? AND status = 'active'")
            .all(marketId)) as Array<{ id: number; userId: number; amount: number }>;
        }

        if (shouldRefundResolvedNoWinners && !market.refundDistributed) {
          refundableBets = (await db
            .query("SELECT id, user_id as userId, amount FROM bets WHERE market_id = ? AND status = 'lost'")
            .all(marketId)) as Array<{ id: number; userId: number; amount: number }>;
        }

        const archivedAt = nowIso();

        if (refundableBets.length > 0) {
          for (const bet of refundableBets) {
            const user = (await db.query("SELECT balance FROM users WHERE id = ?").get(bet.userId)) as {
              balance: number;
            } | null;
            if (!user) {
              throw new Error("User not found for refund");
            }
            const nextBalance = centsToDollars(dollarsToCents(user.balance) + dollarsToCents(bet.amount));
            await db.query("UPDATE users SET balance = ? WHERE id = ?").run(nextBalance, bet.userId);
            await db.query("UPDATE bets SET status = 'refunded', refunded_amount = ?, resolved_at = ? WHERE id = ?").run(
              centsToDollars(dollarsToCents(bet.amount)),
              archivedAt,
              bet.id
            );
            await db.query(
              "INSERT INTO transactions (user_id, type, amount, market_id, bet_id, created_at, meta) VALUES (?, 'refund', ?, ?, ?, ?, ?)"
            ).run(
              bet.userId,
              centsToDollars(dollarsToCents(bet.amount)),
              marketId,
              bet.id,
              archivedAt,
              "{\"reason\":\"market archived\"}"
            );
          }
        }

        await db.query(
          "UPDATE markets SET status = 'archived', archived_at = ?, refund_distributed = ? WHERE id = ?"
        ).run(archivedAt, refundableBets.length > 0 ? 1 : market.refundDistributed, marketId);

        return {
          refundedBets: refundableBets.length,
          refundedAmount: centsToDollars(
            refundableBets.reduce((sum, bet) => sum + dollarsToCents(bet.amount), 0)
          ),
        };
      });

      await createMarketSnapshot(marketId);

      return {
        message: "Market archived",
        ...result,
        market: await getMarketById(marketId),
      };
    } catch (error) {
      set.status = 400;
      return { error: error instanceof Error ? error.message : "Could not archive market" };
    }
  });

const port = Number(process.env.PORT || 3001);

app.listen(port);
console.log(`Backend API running on http://localhost:${port}`);
