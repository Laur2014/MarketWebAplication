import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, Navigate, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { apiRequest } from "./api";

type User = {
  id: number;
  username: string;
  email: string | null;
  role: "user" | "admin";
  balance: number;
  totalWinnings: number;
  createdAt: string;
};

type Outcome = {
  id: number;
  label: string;
  stake: number;
  share: number;
  percentage: number;
  odds: number | null;
};

type Market = {
  id: number;
  title: string;
  description: string | null;
  status: "active" | "resolved" | "archived";
  totalPool: number;
  participantCount: number;
  winningOutcomeId: number | null;
  outcomes: Outcome[];
  createdAt: string;
  resolvedAt: string | null;
  archivedAt: string | null;
};

type BetActiveItem = {
  id: number;
  amount: number;
  createdAt: string;
  market: { id: number; title: string; status: string };
  outcome: { id: number; label: string };
  odds: number | null;
  percentage: number;
};

type BetResolvedItem = {
  id: number;
  amount: number;
  status: "won" | "lost" | "refunded";
  won: boolean;
  payoutAmount: number;
  refundedAmount: number;
  createdAt: string;
  resolvedAt: string | null;
  market: { id: number; title: string };
  outcome: { id: number; label: string };
};

type AdminResolvedMarketItem = {
  marketId: number;
  marketTitle: string;
  resolvedAt: string | null;
  totalPool: number;
  winningOutcome: { id: number; label: string } | null;
};

type Paginated<T> = {
  items: T[];
  page: number;
  limit: number;
  totalItems: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
};

const POLL_MS = 5000;

function currency(value: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value ?? 0);
}

function oddsText(value: number | null) {
  return value ? `${value.toFixed(1)}x` : "-";
}

function percentageText(value: number) {
  return `${Math.round(value)}%`;
}

function outcomeColor(index: number) {
  const palette = ["#22d3ee", "#f97316", "#a3e635", "#e879f9", "#60a5fa", "#facc15"];
  return palette[index % palette.length];
}

type TrendRange = "15m" | "1h" | "6h" | "1d" | "1w";

const TREND_RANGE_CONFIG: Record<TrendRange, { durationMs: number; points: number; label: string }> = {
  "15m": { durationMs: 15 * 60 * 1000, points: 45, label: "15m" },
  "1h": { durationMs: 60 * 60 * 1000, points: 60, label: "1h" },
  "6h": { durationMs: 6 * 60 * 60 * 1000, points: 72, label: "6h" },
  "1d": { durationMs: 24 * 60 * 60 * 1000, points: 96, label: "1d" },
  "1w": { durationMs: 7 * 24 * 60 * 60 * 1000, points: 126, label: "1w" },
};

type HistorySnapshot = {
  createdAt: string;
  totalPool: number;
  status: string;
  outcomes: Array<{ id: number; label: string; percentage: number; odds: number | null; stake: number }>;
};

function buildTrendData(outcomes: Outcome[], historySnapshots: HistorySnapshot[], range: TrendRange, nowMs: number) {
  const config = TREND_RANGE_CONFIG[range];
  const currentSnapshot: HistorySnapshot = {
    createdAt: new Date(nowMs).toISOString(),
    totalPool: outcomes.reduce((sum, outcome) => sum + (outcome.stake || 0), 0),
    status: "active",
    outcomes: outcomes.map((outcome) => ({
      id: outcome.id,
      label: outcome.label,
      percentage: outcome.percentage,
      odds: outcome.odds,
      stake: outcome.stake,
    })),
  };

  const sortedSnapshots = [...historySnapshots].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
  );

  const timeline =
    sortedSnapshots.length > 0
      ? [...sortedSnapshots, currentSnapshot]
      : [
          currentSnapshot,
        ];

  const timestamps = timeline.map((snapshot) => new Date(snapshot.createdAt).getTime());
  if (timestamps.length < 2) {
    timestamps.push(nowMs);
  }

  return {
    range,
    config,
    timestamps,
    series: outcomes.map((outcome, index) => ({
      outcomeId: outcome.id,
      label: outcome.label,
      color: outcomeColor(index),
      values: (() => {
        const values: number[] = [];
        let lastValue = outcome.percentage;
        for (const snapshot of timeline) {
          const row = snapshot.outcomes.find((entry) => entry.id === outcome.id);
          if (row && Number.isFinite(row.percentage)) {
            lastValue = row.percentage;
          }
          values.push(lastValue);
        }
        if (values.length < 2) {
          values.push(lastValue);
        }
        return values;
      })(),
    })),
  };
}

