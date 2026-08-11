const API_BASE = import.meta.env.VITE_API_URL ?? "";

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    let detail = response.statusText;
    try {
      const body = await response.json();
      detail = body.detail ?? detail;
    } catch {
      // Keep HTTP status text.
    }
    throw new Error(detail || `Request failed (${response.status})`);
  }

  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

export type User = {
  id: number;
  email: string;
  name: string;
  immich_url: string;
  api_key_configured: boolean;
  is_admin: boolean;
};

export type Frame = Record<string, any>;
export type Album = Record<string, any>;
export type Person = Record<string, any>;
export type KioskConfig = Record<string, any>;

function frameAuthHeaders(token: string): Record<string, string> {
  return { "X-Frame-Token": token };
}

function kioskMediaUrl(path: string, token: string): string {
  const separator = path.includes("?") ? "&" : "?";
  return `${API_BASE}${path}${separator}frame_token=${encodeURIComponent(token)}`;
}

function framePayload(frame: any): any {
  return frame;
}

export const api = {
  deleteFrame: (frameId: number) =>
    request<void>(`/api/frames/${frameId}`, { method: "DELETE" }),

  setupStart: (device_key: string, name = "Photo Frame") =>
    request<{
      device_key: string;
      setup_code: string;
      expires_in_seconds: number;
      bound: boolean;
      frame_token: string | null;
      default_immich_url: string;
    }>("/api/setup/start", {
      method: "POST",
      body: JSON.stringify({ device_key, name }),
    }),

  setupStatus: (setup_code: string) =>
    request<{
      setup_code: string;
      bound: boolean;
      frame_token: string | null;
      default_immich_url: string;
      device_name: string;
    }>(`/api/setup/${encodeURIComponent(setup_code)}`),

  deviceStatus: (device_key: string) =>
    request<{
      device_key: string;
      bound: boolean;
      frame_token: string | null;
      frame: Frame | null;
    }>(`/api/devices/${encodeURIComponent(device_key)}`),

  setupCompletePassword: (payload: {
    setup_code: string;
    immich_url?: string;
    email: string;
    password: string;
    frame_name?: string;
  }) =>
    request<{ frame_token: string; frame: Frame; user: User }>(
      "/api/setup/complete/password",
      { method: "POST", body: JSON.stringify(payload) },
    ),

  setupCompleteApiKey: (payload: {
    setup_code: string;
    immich_url: string;
    immich_api_key: string;
    frame_name?: string;
  }) =>
    request<{ frame_token: string; frame: Frame; user: User }>(
      "/api/setup/complete/api-key",
      { method: "POST", body: JSON.stringify(payload) },
    ),

  kiosk: (token: string) =>
    request<KioskConfig>("/api/kiosk", { headers: frameAuthHeaders(token) }),

  kioskAlbums: (token: string) =>
    request<Album[]>("/api/kiosk/albums", { headers: frameAuthHeaders(token) }),

  kioskPeople: (token: string) =>
    request<Person[]>("/api/kiosk/people", { headers: frameAuthHeaders(token) }),

  kioskPersonThumbnailUrl: (token: string, personId: string) =>
    kioskMediaUrl(`/api/kiosk/people/${encodeURIComponent(personId)}/thumbnail`, token),

  kioskUpdateFrame: (token: string, frame: Omit<Frame, "id" | "token"> | Frame) =>
    request<Frame>("/api/kiosk", {
      method: "PUT",
      headers: frameAuthHeaders(token),
      body: JSON.stringify(framePayload(frame)),
    }),

  kioskAssetUrl: (token: string, assetId: string) =>
    kioskMediaUrl(`/api/kiosk/asset/${encodeURIComponent(assetId)}`, token),

  kioskArchiveAsset: (token: string, assetId: string) =>
    request<{ ok: boolean; asset_id: string; action: string }>(
      `/api/kiosk/assets/${encodeURIComponent(assetId)}/archive`,
      { method: "POST", headers: frameAuthHeaders(token) },
    ),

  kioskRotateAsset: (token: string, assetId: string, degrees: 90 | -90) =>
    request<{
      ok: boolean;
      asset_id: string;
      action: string;
      degrees: number;
      angle?: number;
    }>(`/api/kiosk/assets/${encodeURIComponent(assetId)}/rotate`, {
      method: "POST",
      headers: frameAuthHeaders(token),
      body: JSON.stringify({ degrees }),
    }),
};

export function getOrCreateDeviceKey(): string {
  const keyName = "photoframe_device_key";
  const existing = localStorage.getItem(keyName);
  if (existing) return existing;

  if (typeof crypto === "undefined" || typeof crypto.getRandomValues !== "function") {
    throw new Error("Secure random number generation is unavailable in this browser");
  }

  const created =
    typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
          byte.toString(16).padStart(2, "0"),
        ).join("");
  localStorage.setItem(keyName, created);
  return created;
}

export function rememberFrameToken(token: string) {
  localStorage.setItem("photoframe_frame_token", token);
}

export function rememberedFrameToken(): string | null {
  return localStorage.getItem("photoframe_frame_token");
}

export function clearFrameToken() {
  localStorage.removeItem("photoframe_frame_token");
}
