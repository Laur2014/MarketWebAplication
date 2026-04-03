# MarketWebAplication

Prediction market web app for the Vertigo Internship 2026 challenge.

## Stack

- Backend: Bun + Elysia + SQLite (`bun:sqlite`)
- Frontend: React + Vite
- Auth: server-side sessions (Bearer token and HttpOnly cookie) + optional API key support

## Features implemented

- Register/login with hashed passwords
- Role system (`user`, `admin`)
- Create market (authenticated)
- Dashboard with:
  - filter by status
  - sort by creation date / total bet size / participants
  - pagination (20/page)
  - near real-time updates via polling
- Market detail with:
  - outcome percentage chart
  - odds per outcome
  - place bet with validation
- User profile with:
  - balance and total winnings
  - active bets (paginated)
  - resolved bets (paginated)
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

## Setup

1. Install Bun 1.3+ and Node 22+.
2. Install dependencies:

```bash
bun install
```

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

## Demo accounts

- Admin: `admin / admin123`
- User: `user / user1234`

## Useful scripts

- Backend only: `bun run dev:backend`
- Frontend only: `bun run dev:frontend`
- Reseed data: `bun run seed`

## API overview

### Auth / User

- `POST /auth/register`
- `POST /auth/login`
- `POST /auth/logout`
- `GET /me`
- `GET /me/bets/active?page=1&limit=20`
- `GET /me/bets/resolved?page=1&limit=20`
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
- Pagination is capped at 20 items per page.
- Session duration is 14 days from login.
- Database file is created at `backend/data/market.db`.
- Challenge submission docs are in `submission/`.