function formatTrendTimestamp(timestamp: number, range: TrendRange) {
  const date = new Date(timestamp);
  if (range === "1w") {
    return date.toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" });
  }
  if (range === "1d" || range === "6h") {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function PageNav({
  page,
  totalPages,
  hasPrev,
  hasNext,
  onPrev,
  onNext,
}: {
  page: number;
  totalPages: number;
  hasPrev: boolean;
  hasNext: boolean;
  onPrev: () => void;
  onNext: () => void;
}) {
  return (
    <div className="pagination">
      <button disabled={!hasPrev} onClick={onPrev}>
        Previous
      </button>
      <span>
        Page {page} / {Math.max(totalPages, 1)}
      </span>
      <button disabled={!hasNext} onClick={onNext}>
        Next
      </button>
    </div>
  );
}

function AuthScreen({ onAuth }: { onAuth: (token: string, user: User) => void }) {
  const [isRegister, setIsRegister] = useState(false);
  const [username, setUsername] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");

    if (username.trim().length < 3) {
      setError("Username must have at least 3 characters.");
      return;
    }

    if (password.length < 6) {
      setError("Password must have at least 6 characters.");
      return;
    }

    setLoading(true);
    try {
      const path = isRegister ? "/auth/register" : "/auth/login";
      const payload = isRegister ? { username, email: email || undefined, password } : { username, password };

      const response = await apiRequest<{ token: string; user: User }>(path, {
        method: "POST",
        body: JSON.stringify(payload),
      });

      onAuth(response.token, response.user);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1>Prediction Market</h1>
        <p>Login or create an account to place bets.</p>
        <form onSubmit={submit} className="stack">
          <label>
            Username
            <input value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          {isRegister && (
            <label>
              Email (optional)
              <input value={email} onChange={(e) => setEmail(e.target.value)} />
            </label>
          )}
          <label>
            Password
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>
          {error && <div className="error">{error}</div>}
          <button disabled={loading} type="submit">
            {loading ? "Please wait..." : isRegister ? "Create Account" : "Login"}
          </button>
        </form>
        <button className="ghost auth-switch-btn" onClick={() => setIsRegister((old) => !old)}>
          {isRegister ? "Have an account? Login" : "No account? Register"}
        </button>
        <div className="demo-tip">
          Demo accounts after seed: <code>admin/admin123</code> and <code>user/user1234</code>
        </div>
      </div>
    </div>
  );
}

function LeaderboardList({ compact = false }: { compact?: boolean }) {
  const [items, setItems] = useState<Array<{ id: number; username: string; totalWinnings: number }>>([]);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      setError("");
      const response = await apiRequest<{ items: Array<{ id: number; username: string; totalWinnings: number }> }>(
        "/leaderboard"
      );
      setItems(response.items);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, POLL_MS);
    return () => clearInterval(interval);
  }, [load]);

  return (
    <section className={`panel ${compact ? "leaderboard-sidebar" : ""}`}>
      <h2>Leaderboard</h2>
      {error && <div className="error">{error}</div>}
      {items.length === 0 && <div>No winnings yet.</div>}
      {items.map((item, index) => (
        <div key={item.id} className="leaderboard-row">
          <span>#{index + 1}</span>
          <span>{item.username}</span>
          <span>{currency(item.totalWinnings)}</span>
        </div>
      ))}
    </section>
  );
}

