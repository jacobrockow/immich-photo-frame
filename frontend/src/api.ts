// Empty string = same-origin (production behind Nginx). Only fall back when unset.
export const API_URL =
  import.meta.env.VITE_API_URL === undefined
    ? "http://localhost:8000"
    : import.meta.env.VITE_API_URL;

export type Album = {
  id: string;
  albumName: string;
  assetCount: number;
};

export type PhotoSource =
  | { type: "library" }
  | { type: "album"; album_id: string };

export type OverlayCorner =
  | "top-left"
  | "top-right"
  | "bottom-left"
  | "bottom-right";

export type OverlayScale =
  | "xsmall"
  | "small"
  | "medium"
  | "large"
  | "xlarge"
  | "huge"
  | "quarter";

export type OverlayFont =
  | "sans"
  | "serif"
  | "rounded"
  | "mono"
  | "display"
  | "script"
  | "slab"
  | "pixel"
  | "hand"
  | "condensed"
  | "segment";

export type OverlayTextColor = "white" | "warm" | "amber" | "mint" | "soft";
export type OverlayContrast = "none" | "soft" | "heavy" | "pill" | "bar";

export type OverlaySettings = {
  clock_corner: OverlayCorner;
  photo_meta_corner: OverlayCorner;
  weather_corner: OverlayCorner;
  clock_format: "12h" | "24h";
  clock_show_seconds: boolean;
  clock_date_format: "long" | "short" | "weekday" | "none";
  photo_date_format: "long" | "short" | "numeric";
  clock_scale: OverlayScale;
  photo_meta_scale: OverlayScale;
  weather_scale: OverlayScale;
  font: OverlayFont;
  text_color: OverlayTextColor;
  contrast: OverlayContrast;
  /** 40–100 percent text/icon opacity. */
  opacity: number;
  /** 0–100 percent pill/bar background opacity. */
  scrim_opacity: number;
};

export const defaultOverlay: OverlaySettings = {
  clock_corner: "top-right",
  photo_meta_corner: "bottom-left",
  weather_corner: "bottom-right",
  clock_format: "12h",
  clock_show_seconds: false,
  clock_date_format: "long",
  photo_date_format: "long",
  clock_scale: "medium",
  photo_meta_scale: "medium",
  weather_scale: "medium",
  font: "sans",
  text_color: "white",
  contrast: "soft",
  opacity: 100,
  scrim_opacity: 50,
};

export const OVERLAY_SCALE_OPTIONS: { value: OverlayScale; label: string }[] = [
  { value: "xsmall", label: "Extra small" },
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
  { value: "xlarge", label: "Extra large" },
  { value: "huge", label: "Huge" },
  { value: "quarter", label: "Quarter screen" },
];

export type PersonRef = {
  id: string;
  name: string;
};

export type ContextFilters = {
  exclude_people: PersonRef[];
  prefer_people: PersonRef[];
  prefer_strength: number;
};

export const defaultContext: ContextFilters = {
  exclude_people: [],
  prefer_people: [],
  prefer_strength: 3,
};

export type SlideshowSettings = {
  transition: "none" | "fade" | "crossfade";
  transition_speed: "fast" | "medium" | "slow";
  pan: "off" | "subtle" | "medium";
  backdrop: "black" | "blur" | "glow";
};

export const defaultSlideshow: SlideshowSettings = {
  transition: "fade",
  transition_speed: "medium",
  pan: "subtle",
  backdrop: "blur",
};

export type Person = {
  id: string;
  name: string;
  is_hidden?: boolean;
  thumbnail_path?: string | null;
};

export type Frame = {
  id: number;
  name: string;
  token: string;
  source: PhotoSource;
  interval_seconds: number;
  image_fit: "contain" | "cover";
  show_clock: boolean;
  show_photo_date: boolean;
  show_photo_location: boolean;
  show_weather: boolean;
  weather_location: string | null;
  /** Opt-in Immich write-backs (rotate / archive) from the kiosk. */
  allow_photo_actions: boolean;
  /** 0 = off … 5 = mostly seasonal. Default 3 ≈ former “on”. */
  seasonal_strength: number;
  overlay: OverlaySettings;
  context: ContextFilters;
  slideshow: SlideshowSettings;
  /** False until settings are saved once (device setup waiting room). */
  configured?: boolean;
  owner_user_id?: number | null;
  owner_email?: string | null;
  owner_name?: string | null;
};

