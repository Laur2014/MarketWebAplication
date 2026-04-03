export function parsePositiveNumber(value: unknown) {
  const numeric = typeof value === "number" ? value : Number(value);

  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }

  return Number(numeric.toFixed(2));
}

export function parsePagination(searchParams: URLSearchParams) {
  const rawPage = Number(searchParams.get("page") || 1);
  const page = Number.isFinite(rawPage) ? Math.max(1, Math.floor(rawPage)) : 1;

  const rawLimit = Number(searchParams.get("limit") || 20);
  const limit = Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 20;
  const cappedLimit = Math.min(20, Math.max(1, limit));

  return {
    page,
    limit: cappedLimit,
    offset: (page - 1) * cappedLimit,
  };
}

export function dollarsToCents(value: number) {
  return Math.round(Number(value || 0) * 100);
}

export function centsToDollars(value: number) {
  return Number((value / 100).toFixed(2));
}

export function paginatedResponse<T>(items: T[], page: number, limit: number, totalItems: number) {
  const totalPages = Math.ceil(totalItems / limit);

  return {
    items,
    page,
    limit,
    totalItems,
    totalPages,
    hasNext: page < totalPages,
    hasPrev: page > 1,
  };
}

export function calculateOutcomeStats(stakedByOutcome: number, totalPool: number) {
  if (totalPool <= 0 || stakedByOutcome <= 0) {
    return {
      stake: stakedByOutcome,
      share: 0,
      percentage: 0,
      odds: null,
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