function DashboardPage({
  token,
  user,
  onUserRefresh,
}: {
  token: string;
  user: User;
  onUserRefresh: () => Promise<void>;
}) {
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState("active");
  const [sort, setSort] = useState("createdAt");
  const [order, setOrder] = useState("desc");
  const [data, setData] = useState<Paginated<Market> | null>(null);
  const [leaderboard, setLeaderboard] = useState<Array<{ id: number; username: string; totalWinnings: number }>>([]);
  const [fastResolveMarkets, setFastResolveMarkets] = useState<Market[]>([]);
  const [fastResolveSelection, setFastResolveSelection] = useState<Record<number, number>>({});
  const [fastResolveMessage, setFastResolveMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [leaderboardError, setLeaderboardError] = useState("");

  const [createTitle, setCreateTitle] = useState("");
  const [createDescription, setCreateDescription] = useState("");
  const [createOutcomes, setCreateOutcomes] = useState([
    { label: "Yes", checked: true },
    { label: "No", checked: true },
  ]);
  const [outcomesDropdownOpen, setOutcomesDropdownOpen] = useState(false);
  const [customOutcome, setCustomOutcome] = useState("");
  const [createMessage, setCreateMessage] = useState("");

  const loadMarkets = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const query = `?page=${page}&limit=20&status=${status}&sort=${sort}&order=${order}`;
      const response = await apiRequest<Paginated<Market>>(`/markets${query}`);
      setData(response);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [page, status, sort, order]);

  const loadLeaderboard = useCallback(async () => {
    try {
      setLeaderboardError("");
      const response = await apiRequest<{ items: Array<{ id: number; username: string; totalWinnings: number }> }>(
        "/leaderboard"
      );
      setLeaderboard(response.items);
    } catch (err) {
      setLeaderboardError((err as Error).message);
    }
  }, []);

  const loadFastResolveMarkets = useCallback(async () => {
    if (user.role !== "admin") return;
    const response = await apiRequest<Paginated<Market>>(
      "/markets?page=1&limit=20&status=active&sort=createdAt&order=desc"
    );
    const topFive = response.items.slice(0, 5);
    setFastResolveMarkets(topFive);
    setFastResolveSelection((current) => {
      const next = { ...current };
      for (const market of topFive) {
        if (!next[market.id] && market.outcomes[0]) {
          next[market.id] = market.outcomes[0].id;
        }
      }
      return next;
    });
  }, [user.role]);

  useEffect(() => {
    setPage(1);
  }, [status, sort, order]);

  useEffect(() => {
    if (!data) return;
    const safeTotalPages = Math.max(1, data.totalPages);
    if (page > safeTotalPages) {
      setPage(1);
    }
  }, [data, page]);

  useEffect(() => {
    loadMarkets();
    loadLeaderboard();
    loadFastResolveMarkets();
    const interval = setInterval(() => {
      loadMarkets();
      loadLeaderboard();
      loadFastResolveMarkets();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [loadFastResolveMarkets, loadLeaderboard, loadMarkets]);

  const createMarket = async (event: FormEvent) => {
    event.preventDefault();
    setCreateMessage("");
    const outcomes = createOutcomes.filter((item) => item.checked).map((item) => item.label);

    if (createTitle.trim().length < 3) {
      setCreateMessage("Title must be at least 3 characters.");
      return;
    }
    if (outcomes.length < 2) {
      setCreateMessage("Select at least 2 outcomes.");
      return;
    }

    try {
      await apiRequest<{ market: Market }>(
        "/markets",
        {
          method: "POST",
          body: JSON.stringify({
            title: createTitle,
            description: createDescription || undefined,
            outcomes,
          }),
        },
        token
      );
      setCreateTitle("");
      setCreateDescription("");
      setCreateOutcomes([
        { label: "Yes", checked: true },
        { label: "No", checked: true },
      ]);
      setCreateMessage("Market created.");
      setPage(1);
      loadMarkets();
      onUserRefresh();
    } catch (err) {
      setCreateMessage((err as Error).message);
    }
  };

  const toggleOutcome = (label: string) => {
    setCreateOutcomes((current) =>
      current.map((item) => (item.label === label ? { ...item, checked: !item.checked } : item))
    );
  };

  const addCustomOutcome = () => {
    const value = customOutcome.trim();
    if (!value) return;
    const exists = createOutcomes.some((item) => item.label.toLowerCase() === value.toLowerCase());
    if (exists) {
      setCreateMessage("Outcome already exists.");
      return;
    }
    setCreateOutcomes((current) => [...current, { label: value, checked: true }]);
    setCustomOutcome("");
  };

  const canCreateBet = user.role !== "admin";

  const resolveFromFastPanel = async (marketId: number) => {
    const winningOutcomeId = fastResolveSelection[marketId];
    if (!winningOutcomeId) return;

    try {
      setFastResolveMessage("");
      await apiRequest(
        `/admin/markets/${marketId}/resolve`,
        { method: "POST", body: JSON.stringify({ winningOutcomeId }) },
        token
      );
      setFastResolveMessage("Market resolved.");
      await Promise.all([loadMarkets(), loadFastResolveMarkets(), onUserRefresh()]);
    } catch (err) {
      setFastResolveMessage((err as Error).message);
    }
  };

  return (
    <div className="dashboard-layout">
      <section className={`panel dashboard-left ${!canCreateBet ? "admin-fast-resolve-panel" : ""}`}>
        <h2>{canCreateBet ? "Create Market" : "Fast Resolve"}</h2>
        {canCreateBet ? (
          <form className="grid-form" onSubmit={createMarket}>
            <label>
              Title
              <input value={createTitle} onChange={(e) => setCreateTitle(e.target.value)} />
            </label>
            <label>
              Description
              <input value={createDescription} onChange={(e) => setCreateDescription(e.target.value)} />
            </label>
            <div className="outcomes-picker">
              <span>Outcomes</span>
              <button type="button" className="outcomes-toggle" onClick={() => setOutcomesDropdownOpen((old) => !old)}>
                {createOutcomes.filter((item) => item.checked).map((item) => item.label).join(", ") || "Select outcomes"}
              </button>
              {outcomesDropdownOpen && (
                <div className="outcomes-menu">
                  {createOutcomes.map((item) => (
                    <label key={item.label} className="outcome-option">
                      <input type="checkbox" checked={item.checked} onChange={() => toggleOutcome(item.label)} />
                      <span>{item.label}</span>
                    </label>
                  ))}
                  <div className="custom-outcome-row">
                    <input
                      placeholder="Add custom outcome"
                      value={customOutcome}
                      onChange={(e) => setCustomOutcome(e.target.value)}
                    />
                    <button type="button" onClick={addCustomOutcome}>
                      +
                    </button>
                  </div>
                </div>
              )}
            </div>
            <button type="submit">Create Market</button>
            {createMessage && <div>{createMessage}</div>}
          </form>
        ) : (
          <div className="fast-resolve-wrap">
            {fastResolveMarkets.length === 0 && <div className="admin-helper-text">No active markets to resolve.</div>}
            {fastResolveMarkets.map((market) => (
              <div key={market.id} className="fast-resolve-row">
                <div className="fast-resolve-title">{market.title}</div>
                <select
                  value={fastResolveSelection[market.id] ?? ""}
                  onChange={(e) =>
                    setFastResolveSelection((current) => ({
                      ...current,
                      [market.id]: Number(e.target.value),
                    }))
                  }
                >
                  {market.outcomes.map((outcome) => (
                    <option key={outcome.id} value={outcome.id}>
                      {outcome.label}
                    </option>
                  ))}
                </select>
                <button onClick={() => resolveFromFastPanel(market.id)}>Resolve</button>
              </div>
            ))}
            {fastResolveMessage && <div>{fastResolveMessage}</div>}
          </div>
        )}
      </section>

      <section className="panel dashboard-center">
        <div className="toolbar">
          <h2>Markets</h2>
          <div className="toolbar-controls">
            <select value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="resolved">Resolved</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
            <select value={sort} onChange={(e) => setSort(e.target.value)}>
              <option value="createdAt">Creation Date</option>
              <option value="totalBetSize">Total Bet Size</option>
              <option value="participantCount">Participants</option>
            </select>
            <select value={order} onChange={(e) => setOrder(e.target.value)}>
              <option value="desc">Desc</option>
              <option value="asc">Asc</option>
            </select>
          </div>
        </div>

        {loading && <div>Loading markets...</div>}
        {error && <div className="error">{error}</div>}
        {!loading && !error && data?.items.length === 0 && <div>No markets yet.</div>}

        <div className="market-grid dashboard-market-grid">
          {data?.items.map((market) => (
            <article key={market.id} className="market-card">
              <div className="market-head">
                <Link className="market-title-link" to={`/market/${market.id}`}>
                  {market.title}
                </Link>
                <span className={`badge ${market.status}`}>{market.status}</span>
              </div>
              <p className="market-description">{market.description || "No description"}</p>
              {market.description && market.description.length > 100 && (
                <Link className="more-link" to={`/market/${market.id}`}>
                  More
                </Link>
              )}
              <div className="market-meta">
                <div>Total pool: {currency(market.totalPool)}</div>
                <div>Participants: {market.participantCount}</div>
              </div>
              <div className={`stack tiny market-outcomes ${market.outcomes.length > 3 ? "is-scrollable" : ""}`}>
                {market.outcomes.map((outcome) => (
                  <div key={outcome.id} className="row-between">
                    <span>{outcome.label}</span>
                    <span>
                      {percentageText(outcome.percentage)} ({oddsText(outcome.odds)})
                    </span>
                  </div>
                ))}
              </div>
              <Link className="place-bet-btn" to={`/market/${market.id}`}>
                {user.role === "admin" ? "Resolve Bet" : "Place a bet"}
              </Link>
              {user.role === "admin" && <small>Admin actions available in market detail.</small>}
            </article>
          ))}
        </div>
        {data && (
          <PageNav
            page={data.page}
            totalPages={data.totalPages}
            hasPrev={data.hasPrev}
            hasNext={data.hasNext}
            onPrev={() => setPage((p) => Math.max(1, p - 1))}
            onNext={() => setPage((p) => p + 1)}
          />
        )}
      </section>

      <aside className="panel dashboard-right">
        <h2>Leaderboard</h2>
        {leaderboardError && <div className="error">{leaderboardError}</div>}
        {leaderboard.length === 0 && !leaderboardError && <div>No winnings yet.</div>}
        {leaderboard.map((item, index) => (
          <div key={item.id} className="leaderboard-row">
            <span>#{index + 1}</span>
            <span>{item.username}</span>
            <span>{currency(item.totalWinnings)}</span>
          </div>
        ))}
      </aside>
    </div>
  );
}

function MarketDetailPage({ token, user, onUserRefresh }: { token: string; user: User; onUserRefresh: () => Promise<void> }) {
  const { id } = useParams();
  const marketId = Number(id);
  const navigate = useNavigate();

  const [market, setMarket] = useState<Market | null>(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [selectedOutcome, setSelectedOutcome] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [message, setMessage] = useState("");
  const [resolveOutcomeId, setResolveOutcomeId] = useState<number | null>(null);
  const [showBetSuccess, setShowBetSuccess] = useState(false);
  const [trendRange, setTrendRange] = useState<TrendRange>("6h");
  const [trendHoverIndex, setTrendHoverIndex] = useState<number | null>(null);
  const [trendNow, setTrendNow] = useState(Date.now());
  const [trendHistory, setTrendHistory] = useState<HistorySnapshot[]>([]);

  const load = useCallback(async (options?: { silent?: boolean }) => {
    if (!marketId) return;
    const silent = Boolean(options?.silent);
    if (silent) {
      setIsRefreshing(true);
    } else {
      setLoading(true);
      setError("");
    }
    try {
      const response = await apiRequest<{ market: Market }>(`/markets/${marketId}`);
      setMarket(response.market);
      setTrendNow(Date.now());
      if (!selectedOutcome && response.market.outcomes.length > 0) {
        setSelectedOutcome(response.market.outcomes[0].id);
      }
      if (!resolveOutcomeId && response.market.outcomes.length > 0) {
        setResolveOutcomeId(response.market.outcomes[0].id);
      }
    } catch (err) {
      if (!silent) {
        setError((err as Error).message);
      }
    } finally {
      if (silent) {
        setIsRefreshing(false);
      } else {
        setLoading(false);
      }
    }
  }, [marketId, selectedOutcome, resolveOutcomeId]);

  const loadTrendHistory = useCallback(async () => {
    if (!marketId) return;
    try {
      const response = await apiRequest<{ snapshots: HistorySnapshot[] }>(
        `/markets/${marketId}/history?range=${trendRange}`
      );
      setTrendHistory(response.snapshots || []);
    } catch {
      // Keep UI usable even if history fetch fails.
    }
  }, [marketId, trendRange]);

  useEffect(() => {
    load();
    loadTrendHistory();
    const interval = setInterval(() => {
      load({ silent: true });
      loadTrendHistory();
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [load, loadTrendHistory]);

  const trendData = useMemo(() => {
    if (!market) return null;
    return buildTrendData(market.outcomes, trendHistory, trendRange, trendNow);
  }, [market, trendHistory, trendNow, trendRange]);

  const placeBet = async (event: FormEvent) => {
    event.preventDefault();
    setMessage("");
    const parsed = Number(amount);
    if (!selectedOutcome) {
      setMessage("Select an outcome.");
      return;
    }
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setMessage("Bet amount must be a positive number.");
      return;
    }

    try {
      await apiRequest(
        `/markets/${marketId}/bets`,
        {
          method: "POST",
          body: JSON.stringify({ outcomeId: selectedOutcome, amount: parsed }),
        },
        token
      );
      setMessage("Bet placed.");
      setShowBetSuccess(true);
      setAmount("");
      await Promise.all([load(), loadTrendHistory(), onUserRefresh()]);
      setTimeout(() => setShowBetSuccess(false), 1800);
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const resolveMarket = async () => {
    if (!resolveOutcomeId) return;
    setMessage("");
    try {
      await apiRequest(
        `/admin/markets/${marketId}/resolve`,
        { method: "POST", body: JSON.stringify({ winningOutcomeId: resolveOutcomeId }) },
        token
      );
      setMessage("Market resolved.");
      await Promise.all([load(), loadTrendHistory(), onUserRefresh()]);
    } catch (err) {
      setMessage((err as Error).message);
    }
  };

  const archiveMarket = async () => {
      setMessage("");
      try {
        await apiRequest(`/admin/markets/${marketId}/archive`, { method: "POST" }, token);
        setMessage("Market archived.");
        await Promise.all([load(), loadTrendHistory(), onUserRefresh()]);
      } catch (err) {
        setMessage((err as Error).message);
      }
  };

  if (!marketId || Number.isNaN(marketId)) return <Navigate to="/" replace />;

  return (
    <div className="panel stack">
      <button className="ghost" onClick={() => navigate(-1)}>
        Back
      </button>
      {loading && <div>Loading market...</div>}
      {!loading && isRefreshing && <div className="refreshing-hint">Updating live odds...</div>}
      {error && <div className="error">{error}</div>}
      {!loading && !error && market && (
        <>
          <h2>{market.title}</h2>
          <p>{market.description || "No description"}</p>
          {trendData && (
            <div className="trend-card">
              <div className="trend-topbar">
                <div className="trend-live-pill">Live update: every 5s</div>
                <div className="trend-range-controls">
                  {(Object.keys(TREND_RANGE_CONFIG) as TrendRange[]).map((rangeKey) => (
                    <button
                      key={rangeKey}
                      type="button"
                      className={`trend-range-btn ${trendRange === rangeKey ? "active" : ""}`}
                      onClick={() => setTrendRange(rangeKey)}
                    >
                      {TREND_RANGE_CONFIG[rangeKey].label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="trend-svg-wrap">
                <svg
                  viewBox="0 0 100 34"
                  preserveAspectRatio="none"
                  className="trend-svg"
                  onMouseLeave={() => setTrendHoverIndex(null)}
                  onMouseMove={(event) => {
                    const rect = event.currentTarget.getBoundingClientRect();
                    const x = event.clientX - rect.left;
                    const ratio = Math.max(0, Math.min(1, x / Math.max(1, rect.width)));
                    const pointIndex = Math.round(ratio * (trendData.timestamps.length - 1));
                    setTrendHoverIndex(pointIndex);
                  }}
                  onTouchMove={(event) => {
                    const touch = event.touches[0];
                    if (!touch) return;
                    const rect = event.currentTarget.getBoundingClientRect();
                    const x = touch.clientX - rect.left;
                    const ratio = Math.max(0, Math.min(1, x / Math.max(1, rect.width)));
                    const pointIndex = Math.round(ratio * (trendData.timestamps.length - 1));
                    setTrendHoverIndex(pointIndex);
                  }}
                >
                  {[6, 12, 18, 24, 30].map((y) => (
                    <line key={y} x1="0" y1={y} x2="100" y2={y} className="trend-grid-line" />
                  ))}

                  {trendData.series.map((line) => {
                    const stepX = 100 / Math.max(1, line.values.length - 1);
                    const path = line.values
                      .map((value, i) => {
                        const x = i * stepX;
                        const y = 32 - (value / 100) * 28;
                        return `${x.toFixed(2)},${y.toFixed(2)}`;
                      })
                      .join(" ");

                    return (
                      <polyline
                        key={line.outcomeId}
                        points={path}
                        fill="none"
                        stroke={line.color}
                        strokeWidth="0.55"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        className="trend-line"
                      />
                    );
                  })}

                  {trendHoverIndex !== null && (
                    <line
                      x1={((trendHoverIndex / Math.max(1, trendData.timestamps.length - 1)) * 100).toFixed(2)}
                      y1="2"
                      x2={((trendHoverIndex / Math.max(1, trendData.timestamps.length - 1)) * 100).toFixed(2)}
                      y2="32"
                      className="trend-hover-line"
                    />
                  )}

                  {trendHoverIndex !== null &&
                    trendData.series.map((line) => {
                      const x = (trendHoverIndex / Math.max(1, trendData.timestamps.length - 1)) * 100;
                      const value = line.values[trendHoverIndex] ?? line.values[line.values.length - 1];
                      const y = 32 - (value / 100) * 28;
                      return <circle key={line.outcomeId} cx={x} cy={y} r="0.8" fill={line.color} />;
                    })}
                </svg>

                {trendHoverIndex !== null && (
                  <div className="trend-tooltip">
                    <div className="trend-tooltip-time">
                      {formatTrendTimestamp(trendData.timestamps[trendHoverIndex], trendData.range)}
                    </div>
                    {trendData.series.map((line) => {
                      const value = line.values[trendHoverIndex] ?? 0;
                      const impliedOdds = value > 0 ? Number((100 / value).toFixed(1)) : null;
                      return (
                        <div key={line.outcomeId} className="trend-tooltip-row">
                          <span className="trend-dot" style={{ background: line.color }} />
                          <span>{line.label}</span>
                          <span>
                            {percentageText(value)} / {impliedOdds ? `${impliedOdds}x` : "-"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              <div className="trend-legend">
                {trendData.series.map((line, index) => {
                  const latest = line.values[line.values.length - 1] ?? 0;
                  const latestOdds = latest > 0 ? Number((100 / latest).toFixed(1)) : null;
                  return (
                    <div key={line.outcomeId} className="trend-legend-item">
                      <span className="trend-dot" style={{ background: line.color || outcomeColor(index) }} />
                      <span>{line.label}</span>
                      <span>
                        {percentageText(latest)} / {latestOdds ? `${latestOdds}x` : "-"}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
          <div className="row">
            <span className={`badge ${market.status}`}>{market.status}</span>
            <span>Total pool: {currency(market.totalPool)}</span>
          </div>
          <div className="chart">
            {market.outcomes.map((outcome) => (
              <div key={outcome.id} className="chart-row">
                <div className="chart-label">{outcome.label}</div>
                <div className="chart-bar-wrap">
                  <div className="chart-bar" style={{ width: `${outcome.percentage}%` }} />
                </div>
                <div className="chart-value">
                  {percentageText(outcome.percentage)} / {oddsText(outcome.odds)}
                </div>
              </div>
            ))}
          </div>

          {user.role !== "admin" && (
            <form className="grid-form" onSubmit={placeBet}>
              <h3>Place Bet</h3>
              <label>
                Outcome
                <select
                  value={selectedOutcome ?? ""}
                  onChange={(e) => setSelectedOutcome(Number(e.target.value))}
                  disabled={market.status !== "active"}
                >
                  {market.outcomes.map((outcome) => (
                    <option key={outcome.id} value={outcome.id}>
                      {outcome.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Amount
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  type="number"
                  min={0}
                  step="0.01"
                  disabled={market.status !== "active"}
                />
              </label>
              <button type="submit" disabled={market.status !== "active"}>
                Place Bet
              </button>
              {market.status !== "active" && <div>This market is not active.</div>}
            </form>
          )}

          {user.role === "admin" && (
            <div className="panel subtle">
              <h3>Admin Controls</h3>
              <label>
                Winning outcome
                <select value={resolveOutcomeId ?? ""} onChange={(e) => setResolveOutcomeId(Number(e.target.value))}>
                  {market.outcomes.map((outcome) => (
                    <option key={outcome.id} value={outcome.id}>
                      {outcome.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="row admin-actions-row">
                <button disabled={market.status !== "active"} onClick={resolveMarket}>
                  Resolve Bet
                </button>
                <button onClick={archiveMarket} disabled={market.status === "archived"}>
                  Archive
                </button>
              </div>
            </div>
          )}
          {message && <div>{message}</div>}
        </>
      )}
      {showBetSuccess && (
        <div className="bet-success-popup">
          <div className="bet-success-check">✓</div>
          <div>Bet placed successfully</div>
        </div>
      )}
    </div>
  );
}

function ProfilePage({
  token,
  user,
  onUserRefresh,
  theme,
  onToggleTheme,
}: {
  token: string;
  user: User;
  onUserRefresh: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const [activePage, setActivePage] = useState(1);
  const [resolvedPage, setResolvedPage] = useState(1);
  const [activeData, setActiveData] = useState<Paginated<BetActiveItem> | null>(null);
  const [resolvedData, setResolvedData] = useState<Paginated<BetResolvedItem> | null>(null);
  const [adminResolvedData, setAdminResolvedData] = useState<Paginated<AdminResolvedMarketItem> | null>(null);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyMessage, setApiKeyMessage] = useState("");

  const loadActive = useCallback(async () => {
    if (user.role === "admin") return;
    const response = await apiRequest<Paginated<BetActiveItem>>(`/me/bets/active?page=${activePage}&limit=20`, {}, token);
    setActiveData(response);
  }, [token, activePage, user.role]);

  const loadResolved = useCallback(async () => {
    if (user.role === "admin") {
      try {
        const response = await apiRequest<Paginated<AdminResolvedMarketItem>>(
          `/me/markets/resolved-by-me?page=${resolvedPage}&limit=20`,
          {},
          token
        );
        setAdminResolvedData(response);
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes("NOT_FOUND")) {
          throw new Error("Admin resolved-bets endpoint not found. Restart backend to load latest API.");
        }
        throw err;
      }
      return;
    }
    const response = await apiRequest<Paginated<BetResolvedItem>>(
      `/me/bets/resolved?page=${resolvedPage}&limit=20`,
      {},
      token
    );
    setResolvedData(response);
  }, [token, resolvedPage, user.role]);

  useEffect(() => {
    (async () => {
      try {
        setError("");
        await Promise.all([loadActive(), loadResolved(), onUserRefresh()]);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [loadActive, loadResolved, onUserRefresh]);

  useEffect(() => {
    const interval = setInterval(() => {
      loadActive().catch(() => null);
      onUserRefresh().catch(() => null);
    }, POLL_MS);
    return () => clearInterval(interval);
  }, [loadActive, onUserRefresh]);

  const generateKey = async () => {
    setApiKeyMessage("");
    try {
      const response = await apiRequest<{ apiKey: string }>("/me/api-key", { method: "POST" }, token);
      setApiKey(response.apiKey);
      setApiKeyMessage("New API key generated. Save it now.");
    } catch (err) {
      setApiKeyMessage((err as Error).message);
    }
  };

  const revokeKey = async () => {
    setApiKeyMessage("");
    try {
      await apiRequest("/me/api-key", { method: "DELETE" }, token);
      setApiKey("");
      setApiKeyMessage("API key revoked.");
    } catch (err) {
      setApiKeyMessage((err as Error).message);
    }
  };

  return (
    <div className="stack">
      <section className="panel">
        <h2>Profile</h2>
        <div className="profile-meta">Username: {user.username}</div>
        <div className="profile-meta">Role: {user.role}</div>
        {user.role !== "admin" && <div className="profile-meta">Balance: {currency(user.balance)}</div>}
        {user.role !== "admin" && <div className="profile-meta">Total Winnings: {currency(user.totalWinnings)}</div>}
        <button className="ghost profile-mobile-theme-btn" onClick={onToggleTheme}>
          Switch to {theme === "dark" ? "Light" : "Dark"} mode
        </button>
      </section>

      {user.role !== "admin" && (
        <section className="panel">
          <h3>API Key (Bonus)</h3>
          <div className="row">
            <button onClick={generateKey}>Generate / Rotate API Key</button>
            <button onClick={revokeKey}>Revoke API Key</button>
          </div>
          {apiKey && <code className="block-code">{apiKey}</code>}
          {apiKeyMessage && <div>{apiKeyMessage}</div>}
        </section>
      )}

      {user.role !== "admin" && (
        <section className="panel">
          <h3>Active Bets</h3>
          {error && <div className="error">{error}</div>}
          {activeData?.items.length === 0 && <div>No active bets.</div>}
          {activeData?.items.map((bet) => (
            <article key={bet.id} className="list-item">
              <Link className="profile-market-link" to={`/market/${bet.market.id}`}>
                {bet.market.title}
              </Link>
              <div>
                Outcome: {bet.outcome.label} | Stake: {currency(bet.amount)} | Current odds: {oddsText(bet.odds)} (
                {percentageText(bet.percentage)})
              </div>
            </article>
          ))}
          {activeData && (
            <PageNav
              page={activeData.page}
              totalPages={activeData.totalPages}
              hasPrev={activeData.hasPrev}
              hasNext={activeData.hasNext}
              onPrev={() => setActivePage((p) => Math.max(1, p - 1))}
              onNext={() => setActivePage((p) => p + 1)}
            />
          )}
        </section>
      )}

      <section className="panel">
        <h3>{user.role === "admin" ? "Resolved Bets by Me" : "Resolved Bets"}</h3>
        {error && <div className="error">{error}</div>}
        {user.role === "admin" && adminResolvedData?.items.length === 0 && <div>No resolved bets by you yet.</div>}
        {user.role === "admin" &&
          adminResolvedData?.items.map((market) => (
            <article key={market.marketId} className="list-item">
              <Link className="profile-market-link" to={`/market/${market.marketId}`}>
                {market.marketTitle}
              </Link>
              <div>
                Winning outcome: <strong>{market.winningOutcome?.label || "Not set"}</strong> | Pool:{" "}
                {currency(market.totalPool)}
              </div>
              <div>Resolved at: {market.resolvedAt ? new Date(market.resolvedAt).toLocaleString() : "-"}</div>
            </article>
          ))}
        {user.role !== "admin" && resolvedData?.items.length === 0 && <div>No resolved bets.</div>}
        {user.role !== "admin" &&
          resolvedData?.items.map((bet) => (
            <article key={bet.id} className="list-item">
              <Link className="profile-market-link" to={`/market/${bet.market.id}`}>
                {bet.market.title}
              </Link>
              <div>
                Outcome: {bet.outcome.label} | Stake: {currency(bet.amount)} | Status: <strong>{bet.status}</strong>
              </div>
              <div>
                Payout: {currency(bet.payoutAmount)} | Refund: {currency(bet.refundedAmount)}
              </div>
            </article>
          ))}
        {user.role === "admin" && adminResolvedData && (
          <PageNav
            page={adminResolvedData.page}
            totalPages={adminResolvedData.totalPages}
            hasPrev={adminResolvedData.hasPrev}
            hasNext={adminResolvedData.hasNext}
            onPrev={() => setResolvedPage((p) => Math.max(1, p - 1))}
            onNext={() => setResolvedPage((p) => p + 1)}
          />
        )}
        {user.role !== "admin" && resolvedData && (
          <PageNav
            page={resolvedData.page}
            totalPages={resolvedData.totalPages}
            hasPrev={resolvedData.hasPrev}
            hasNext={resolvedData.hasNext}
            onPrev={() => setResolvedPage((p) => Math.max(1, p - 1))}
            onNext={() => setResolvedPage((p) => p + 1)}
          />
        )}
      </section>
    </div>
  );
}

function LeaderboardPage() {
  return <LeaderboardList />;
}

function AppShell({
  token,
  user,
  onLogout,
  onUserRefresh,
  theme,
  onToggleTheme,
}: {
  token: string;
  user: User;
  onLogout: () => void;
  onUserRefresh: () => Promise<void>;
  theme: "light" | "dark";
  onToggleTheme: () => void;
}) {
  const navigate = useNavigate();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="app">
      <header className="topbar">
        <button className="burger-btn" onClick={() => setMobileMenuOpen((old) => !old)} aria-label="Open navigation menu">
          <span />
          <span />
          <span />
        </button>
        <div className="topbar-left">
          <div className="brand">Prediction Market</div>
          <Link to="/" className="home-link">
            HOME
          </Link>
        </div>
        <div className="row topbar-right">
          {user.role !== "admin" && <span className="balance-text">{currency(user.balance)}</span>}
          <button className="ghost theme-btn" onClick={onToggleTheme}>
            {theme === "dark" ? "Light" : "Dark"}
          </button>
          <Link to="/profile" className="profile-pill">
            <span className="profile-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="8" r="4" />
                <path d="M4 20c2-4 5-6 8-6s6 2 8 6" />
              </svg>
            </span>
            <span>{user.username}</span>
          </Link>
          <button className="ghost" onClick={onLogout}>
            Logout
          </button>
        </div>
      </header>
      {mobileMenuOpen && (
        <>
          <div className="mobile-menu-backdrop" onClick={() => setMobileMenuOpen(false)} />
          <aside className="mobile-menu-drawer">
            <button
              className="ghost"
              onClick={() => {
                navigate("/");
                setMobileMenuOpen(false);
              }}
            >
              Home
            </button>
            <button
              className="ghost"
              onClick={() => {
                navigate("/profile");
                setMobileMenuOpen(false);
              }}
            >
              Profile
            </button>
            <button
              className="ghost"
              onClick={() => {
                navigate("/leaderboard");
                setMobileMenuOpen(false);
              }}
            >
              Leaderboards
            </button>
            <button
              className="ghost mobile-menu-logout"
              onClick={() => {
                setMobileMenuOpen(false);
                onLogout();
              }}
            >
              Logout
            </button>
          </aside>
        </>
      )}
      <main className="content">
        <Routes>
          <Route path="/" element={<DashboardPage token={token} user={user} onUserRefresh={onUserRefresh} />} />
          <Route path="/market/:id" element={<MarketDetailPage token={token} user={user} onUserRefresh={onUserRefresh} />} />
          <Route
            path="/profile"
            element={
              <div className="stack">
                <ProfilePage
                  token={token}
                  user={user}
                  onUserRefresh={onUserRefresh}
                  theme={theme}
                  onToggleTheme={onToggleTheme}
                />
                <section className="panel mobile-logout-panel">
                  <button className="ghost mobile-logout-btn" onClick={onLogout}>
                    Logout
                  </button>
                </section>
              </div>
            }
          />
          <Route path="/leaderboard" element={<LeaderboardPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

export function App() {
  const [token, setToken] = useState(() => localStorage.getItem("pm_token") || "");
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [theme, setTheme] = useState<"light" | "dark">(
    (localStorage.getItem("theme") as "light" | "dark") || "light"
  );

  const onAuth = (newToken: string, authUser: User) => {
    localStorage.setItem("pm_token", newToken);
    setToken(newToken);
    setUser(authUser);
  };

  const onLogout = () => {
    apiRequest("/auth/logout", { method: "POST" }, token).catch(() => null);
    localStorage.removeItem("pm_token");
    setToken("");
    setUser(null);
  };

  const refreshMe = useCallback(async () => {
    const response = await apiRequest<{ user: User }>("/me", {}, token);
    setUser(response.user);
  }, [token]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("theme", theme);
  }, [theme]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        await refreshMe();
      } catch {
        setUser(null);
        localStorage.removeItem("pm_token");
        setToken("");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshMe]);

  if (loading) {
    return <div className="auth-shell">Loading...</div>;
  }

  if (!user) {
    return <AuthScreen onAuth={onAuth} />;
  }

  return (
    <AppShell
      token={token}
      user={user}
      onLogout={onLogout}
      onUserRefresh={refreshMe}
      theme={theme}
      onToggleTheme={() => setTheme((old) => (old === "light" ? "dark" : "light"))}
    />
  );
}

