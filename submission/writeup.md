# Submission Write-up

## What was built

This submission delivers a complete prediction market application with:

- authentication and role-based access (`user` / `admin`)
- market listing with sorting, filtering, pagination, and live refresh
- market detail pages with odds, outcome distribution, and historical trend chart
- bet placement with validation and balance checks
- admin market resolution and archival flows
- payout distribution and refund handling
- user profile with separate active and resolved bet lists
- leaderboard ranked by total winnings
- bonus API key generation and API-key based access to the same backend API

The app is also deployed online:

- Frontend: `https://marketwebaplication.pages.dev`
- Backend: `https://marketwebaplication.onrender.com`

## Main product choices

- I kept the backend on Bun + Elysia to stay aligned with the provided stack.
- I used a simpler `backend/` + `frontend/` structure instead of the original `server/` + `client/` scaffold because it made the project easier to navigate during implementation.
- I used explicit SQL and transaction boundaries instead of adding a heavier abstraction layer, to keep the business rules transparent and easier to debug.
- For real-time behavior, I chose polling every 5 seconds instead of SSE/WebSockets. This is simpler to review, easier to keep stable, and still satisfies the requirement that updates appear within a few seconds.

## Implemented features by requirement

### 1. Main Dashboard

- Shows active/resolved/archived markets.
- Displays title, description, outcomes, current odds, total pool, and participant count.
- Supports sorting by creation date, total bet size, and number of participants.
- Supports filtering by market status.
- Uses next/previous pagination with 20 items per page.
- Refreshes automatically without page reload.

### 2. User Profile Page

- Shows active bets with current odds and percentages.
- Shows resolved bets with final result and payout/refund values.
- For admins, shows markets resolved by that admin.
- Both lists are paginated separately.

### 3. Market Detail Page

- Displays outcome distribution and implied odds.
- Includes a live-updating historical trend chart built from market snapshots.
- Lets the user choose an outcome and place a bet.
- Validates positive amount input on both client and server.

### 4. Leaderboard

- Ranks users by total winnings in descending order.
- Displays username and winnings.

### 5-8. Roles, Resolution, Payouts, Balances

- Admin users can resolve a market with a winning outcome.
- Admin users can archive a market.
- Active bets are deducted from user balance immediately.
- Winners receive a proportional payout from the market pool.
- Archive flow handles refunds when applicable.
- Users start from a seeded balance and balances remain updated after betting, resolving, and refunding.

### Bonus API

- Users can generate and revoke API keys from their profile.
- API keys are hashed in storage.
- The same REST API can be used by frontend clients or external scripts/bots.

## UX and product improvements added during development

- Success/error toast notifications were added for key actions such as placing bets, creating markets, resolving, archiving, and API key actions.
- Notifications are responsive:
  - on desktop they appear in the bottom-right corner
  - on mobile they appear near the top-center so they do not block the form too aggressively
- Market charts were improved by seeding richer historical betting activity, so the live trend view looks more realistic during demo.
- The market detail page was fixed so changing the selected outcome no longer resets the page scroll position.

## Data model and backend behavior

The backend stores users, sessions, markets, outcomes, bets, transactions, and historical market snapshots.

Important behaviors:

- bets are validated server-side before insertion
- balance updates and payout distribution are wrapped in transactions
- market snapshots are stored after important changes so the trend chart can reconstruct recent history
- payout distribution uses proportional allocation based on each winning bet's share of the total winning stake

## Validation and security

Implemented protections include:

- password hashing with `Bun.password.hash`
- server-side validation for market creation, bet placement, and admin actions
- client-side validation for faster UX feedback
- admin-only guards for privileged endpoints
- hashed API keys (`sha256`)
- API rate limiting
- stricter login throttling with a 10-minute account/IP window
- basic security response headers

I also reviewed the SQL usage. Queries are parameterized throughout the backend, and the only dynamic sorting area is restricted through a whitelist mapping rather than raw user input.

## Deployment and demo readiness

- Local development supports SQLite for simple startup.
- Online deployment uses Render for the backend, Cloudflare Pages for the frontend, and Neon Postgres for the production database.
- Production seed data was also populated so the live demo has realistic markets, bets, and chart history.

## Issues encountered and resolutions

- Neon/Postgres authentication issue:
  - Symptom: `register` worked but `login` returned `401 Invalid credentials`
  - Cause: camelCase SQL aliases did not behave as expected across Postgres reads
  - Fix: switched auth reads to snake_case database fields and added explicit mapping

- Market detail UX regression:
  - Symptom: changing the selected outcome triggered a visible reset/reload feel
  - Cause: the data loader depended on selection state
  - Fix: loader dependencies were reduced so selection changes no longer retrigger the full page load

- Demo realism:
  - Early graphs were too flat because markets had very little historic betting activity
  - Fix: seed logic was expanded to create more varied bets over different timestamps and persist market snapshots

## Manual smoke tests executed

- login as normal user and admin
- create market
- add custom outcomes
- place valid and invalid bets
- verify insufficient balance handling
- resolve market as admin
- archive market and confirm refund behavior
- verify profile lists and leaderboard refresh
- generate and revoke API key
- verify live deployment and production seeding

## Remaining manual submission step

- Add screenshots or a public demo video link to the `submission/` folder before final submission.
