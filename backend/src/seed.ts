import { db, initSchema, nowIso } from "./db";

type SeedUser = {
  username: string;
  email: string;
  password: string;
  role: "user" | "admin";
  balance?: number;
};

type SeedMarket = {
  title: string;
  description: string;
  outcomes: string[];
};

async function ensureUser(params: SeedUser) {
  const existing = (await db.query("SELECT id, role FROM users WHERE username = ?").get(params.username)) as
    | { id: number; role: "user" | "admin" }
    | null;

  if (existing) {
    // Keep demo accounts deterministic across environments by rotating hash to current algorithm.
    const passwordHash = await Bun.password.hash(params.password, {
      algorithm: "bcrypt",
      cost: 10,
    });
    await db
      .query("UPDATE users SET email = ?, password_hash = ?, role = ? WHERE id = ?")
      .run(params.email, passwordHash, params.role, existing.id);
    return existing.id;
  }

  const passwordHash = await Bun.password.hash(params.password);
  const createdAt = nowIso();

  const userId = await insertAndGetId(
    "INSERT INTO users (username, email, password_hash, role, balance, total_winnings, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)",
    params.username,
    params.email,
    passwordHash,
    params.role,
    params.balance ?? 1000,
    createdAt
  );

  await db.query(
    "INSERT INTO transactions (user_id, type, amount, created_at, meta) VALUES (?, 'initial_balance', ?, ?, ?)"
  ).run(userId, params.balance ?? 1000, createdAt, "{\"source\":\"seed\"}");

  return userId;
}

async function raiseExistingBalancesToTarget(targetBalance: number) {
  const users = (await db.query("SELECT id, balance FROM users").all()) as Array<{ id: number; balance: number }>;
  const now = nowIso();

  for (const user of users) {
    const current = Number(user.balance || 0);
    const delta = Number((targetBalance - current).toFixed(2));
    if (Math.abs(delta) < 0.01) continue;

    await db.query("UPDATE users SET balance = ? WHERE id = ?").run(targetBalance, user.id);
    await db.query(
      "INSERT INTO transactions (user_id, type, amount, created_at, meta) VALUES (?, 'adjustment', ?, ?, ?)"
    ).run(user.id, delta, now, "{\"source\":\"seed_balance_upgrade\",\"target\":2000}");
  }
}

async function ensureMarket(createdBy: number, market: SeedMarket) {
  const existing = (await db
    .query("SELECT id FROM markets WHERE title = ?")
    .get(market.title)) as { id: number } | null;

  if (existing) {
    await ensureOutcomesForMarket(existing.id, market.outcomes);
    return existing.id;
  }

  const createdAt = nowIso();
  const marketId = await insertAndGetId(
    "INSERT INTO markets (title, description, status, created_by, created_at) VALUES (?, ?, 'active', ?, ?)",
    market.title,
    market.description,
    createdBy,
    createdAt
  );

  for (const label of market.outcomes) {
    await db.query("INSERT INTO outcomes (market_id, label, total_amount_staked) VALUES (?, ?, 0)").run(marketId, label);
  }

  return marketId;
}

async function ensureOutcomesForMarket(marketId: number, expectedOutcomes: string[]) {
  const existing = (await db
    .query("SELECT label FROM outcomes WHERE market_id = ?")
    .all(marketId)) as Array<{ label: string }>;

  const existingLabels = new Set(existing.map((row) => row.label.trim().toLowerCase()));
  for (const rawLabel of expectedOutcomes) {
    const label = rawLabel.trim();
    if (!label) continue;
    if (existingLabels.has(label.toLowerCase())) continue;
    await db.query("INSERT INTO outcomes (market_id, label, total_amount_staked) VALUES (?, ?, 0)").run(marketId, label);
  }
}

async function getOutcomeIdByLabel(marketId: number, label: string) {
  const row = (await db
    .query("SELECT id FROM outcomes WHERE market_id = ? AND label = ?")
    .get(marketId, label)) as { id: number } | null;

  return row?.id ?? null;
}

function calculateOutcomeStats(stakedByOutcome: number, totalPool: number) {
  if (totalPool <= 0 || stakedByOutcome <= 0) {
    return {
      stake: stakedByOutcome,
      share: 0,
      percentage: 0,
      odds: null as number | null,
    };
  }

  const share = stakedByOutcome / totalPool;
  return {
    stake: stakedByOutcome,
    share,
    percentage: Number((share * 100).toFixed(2)),
    odds: Number((1 / share).toFixed(2)),
  };
}

