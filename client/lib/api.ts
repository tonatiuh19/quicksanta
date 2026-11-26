import axios from "axios";
import i18n from "@/i18n";

export const api = axios.create({
  baseURL: "/api",
  headers: { "Content-Type": "application/json" },
  withCredentials: true,
});

/** Active tenant for /api/app/* calls (set by the auth slice when the user switches workspace). */
let activeTenantId: number | null = null;
export function setActiveTenantHeader(id: number | null) {
  activeTenantId = id;
}

api.interceptors.request.use((config) => {
  const lang = i18n.language?.startsWith("es") ? "es" : "en";
  config.headers.set("Accept-Language", lang);
  if (activeTenantId && String(config.url || "").startsWith("/app/")) {
    config.headers.set("X-Tenant-Id", String(activeTenantId));
  }
  return config;
});

/** Prefer i18n keys from the API (`validation.*`, `errors.*`); fall back to raw text. */
export function formatAxiosError(error: unknown, fallbackKey = "errors.server"): string {
  if (axios.isAxiosError(error)) {
    const data = error.response?.data as { error?: string; message?: string } | undefined;
    return data?.error || data?.message || error.message || fallbackKey;
  }
  if (error instanceof Error) return error.message || fallbackKey;
  return fallbackKey;
}

/** Translate API error keys; leave plain strings untouched. */
export function translateApiError(t: (key: string, opts?: any) => string, error: string | null | undefined, opts?: Record<string, unknown>): string {
  if (!error) return "";
  if (/^[a-z][a-zA-Z0-9_.]*$/.test(error)) return t(error, opts);
  return error;
}
