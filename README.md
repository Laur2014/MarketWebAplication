# MarketWebAplication

Prediction market web app for the Vertigo Internship.

## Stack

- Backend: Bun + Elysia + dual DB support (`SQLite` local or `Postgres/Neon` via `DATABASE_URL`)
- Frontend: React + Vite
- Auth: server-side sessions (Bearer token and HttpOnly cookie) + optional API key support

## Features implemented

- Register/login with hashed passwords
- Role system (`user`, `admin`)
- Create market (authenticated)
- Light/dark theme toggle
- Dashboard with:
  - filter by status
  - sort by creation date / total bet size / participants
  - pagination (20/page)
  - near real-time updates via silent polling
- Market detail with:
  - outcome percentage chart
  - odds per outcome
  - live trend chart with 5-second refresh
  - place bet with client + server validation
- User profile with:
  - balance and total winnings
  - active bets (paginated)
  - resolved bets (paginated)
  - admin resolved-markets view
  - near real-time updates for active bets
- Leaderboard by total winnings
- Admin actions:
  - resolve market
  - archive market
  - payout distribution
  - refund behavior for archiving
- Bonus:
  - API key generation/revoke
  - API key authentication via `X-API-Key`
  - success/error toast notifications across key actions

## Setup

1. Install Bun 1.3+ and Node 22+.
2. Install dependencies:

```bash
bun install
```

### Local default (SQLite)

No extra environment variables are required.

3. Seed demo users and sample market:

```bash
bun run seed
```

4. Start both backend and frontend:

```bash
bun run dev
```

- Frontend: `http://localhost:5173`
- Backend: `http://localhost:3001`
Frontend API base URL can be configured with:

```bash
# frontend/.env
VITE_API_BASE_URL=http://localhost:3001
```

### Deploy / Neon (Postgres)

Set these environment variables for backend:

- `DATABASE_URL=<your_neon_connection_string>`
- optional `DB_PROVIDER=postgres` (auto-detected when `DATABASE_URL` exists)
- optional `PG_POOL_MAX=10`

Then run:

```bash
bun run seed
bun run dev:backend
```

## Simple Online Deployment (Free-ish setup)

Recommended split:
- Backend API: Render Web Service
- Frontend: Cloudflare Pages
- Database: Neon Postgres

Current deployed URLs:
- Frontend: `https://marketwebaplication.pages.dev`
- Backend: `https://marketwebaplication.onrender.com`

Environment variables:

Backend (Render):
- `PORT=3001`
- `DATABASE_URL=<my_private_neon_connection_string>`
- optional `DB_PROVIDER=postgres`
- optional `PG_POOL_MAX=10`

Frontend (Cloudflare Pages):
- `VITE_API_BASE_URL=https://<your-render-service>.onrender.com`

### Render quick config (Backend)

- Service type: `Web Service` (Native runtime), **not Docker**
- Root Directory: `backend`
- Build Command: `bun install`
- Start Command: `bun run start`
- Region: same as Neon (recommended: Frankfurt)

If Render Shell is unavailable on free tier, you can seed Neon from local machine:

```powershell
$env:DATABASE_URL="<your_neon_connection_string>"
$env:DB_PROVIDER="postgres"
bun run seed
```

Then trigger a backend redeploy from Render.

### Cloudflare Pages quick config (Frontend)

- Framework preset: `React (Vite)` (or `Vite`)
- Root Directory: `frontend`
- Build Command: `bun run build`
- Build Output Directory: `dist`
- Environment variable:
  - `VITE_API_BASE_URL=https://<your-render-service>.onrender.com`

## Demo accounts

- Admin: `admin / admin123`
- User: `user / user1234`

## Useful scripts

- Backend only: `bun run dev:backend`
- Frontend only: `bun run dev:frontend`
- Reseed data: `bun run seed`

## API overview

### Auth / User

- Protected endpoints can be called with a Bearer token after login.
- Bonus support: API clients can also authenticate with `X-API-Key` where applicable.
- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`
- `GET /me/bets/active?page=1&limit=20`
- `GET /me/bets/resolved?page=1&limit=20`
- `GET /me/markets/resolved-by-me?page=1&limit=20` (admin only)
- `POST /me/api-key`
- `DELETE /me/api-key`

### Markets

- `GET /markets?page=1&limit=20&status=active&sort=createdAt&order=desc`
- `POST /markets`
- `GET /markets/:marketId`
- `POST /markets/:marketId/bets`

### Admin

- `POST /admin/users` (admin can create `user` or `admin` accounts)
- `POST /admin/markets/:marketId/resolve`
- `POST /admin/markets/:marketId/archive`

### Leaderboard

- `GET /leaderboard`

## Notes

- Polling interval for near real-time updates: 5 seconds.
- Dashboard and market detail polling are silent, so the page does not visibly jump during refresh.
- Pagination is capped at 20 items per page.
- Session duration is 14 days from login.
- Local SQLite file is created at `backend/data/market.db`.
- When `DATABASE_URL` is present, backend uses Postgres/Neon instead of local SQLite.
- Market detail includes a live trend chart and client-side bet validation feedback.
- Toast notifications are used for key success/error actions.
- Challenge submission docs are in `submission/`.

## Troubleshooting

- `401 Invalid credentials` right after successful `register` (Postgres/Neon):
  - Cause: Postgres returns unquoted aliases in lowercase; camelCase aliases like `passwordHash` can be read as `undefined` in login checks.
  - Fix implemented: auth queries now use snake_case fields (`password_hash`, `created_at`, `total_winnings`) and explicit mapping to API response shape.
  - Action: redeploy backend after pulling latest commit.