function framePayload(frame: Omit<Frame, "id" | "token"> | Frame) {
  const context = { ...defaultContext, ...(frame.context || {}) };
  return {
    name: frame.name,
    source: frame.source,
    interval_seconds: frame.interval_seconds,
    image_fit: frame.image_fit,
    show_clock: frame.show_clock,
    show_photo_date: frame.show_photo_date,
    show_photo_location: frame.show_photo_location,
    show_weather: frame.show_weather,
    weather_location: frame.weather_location,
    allow_photo_actions: Boolean(frame.allow_photo_actions),
    seasonal_strength: Math.max(
      0,
      Math.min(5, Number(frame.seasonal_strength ?? 3)),
    ),
    overlay: (() => {
      const raw = (frame.overlay || {}) as Partial<OverlaySettings> & {
        scale?: OverlayScale;
      };
      const legacy = raw.scale;
      return {
        ...defaultOverlay,
        ...raw,
        clock_scale: raw.clock_scale || legacy || defaultOverlay.clock_scale,
        photo_meta_scale:
          raw.photo_meta_scale || legacy || defaultOverlay.photo_meta_scale,
        weather_scale:
          raw.weather_scale || legacy || defaultOverlay.weather_scale,
        opacity: Math.max(
          40,
          Math.min(100, Number(raw.opacity ?? defaultOverlay.opacity)),
        ),
        scrim_opacity: Math.max(
          0,
          Math.min(
            100,
            Number(raw.scrim_opacity ?? defaultOverlay.scrim_opacity),
          ),
        ),
      };
    })(),
    context: {
      exclude_people: context.exclude_people || [],
      prefer_people: context.prefer_people || [],
      prefer_strength: Math.max(
        0,
        Math.min(5, Number(context.prefer_strength ?? 3)),
      ),
    },
    slideshow: { ...defaultSlideshow, ...(frame.slideshow || {}) },
  };
}

export type Asset = {
  id: string;
  type?: string | null;
  fileCreatedAt?: string | null;
  localDateTime?: string | null;
  originalFileName?: string | null;
  location?: string | null;
  city?: string | null;
  state?: string | null;
  country?: string | null;
};

export type Weather = {
  location_label: string;
  temperature: number;
  units: string;
  description: string;
  icon?: string | null;
  fetched_at?: string | null;
};

export type WeatherSettings = {
  api_key_configured: boolean;
  weather_units: "imperial" | "metric";
};

export type ServerSettings = {
  default_immich_url: string;
  weather_api_key_configured: boolean;
  weather_units: "imperial" | "metric";
};

export type KioskConfig = {
  frame: Frame;
  assets: Asset[];
  asset_count?: number;
  truncated?: boolean;
  weather?: Weather | null;
};

export type User = {
  id: number;
  email: string;
  name: string;
  immich_url: string;
  api_key_configured: boolean;
  is_admin?: boolean;
};

export type AdminUser = {
  id: number;
  email: string;
  name: string;
  immich_url: string;
  api_key_configured: boolean;
  is_admin: boolean;
  frame_count: number;
  created_at?: string | null;
};

export type ImmichSettings = {
  immich_url: string;
  api_key_configured: boolean;
  default_immich_url: string;
};

const FRAME_TOKEN_HEADER = "X-Frame-Token";

