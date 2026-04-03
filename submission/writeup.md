# Submission Write-up

## What was built

A complete prediction market web app with:

- user auth and role system
- market creation and listing
- market detail view with odds and distribution chart
- bet placement with balance checks
- admin-only market resolution and archival
- payout distribution logic
- refund flow during archival when applicable
- profile with active/resolved bets and separate pagination
- leaderboard by total winnings
- near real-time updates via polling
- API key generation/revocation and API key authentication (bonus)

## Architecture decisions

- Chose Bun + Elysia to stay aligned with the original challenge stack.
- Used SQLite through `bun:sqlite` for a zero-infrastructure local setup.
- Kept business logic in backend route handlers with transaction boundaries for critical actions.
- Frontend uses React + Vite with page routes and shared API helper.

## Trade-offs

- Polling (every 5 seconds) was selected over websockets/SSE for simplicity and reviewer friendliness.
- SQLite with explicit SQL was preferred to minimize setup and keep behavior transparent.
- No heavy UI framework was used to keep the codebase lightweight and readable.

## Validation and security

- Passwords are hashed (`Bun.password.hash`).
- Server-side validation for all critical inputs.
- Client-side validation for better UX.
- Admin-only guards for resolve/archive endpoints.
- API keys are stored hashed (`sha256`) and never persisted in plaintext.

## Payout/refund behavior

- Resolution payout formula:
  - `payout = (bet.amount / totalWinningStake) * totalPool`
- If no winners exist at resolve time:
  - market resolves with explicit message
  - refunds can be applied during archive flow
- Archiving active markets refunds active bets.

## Real-time approach

- Frontend polls relevant endpoints every 5 seconds for:
  - dashboard market data
  - profile active bets
  - leaderboard
  - market detail

## Manual smoke tests executed

- login (admin/user)
- create market
- place bets from different users
- resolve market as admin
- archive market
- verify resulting user balance updates

## Incomplete / manual submission asset

- Please add screenshots or a public demo video link in this folder before final submission review.
