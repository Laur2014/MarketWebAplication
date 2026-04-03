export const API_BASE_URL = "http://localhost:3001";

export type ApiError = {
  error: string;
};

export async function apiRequest<T>(path: string, options: RequestInit = {}, token?: string, apiKey?: string): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (apiKey) {
    headers["X-API-Key"] = apiKey;
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...options,
    headers,
    credentials: "include",
  });

  const contentType = response.headers.get("content-type") || "";
  let data: unknown = null;
  let textBody = "";

  if (response.status !== 204) {
    if (contentType.includes("application/json")) {
      try {
        data = await response.json();
      } catch {
        data = null;
      }
    } else {
      textBody = await response.text();
    }
  }

  if (!response.ok) {
    throw new Error((data as ApiError | null)?.error || textBody || `Request failed (${response.status})`);
  }

  return (data as T) ?? ({} as T);
}
