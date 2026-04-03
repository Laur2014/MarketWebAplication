import { createHash, randomBytes } from "node:crypto";
import type { Context } from "elysia";
import { db, nowIso } from "./db";

const SESSION_DAYS = 14;

export type AuthUser = {
  id: number;
  username: string;
  email: string | null;
  role: "user" | "admin";
  balance: number;
  totalWinnings: number;
  createdAt: string;
};

export function hashApiKey(rawKey: string) {
  return createHash("sha256").update(rawKey).digest("hex");
}

export function generateApiKey() {
  return `mk_${randomBytes(24).toString("hex")}`;
}

export async function hashPassword(password: string) {
  return Bun.password.hash(password);
}

export async function verifyPassword(password: string, hash: string) {
  return Bun.password.verify(password, hash);
}

function parseCookies(cookieHeader: string | null) {
  if (!cookieHeader) return {};
  const cookies: Record<string, string> = {};
  for (const pair of cookieHeader.split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");
    if (!rawName) continue;
    cookies[rawName] = decodeURIComponent(rest.join("="));
  }
  return cookies;
}

export function getSessionTokenFromContext(context: Pick<Context, "request">) {
  const authHeader = context.request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice(7);
  }

  const cookies = parseCookies(context.request.headers.get("cookie"));
  return cookies.pm_session || null;
}

export async function createSessionAsync(userId: number) {
  const token = randomBytes(32).toString("hex");
  const createdAt = nowIso();
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 24 * 60 * 60 * 1000).toISOString();

  await db
    .query("INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .run(token, userId, createdAt, expiresAt);

  return { token, createdAt, expiresAt };
}

export async function clearSession(token: string) {
  await db.query("DELETE FROM sessions WHERE token = ?").run(token);
}

export async function authFromContext(context: Pick<Context, "request">) {
  const apiKeyHeader = context.request.headers.get("x-api-key");

  if (apiKeyHeader) {
    const apiKeyHash = hashApiKey(apiKeyHeader);
    const user = (await db
      .query(
        `SELECT id, username, email, role, balance, total_winnings as totalWinnings, created_at as createdAt
         FROM users
         WHERE api_key_hash = ?`
      )
      .get(apiKeyHash)) as AuthUser | null;

    return user;
  }

  const token = getSessionTokenFromContext(context);
  if (!token) {
    return null;
  }
  const session = (await db
    .query(
      `SELECT s.user_id as userId
       FROM sessions s
       WHERE s.token = ? AND s.expires_at > ?`
    )
    .get(token, nowIso())) as { userId: number } | null;

  if (!session) {
    return null;
  }

  const user = (await db
    .query(
      `SELECT id, username, email, role, balance, total_winnings as totalWinnings, created_at as createdAt
       FROM users
       WHERE id = ?`
    )
    .get(session.userId)) as AuthUser | null;

  return user;
}

export async function requireUser(context: Pick<Context, "request" | "set">) {
  const user = await authFromContext(context);

  if (!user) {
    context.set.status = 401;
    return { error: "Authentication required" };
  }

  return user;
}

export async function requireAdmin(context: Pick<Context, "request" | "set">) {
  const user = await authFromContext(context);

  if (!user) {
    context.set.status = 401;
    return { error: "Authentication required" };
  }

  if (user.role !== "admin") {
    context.set.status = 403;
    return { error: "Admin access required" };
  }

  return user;
}

export function isAuthError(value: unknown): value is { error: string } {
  return Boolean(value && typeof value === "object" && "error" in value);
}