async function createSeedMarketSnapshot(marketId: number, createdAt: string) {
  const market = (await db
    .query("SELECT id, status, total_pool FROM markets WHERE id = ?")
    .get(marketId)) as { id: number; status: string; total_pool: number } | null;

  if (!market) return;

  const outcomes = (await db
    .query("SELECT id, label, total_amount_staked FROM outcomes WHERE market_id = ? ORDER BY id ASC")
    .all(marketId)) as Array<{ id: number; label: string; total_amount_staked: number }>;

  const totalPool = Number(market.total_pool || 0);
  const snapshotPayload = {
    totalPool,
    status: market.status,
    outcomes: outcomes.map((outcome) => ({
      id: outcome.id,
      label: outcome.label,
      ...calculateOutcomeStats(Number(outcome.total_amount_staked || 0), totalPool),
    })),
  };

  await db.query("INSERT INTO market_snapshots (market_id, created_at, data_json) VALUES (?, ?, ?)").run(
    marketId,
    createdAt,
    JSON.stringify(snapshotPayload)
  );
}

async function placeSeedBet(userId: number, marketId: number, outcomeId: number, amount: number, createdAt = nowIso()) {
  const user = (await db.query("SELECT balance FROM users WHERE id = ?").get(userId)) as { balance: number } | null;
  if (!user || user.balance < amount) {
    return false;
  }

  const market = (await db.query("SELECT status FROM markets WHERE id = ?").get(marketId)) as {
    status: string;
  } | null;
  if (!market || market.status !== "active") {
    return false;
  }

  const hasMarketBet = (await db
    .query("SELECT 1 as value FROM bets WHERE user_id = ? AND market_id = ? LIMIT 1")
    .get(userId, marketId)) as { value: number } | null;

  await db.query("UPDATE users SET balance = balance - ? WHERE id = ?").run(amount, userId);

  const betId = await insertAndGetId(
    "INSERT INTO bets (user_id, market_id, outcome_id, amount, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)",
    userId,
    marketId,
    outcomeId,
    amount,
    createdAt
  );

  await db.query("UPDATE outcomes SET total_amount_staked = total_amount_staked + ? WHERE id = ?").run(amount, outcomeId);

  await db.query(
    `UPDATE markets
     SET total_pool = total_pool + ?,
         participant_count = participant_count + ?
     WHERE id = ?`
  ).run(amount, hasMarketBet ? 0 : 1, marketId);

  await db.query(
    "INSERT INTO transactions (user_id, type, amount, market_id, bet_id, created_at, meta) VALUES (?, 'bet_placed', ?, ?, ?, ?, ?)"
  ).run(userId, -amount, marketId, betId, createdAt, "{\"source\":\"seed\"}");

  await createSeedMarketSnapshot(marketId, createdAt);

  return true;
}

async function insertAndGetId(sqlText: string, ...params: unknown[]) {
  if (db.provider === "postgres") {
    const row = (await db.query(`${sqlText} RETURNING id`).get(...params)) as { id: number } | null;
    if (!row) {
      throw new Error("Failed to obtain inserted id");
    }
    return Number(row.id);
  }

  const result = await db.query(sqlText).run(...params);
  return Number(result.lastInsertRowid);
}

function randomInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomTimestampBetween(startMs: number, endMs: number) {
  return new Date(randomInt(startMs, endMs)).toISOString();
}