function frameAuthHeaders(token: string): HeadersInit {
  return { [FRAME_TOKEN_HEADER]: token };
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const { headers: optionHeaders, ...rest } = options || {};
  const response = await fetch(`${API_URL}${path}`, {
    credentials: "include",
    ...rest,
    headers: {
      "Content-Type": "application/json",
      ...(optionHeaders || {}),
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    const detail = body?.detail;
    const message =
      typeof detail === "string"
        ? detail
        : Array.isArray(detail)
          ? detail.map((item) => item.msg || JSON.stringify(item)).join(", ")
          : `HTTP ${response.status}`;
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return response.json();
}

function kioskMediaUrl(path: string, token: string): string {
  const url = new URL(path, API_URL || window.location.origin);
  url.searchParams.set("frame_token", token);
  return url.toString();
}

export const api = {
  publicConfig: () =>
    request<{
      default_immich_url: string;
      weather_configured?: boolean;
      weather_units?: string;
    }>("/api/config"),

  getServerSettings: () => request<ServerSettings>("/api/server"),

  saveServerSettings: (payload: {
    default_immich_url?: string;
    weather_api_key?: string;
    weather_units?: "imperial" | "metric";
  }) =>
    request<ServerSettings>("/api/server", {
      method: "PUT",
      body: JSON.stringify(payload),
    }),

  getWeatherSettings: () => request<WeatherSettings>("/api/server/weather"),

  saveWeatherSettings: (weather_api_key: string, weather_units: "imperial" | "metric") =>
    request<WeatherSettings>("/api/server/weather", {
      method: "PUT",
      body: JSON.stringify({ weather_api_key, weather_units }),
    }),

  testWeather: () =>
    request<{ ok: boolean }>("/api/server/weather/test", { method: "POST" }),

  me: () => request<User>("/api/auth/me"),

  loginPassword: (immich_url: string, email: string, password: string) =>
    request<User>("/api/auth/login/password", {
      method: "POST",
      body: JSON.stringify({ immich_url, email, password }),
    }),

  loginApiKey: (immich_url: string, immich_api_key: string) =>
    request<User>("/api/auth/login/api-key", {
      method: "POST",
      body: JSON.stringify({ immich_url, immich_api_key }),
    }),

  logout: () => request<void>("/api/auth/logout", { method: "POST" }),

  getImmichSettings: () => request<ImmichSettings>("/api/me/immich"),

  saveImmichSettings: (immich_url: string, immich_api_key: string) =>
    request<ImmichSettings>("/api/me/immich", {
      method: "PUT",
      body: JSON.stringify({ immich_url, immich_api_key }),
    }),

  testImmich: () =>
    request<{ ok: boolean }>("/api/me/immich/test", { method: "POST" }),

  albums: () => request<Album[]>("/api/albums"),

  people: () => request<Person[]>("/api/people"),

  personThumbnailUrl: (personId: string) =>
    `${API_URL}/api/people/${encodeURIComponent(personId)}/thumbnail`,

  frameAlbums: (frameId: number) =>
    request<Album[]>(`/api/frames/${frameId}/albums`),

  framePeople: (frameId: number) =>
    request<Person[]>(`/api/frames/${frameId}/people`),

  framePersonThumbnailUrl: (frameId: number, personId: string) =>
    `${API_URL}/api/frames/${frameId}/people/${encodeURIComponent(personId)}/thumbnail`,

  adminUsers: () => request<AdminUser[]>("/api/admin/users"),

  adminUpdateUser: (userId: number, payload: { is_admin?: boolean }) =>
    request<AdminUser>(`/api/admin/users/${userId}`, {
      method: "PATCH",
      body: JSON.stringify(payload),
    }),

  adminFrames: () => request<Frame[]>("/api/admin/frames"),

  frames: () => request<Frame[]>("/api/frames"),

  createFrame: (frame: Omit<Frame, "id" | "token">) =>
    request<Frame>("/api/frames", {
      method: "POST",
      body: JSON.stringify(framePayload(frame)),
    }),

  updateFrame: (frame: Frame) =>
    request<Frame>(`/api/frames/${frame.id}`, {
      method: "PUT",
      body: JSON.stringify(framePayload(frame)),
    }),

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
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  setupCompleteApiKey: (payload: {
    setup_code: string;
    immich_url: string;
    immich_api_key: string;
    frame_name?: string;
  }) =>
    request<{ frame_token: string; frame: Frame; user: User }>(
      "/api/setup/complete/api-key",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    ),

  kiosk: (token: string) =>
    request<KioskConfig>("/api/kiosk", {
      headers: frameAuthHeaders(token),
    }),

  kioskAlbums: (token: string) =>
    request<Album[]>("/api/kiosk/albums", {
      headers: frameAuthHeaders(token),
    }),

  kioskPeople: (token: string) =>
    request<Person[]>("/api/kiosk/people", {
      headers: frameAuthHeaders(token),
    }),

  kioskPersonThumbnailUrl: (token: string, personId: string) =>
    kioskMediaUrl(
      `/api/kiosk/people/${encodeURIComponent(personId)}/thumbnail`,
      token,
    ),

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
      {
        method: "POST",
        headers: frameAuthHeaders(token),
      },
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
  const created =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `device-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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