async function run() {
  await initSchema();

  const adminId = await ensureUser({
    username: "admin",
    email: "admin@example.com",
    password: "admin123",
    role: "admin",
    balance: 1000,
  });

  const usersToEnsure: SeedUser[] = [
    { username: "user", email: "user@example.com", password: "user1234", role: "user", balance: 1000 },
    { username: "raphael", email: "raphael@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "andrew", email: "andrew@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "ionut291", email: "ionut291@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "maria", email: "maria@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "alexandru", email: "alexandru@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "sofia", email: "sofia@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "mihai", email: "mihai@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "emma", email: "emma@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "george", email: "george@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "diana", email: "diana@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "olivia", email: "olivia@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "ethan", email: "ethan@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "liam", email: "liam@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "charlotte", email: "charlotte@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "henry", email: "henry@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "amelia", email: "amelia@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "daniel", email: "daniel@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "lucas", email: "lucas@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "victoria", email: "victoria@example.com", password: "demo1234", role: "user", balance: 1000 },
    { username: "nathan", email: "nathan@example.com", password: "demo1234", role: "user", balance: 1000 },
  ];

  const userIds: number[] = [];
  for (const user of usersToEnsure) {
    userIds.push(await ensureUser(user));
  }

  const marketsToEnsure: SeedMarket[] = [
    {
      title: "Who will win FIFA World Cup 2026?",
      description: "Future event market on the 2026 World Cup winner.",
      outcomes: ["Brazil", "France", "Argentina", "Other"],
    },
    {
      title: "Will CS2 Major 2027 be won by a European team?",
      description: "Esports market for a future Counter-Strike major.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Romania adopt the euro before 2030?",
      description: "Policy market on future euro adoption timeline.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will EU AI regulation pass another major package by end of 2027?",
      description: "Politics and policy market about AI regulation pace in the EU.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will a crewed Mars mission launch before 2035?",
      description: "Space market for a future crewed mission timeline.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will the 2028 US presidential election be won by Democrats?",
      description: "Political market for the US 2028 general election outcome.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Ethereum ETF yearly inflows exceed Bitcoin ETF inflows in 2027?",
      description: "Financial market comparing potential ETF inflow trends.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will a non-EU team win UEFA Champions League 2027?",
      description: "Sports market for a future Champions League season winner profile.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Manchester City finish top 2 in Premier League 2026-27?",
      description: "Club football market for final league table placement.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Real Madrid win La Liga 2026-27?",
      description: "Spanish football title market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will an LEC team win Worlds 2027 in League of Legends?",
      description: "Esports market on LoL World Championship.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Team Vitality win a CS2 Major before 2028?",
      description: "Counter-Strike major winner market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Nadal return to win another ATP title?",
      description: "Tennis comeback and title market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Novak Djokovic win another Grand Slam title?",
      description: "Tennis career milestone market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will an NBA expansion team be announced before 2028?",
      description: "Basketball league expansion policy market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Boston Celtics reach the NBA Finals in 2027?",
      description: "NBA team performance market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will McLaren win the Formula 1 Constructors title in 2027?",
      description: "F1 constructors championship market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Max Verstappen win the 2027 F1 Drivers title?",
      description: "F1 drivers championship market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Bitcoin trade above $150k before 2028?",
      description: "Crypto market on long-term BTC price threshold.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Ethereum trade above $10k before 2028?",
      description: "Crypto market on ETH price threshold.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will the Fed cut rates at least 3 times in 2027?",
      description: "Macro market on US monetary policy.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will US CPI be below 3% by December 2027?",
      description: "Inflation target market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will the S&P 500 close above 7000 in 2027?",
      description: "US equity index milestone market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Apple release foldable iPhone before 2028?",
      description: "Consumer tech launch market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will OpenAI release GPT-6 before 2028?",
      description: "AI model release timing market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will AI-generated video exceed 30% of ad creatives by 2028?",
      description: "AI adoption in marketing market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will EU pass AI liability framework by end of 2027?",
      description: "Regulatory policy market for AI.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will a reusable rocket complete 100 launches in a year before 2028?",
      description: "Spaceflight cadence market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Artemis III launch before 2028?",
      description: "NASA moon mission timeline market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will a private company land humans on the moon before 2032?",
      description: "Commercial space milestone market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will EU renewable electricity share exceed 55% in 2028?",
      description: "Energy transition market for EU grid mix.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will global EV sales exceed 25 million units in 2027?",
      description: "Automotive adoption market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Tesla launch a mass-market model under $30k before 2028?",
      description: "EV product roadmap market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Netflix annual revenue exceed $60B in 2027?",
      description: "Media business performance market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Disney+ return to global net subscriber growth in 2027?",
      description: "Streaming growth market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Nintendo Switch successor sell over 20M units in first year?",
      description: "Gaming hardware sales milestone market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will GTA VI win Game of the Year on major award shows?",
      description: "Gaming awards outcome market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will WHO declare a new global health emergency before 2028?",
      description: "Public health policy market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will global life expectancy resume pre-2020 trend by 2028?",
      description: "Demographic recovery market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Eurozone GDP growth exceed 2% in 2027?",
      description: "Macroeconomic growth market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will UK rejoin EU single market before 2032?",
      description: "European political integration market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Scotland hold an independence referendum before 2030?",
      description: "UK constitutional politics market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will a coalition government form in Germany after next federal election?",
      description: "German election outcome market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will a woman win the 2028 US presidential election?",
      description: "US election demographic outcome market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will turnout in US 2028 election exceed 2024 turnout?",
      description: "US electoral participation market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Romania qualify for UEFA Euro 2028?",
      description: "International football qualification market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will Spain win UEFA Euro 2028?",
      description: "International football winner market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will India win ICC Cricket World Cup 2027?",
      description: "Cricket world cup winner market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will T20 World Cup 2028 final include England?",
      description: "Cricket tournament finalist market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will an African nation win FIFA World Cup before 2034?",
      description: "Long-term football history market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will UEFA expand Champions League format again by 2029?",
      description: "Football governance and format market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will global semiconductor revenue exceed $1T before 2030?",
      description: "Semiconductor industry growth market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will quantum computing reach practical advantage in pharma by 2029?",
      description: "Advanced computing adoption market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will autonomous robotaxis operate in 20+ cities by 2028?",
      description: "Autonomous transport deployment market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will major browser vendors ship AI agent mode by 2027?",
      description: "Web platform AI feature market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will global data center electricity use exceed 1000 TWh in 2028?",
      description: "Infrastructure and energy demand market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will COP climate summit agree on stricter methane targets by 2027?",
      description: "International climate policy market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will global temperature anomaly exceed 1.8C in any month before 2028?",
      description: "Climate signal threshold market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will YouTube overtake TikTok in daily watch-time among Gen Z by 2028?",
      description: "Digital media consumption trend market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will one-person unicorn startup appear before 2030?",
      description: "Startup ecosystem and AI leverage market.",
      outcomes: ["Yes", "No"],
    },
    {
      title: "Will global VC funding rebound above 2021 levels before 2030?",
      description: "Venture capital cycle market.",
      outcomes: ["Yes", "No"],
    },
  ];

  const marketIds: number[] = [];
  for (const market of marketsToEnsure) {
    marketIds.push(await ensureMarket(adminId, market));
  }

  for (const marketId of marketIds) {
    const existingBets = (await db.query("SELECT COUNT(*) as total FROM bets WHERE market_id = ?").get(marketId)) as {
      total: number;
    };

    const outcomes = (await db
      .query("SELECT id, label FROM outcomes WHERE market_id = ? ORDER BY id ASC")
      .all(marketId)) as Array<{ id: number; label: string }>;

    if (outcomes.length === 0) {
      continue;
    }

    const targetBetCount = randomInt(10, 18);
    const betsToAdd = Math.max(0, targetBetCount - Number(existingBets.total || 0));
    const nowMs = Date.now();
    const oneWeekAgoMs = nowMs - 7 * 24 * 60 * 60 * 1000;

    for (let i = 0; i < betsToAdd; i++) {
      const userId = userIds[randomInt(0, userIds.length - 1)];
      const outcome = outcomes[randomInt(0, outcomes.length - 1)];
      const amount = randomInt(10, 220);
      const createdAt = randomTimestampBetween(oneWeekAgoMs, nowMs - 2 * 60 * 1000);
      await placeSeedBet(userId, marketId, outcome.id, amount, createdAt);
    }
  }

  const sampleMarketId = await ensureMarket(adminId, {
    title: "Will Bun dominate JS runtime usage in 2026?",
    description: "Simple demo market so reviewers can place bets immediately.",
    outcomes: ["Yes", "No"],
  });

  const sampleBetCount = (await db
    .query("SELECT COUNT(*) as total FROM bets WHERE market_id = ?")
    .get(sampleMarketId)) as {
    total: number;
  };
  if (Number(sampleBetCount.total) === 0) {
    const yesId = await getOutcomeIdByLabel(sampleMarketId, "Yes");
    const noId = await getOutcomeIdByLabel(sampleMarketId, "No");
    if (yesId && noId) {
      const nowMs = Date.now();
      await placeSeedBet(userIds[0], sampleMarketId, yesId, 75, new Date(nowMs - 5 * 24 * 60 * 60 * 1000).toISOString());
      await placeSeedBet(userIds[1], sampleMarketId, noId, 50, new Date(nowMs - 2 * 24 * 60 * 60 * 1000).toISOString());
    }
  }

  await raiseExistingBalancesToTarget(2000);

  console.log("Seed complete.");
  console.log("Admin: admin / admin123");
  console.log("User: user / user1234");
  console.log("Extra users password: demo1234");
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
