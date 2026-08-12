import { FormEvent, ReactNode, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";

import {
  api,
  clearFrameToken,
  Frame,
  getOrCreateDeviceKey,
  rememberFrameToken,
  rememberedFrameToken,
  User,
} from "./api";

const API_URL =
  import.meta.env.VITE_API_URL === undefined
    ? "http://localhost:8000"
    : import.meta.env.VITE_API_URL;

type PublicConfig = {
  default_immich_url: string;
  immich_server_name?: string;
  weather_configured?: boolean;
  weather_units?: string;
};

type ImmichSettings = {
  immich_url: string;
  api_key_configured: boolean;
  default_immich_url: string;
  immich_server_name?: string;
};

type ServerSettings = {
  default_immich_url: string;
  immich_server_name?: string;
  weather_api_key_configured: boolean;
  weather_units: "imperial" | "metric";
};

type SetupStart = {
  device_key: string;
  setup_code: string;
  expires_in_seconds: number;
  bound: boolean;
  frame_token: string | null;
  default_immich_url: string;
  immich_server_name?: string;
};

type SetupStatus = {
  setup_code: string;
  bound: boolean;
  frame_token: string | null;
  default_immich_url: string;
  immich_server_name?: string;
  device_name: string;
};

type SetupComplete = {
  frame_token: string;
  frame: Frame;
  user: User;
};

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

  if (response.status === 204) return undefined as T;
  return response.json();
}

function navigate(path: string, replace = false) {
  if (replace) window.history.replaceState({}, "", path);
  else window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  return path;
}

function ServerConnectionNote({ name }: { name?: string }) {
  return (
    <p className="muted setup-hint">
      Connecting to <strong>{name?.trim() || "Immich"}</strong>.
    </p>
  );
}

function SimpleHeader({
  eyebrow,
  title,
  user,
  onLogout,
}: {
  eyebrow: string;
  title: string;
  user?: User | null;
  onLogout?: () => void;
}) {
  return (
    <header>
      <div>
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {user && <p className="muted header-user">Signed in as {user.name || user.email}</p>}
      </div>
      {user && (
        <div className="section-actions">
          <button className="secondary" type="button" onClick={() => navigate("/")}>
            Frames
          </button>
          {user.is_admin && (
            <button className="secondary" type="button" onClick={() => navigate("/admin/users")}>
              Users
            </button>
          )}
          {onLogout && (
            <button className="secondary" type="button" onClick={onLogout}>
              Log out
            </button>
          )}
        </div>
      )}
    </header>
  );
}

function CentralLoginPage({ onLoggedIn }: { onLoggedIn: (user: User) => void }) {
  const [mode, setMode] = useState<"password" | "api-key">("password");
  const [serverName, setServerName] = useState("Immich");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    request<PublicConfig>("/api/config")
      .then((config) => setServerName(config.immich_server_name || "Immich"))
      .catch(() => undefined);
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user =
        mode === "password"
          ? await request<User>("/api/auth/login/password", {
              method: "POST",
              body: JSON.stringify({ email, password }),
            })
          : await request<User>("/api/auth/login/api-key", {
              method: "POST",
              body: JSON.stringify({ immich_api_key: apiKey }),
            });
      onLoggedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-shell narrow">
      <SimpleHeader eyebrow="IMMICH PHOTO FRAME" title="Sign in" />
      <section className="panel">
        <p className="muted">
          Sign in with your Immich account. The photo-frame administrator chooses the Immich server for everyone using this site.
        </p>
        <ServerConnectionNote name={serverName} />

        <div className="mode-tabs">
          <button type="button" className={mode === "password" ? "secondary active-tab" : "secondary"} onClick={() => setMode("password")}>
            Immich login
          </button>
          <button type="button" className={mode === "api-key" ? "secondary active-tab" : "secondary"} onClick={() => setMode("api-key")}>
            API key
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}

        <form className="form-grid" onSubmit={submit}>
          {mode === "password" ? (
            <>
              <label>
                Email
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </label>
              <label>
                Password
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
            </>
          ) : (
            <label>
              API key
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="Paste a dedicated Immich API key" required />
            </label>
          )}
          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="muted setup-hint">
          Setting up a new Raspberry Pi? <a href="/setup">Open device setup</a>.
        </p>
      </section>
    </div>
  );
}

function CentralAccountPage({
  user,
  onLogout,
  onUserChange,
}: {
  user: User;
  onLogout: () => void;
  onUserChange: (user: User) => void;
}) {
  const [serverName, setServerName] = useState("Immich");
  const [apiKey, setApiKey] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(user.api_key_configured);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    request<ImmichSettings>("/api/me/immich")
      .then((settings) => {
        setServerName(settings.immich_server_name || "Immich");
        setKeyConfigured(settings.api_key_configured);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await request<ImmichSettings>("/api/me/immich", {
        method: "PUT",
        body: JSON.stringify({ immich_api_key: apiKey }),
      });
      await request<{ ok: boolean }>("/api/me/immich/test", { method: "POST" });
      setApiKey("");
      setKeyConfigured(saved.api_key_configured);
      setServerName(saved.immich_server_name || serverName);
      onUserChange({ ...user, immich_url: saved.immich_url, api_key_configured: saved.api_key_configured });
      setMessage(`Immich API key saved and tested against ${saved.immich_server_name || serverName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-shell">
      <SimpleHeader eyebrow="YOUR ACCOUNT" title="Account" user={user} onLogout={onLogout} />
      <main className="admin-stack">
        <section className="panel">
          <h2>Immich account</h2>
          <p className="muted">
            Add or rotate the personal Immich API key used to load photos for your frames. The server address is managed by an administrator.
          </p>
          <ServerConnectionNote name={serverName} />
          {keyConfigured && <p className="field-hint">An API key is already saved for this account.</p>}
          {(message || error) && <div className={error ? "notice error" : "notice"}>{error || message}</div>}
          <form className="form-grid two-column" onSubmit={save}>
            <label className="span-2">
              API key
              <input
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder={keyConfigured ? "Paste a new key to rotate" : "Paste your Immich API key"}
                required
              />
            </label>
            <div className="span-2 form-actions-row">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save Immich API key"}
              </button>
              <button className="secondary" type="button" onClick={() => navigate("/")}>Back to frames</button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

function CentralAdminSettingsPage({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [serverUrl, setServerUrl] = useState("");
  const [serverName, setServerName] = useState("Immich");
  const [weatherKey, setWeatherKey] = useState("");
  const [weatherUnits, setWeatherUnits] = useState<"imperial" | "metric">("imperial");
  const [weatherConfigured, setWeatherConfigured] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    request<ServerSettings>("/api/server")
      .then((settings) => {
        setServerUrl(settings.default_immich_url);
        setServerName(settings.immich_server_name || "Immich");
        setWeatherConfigured(settings.weather_api_key_configured);
        setWeatherUnits(settings.weather_units);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  async function save(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");
    try {
      const saved = await request<ServerSettings>("/api/server", {
        method: "PUT",
        body: JSON.stringify({
          default_immich_url: serverUrl,
          immich_server_name: serverName,
          weather_api_key: weatherKey,
          weather_units: weatherUnits,
        }),
      });
      if (saved.weather_api_key_configured) {
        await request<{ ok: boolean }>("/api/server/weather/test", { method: "POST" });
      }
      setServerUrl(saved.default_immich_url);
      setServerName(saved.immich_server_name || "Immich");
      setWeatherConfigured(saved.weather_api_key_configured);
      setWeatherUnits(saved.weather_units);
      setWeatherKey("");
      setMessage("Server settings saved. All users now connect through this Immich server.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="admin-shell">
      <SimpleHeader eyebrow="SERVER ADMIN" title="Settings" user={user} onLogout={onLogout} />
      {(message || error) && <div className={error ? "notice error" : "notice"}>{error || message}</div>}
      <main className="admin-stack">
        <section className="panel">
          <h2>Immich server</h2>
          <p className="muted">
            This is the single Immich instance used by every account and frame. Users see the descriptive name when they sign in or pair a device; they never choose the server URL themselves.
          </p>
          <form className="form-grid two-column" onSubmit={save}>
            <label>
              Display name
              <input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="Family Photos" required />
              <span className="field-hint">For example: Family Photos, Rockow Immich, or Home Photos.</span>
            </label>
            <label>
              Immich server address
              <input value={serverUrl} onChange={(event) => setServerUrl(event.target.value)} placeholder="http://192.168.1.224:2283" required />
              <span className="field-hint">Internal server address used by the photo-frame backend for every Immich request.</span>
            </label>
            <label>
              OpenWeather API key
              <input type="password" value={weatherKey} onChange={(event) => setWeatherKey(event.target.value)} placeholder={weatherConfigured ? "Paste a new key to rotate" : "Paste your OpenWeather API key"} />
            </label>
            <label>
              Units
              <select value={weatherUnits} onChange={(event) => setWeatherUnits(event.target.value as "imperial" | "metric")}>
                <option value="imperial">Fahrenheit</option>
                <option value="metric">Celsius</option>
              </select>
            </label>
            <div className="span-2">
              <button className="primary" type="submit">Save server settings</button>
            </div>
          </form>
        </section>
      </main>
    </div>
  );
}

function CentralSetupPage() {
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = (params.get("code") || "").toUpperCase();
  const [deviceKey] = useState(() => getOrCreateDeviceKey());
  const [setupCode, setSetupCode] = useState(codeFromUrl);
  const [serverName, setServerName] = useState("Immich");
  const [mode, setMode] = useState<"password" | "api-key">("password");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [frameName, setFrameName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phoneMode] = useState(Boolean(codeFromUrl));

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      try {
        if (codeFromUrl) {
          const status = await request<SetupStatus>(`/api/setup/${encodeURIComponent(codeFromUrl)}`);
          if (!active) return;
          setSetupCode(status.setup_code);
          setServerName(status.immich_server_name || "Immich");
          if (status.bound && status.frame_token) {
            rememberFrameToken(status.frame_token);
            navigate("/frame", true);
          }
          return;
        }

        const remembered = rememberedFrameToken();
        if (remembered) {
          try {
            await api.kiosk(remembered);
            navigate("/frame", true);
            return;
          } catch {
            clearFrameToken();
          }
        }

        const started = await request<SetupStart>("/api/setup/start", {
          method: "POST",
          body: JSON.stringify({ device_key: deviceKey, name: "Photo Frame" }),
        });
        if (!active) return;
        setSetupCode(started.setup_code);
        setServerName(started.immich_server_name || "Immich");
        if (started.bound && started.frame_token) {
          rememberFrameToken(started.frame_token);
          navigate("/frame", true);
        }
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    }
    void bootstrap();
    return () => {
      active = false;
    };
  }, [codeFromUrl, deviceKey]);

  useEffect(() => {
    if (phoneMode || !setupCode) return;
    const timer = window.setInterval(async () => {
      try {
        const status = await api.deviceStatus(deviceKey);
        if (status.bound && status.frame_token) {
          rememberFrameToken(status.frame_token);
          navigate("/frame", true);
        }
      } catch {
        // Keep polling while setup is in progress.
      }
    }, 3000);
    return () => window.clearInterval(timer);
  }, [deviceKey, phoneMode, setupCode]);

  const phoneUrl = `${window.location.origin}/setup?code=${setupCode}`;

  async function complete(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const result =
        mode === "password"
          ? await request<SetupComplete>("/api/setup/complete/password", {
              method: "POST",
              body: JSON.stringify({
                setup_code: setupCode,
                email,
                password,
                frame_name: frameName.trim() || undefined,
              }),
            })
          : await request<SetupComplete>("/api/setup/complete/api-key", {
              method: "POST",
              body: JSON.stringify({
                setup_code: setupCode,
                immich_api_key: apiKey,
                frame_name: frameName.trim() || undefined,
              }),
            });
      rememberFrameToken(result.frame_token);
      if (phoneMode) navigate(`/frames/${result.frame.id}`, true);
      else navigate("/frame", true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="setup-shell">
      <section className="panel setup-panel">
        <span className="eyebrow">DEVICE SETUP</span>
        <h1>Connect this frame</h1>
        <p className="muted">
          Sign in with your Immich account to link this device. You&apos;ll choose photos and overlays next.
        </p>
        <ServerConnectionNote name={serverName} />

        {setupCode && !phoneMode && (
          <div className="setup-code-block">
            <div className="setup-qr-card">
              <QRCodeSVG value={phoneUrl} size={220} level="M" includeMargin bgColor="#ffffff" fgColor="#0b0d10" />
              <p className="muted setup-qr-caption">Scan with your phone to finish setup more easily</p>
            </div>
            <div className="setup-code-details">
              <div>
                <div className="muted">Setup code</div>
                <div className="setup-code">{setupCode}</div>
              </div>
              <div>
                <div className="muted">Or open this link on your phone</div>
                <code className="phone-url">{phoneUrl}</code>
              </div>
            </div>
          </div>
        )}

        {error && <div className="notice error">{error}</div>}

        <div className="mode-tabs">
          <button type="button" className={mode === "password" ? "secondary active-tab" : "secondary"} onClick={() => setMode("password")}>
            Immich login
          </button>
          <button type="button" className={mode === "api-key" ? "secondary active-tab" : "secondary"} onClick={() => setMode("api-key")}>
            API key
          </button>
        </div>

        <form className="form-grid" onSubmit={complete}>
          <label>
            Frame name
            <input value={frameName} onChange={(event) => setFrameName(event.target.value)} placeholder="Leave blank for Firstname's Frame" />
          </label>
          {mode === "password" ? (
            <>
              <label>
                Email
                <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
              </label>
              <label>
                Password
                <input type="password" value={password} onChange={(event) => setPassword(event.target.value)} required />
              </label>
            </>
          ) : (
            <label>
              API key
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} required />
            </label>
          )}
          <button className="primary" type="submit" disabled={busy || !setupCode}>
            {busy ? "Connecting…" : phoneMode ? "Connect and continue setup" : "Connect this device"}
          </button>
        </form>
      </section>
    </div>
  );
}

export default function ConnectionRouter({ children }: { children: ReactNode }) {
  const path = usePath();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (path === "/setup" || path === "/setup/" || path.startsWith("/frame")) {
      setLoading(false);
      return;
    }
    setLoading(true);
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, [path]);

  if (path === "/setup" || path === "/setup/") return <CentralSetupPage />;
  if (path.startsWith("/frame")) return <>{children}</>;
  if (loading) return <div className="kiosk-message"><div><h1>Loading…</h1></div></div>;
  if (!user) return <CentralLoginPage onLoggedIn={setUser} />;

  const logout = () => {
    void api.logout().finally(() => {
      setUser(null);
      navigate("/", true);
    });
  };

  if (path === "/account" || path === "/account/") {
    return <CentralAccountPage user={user} onLogout={logout} onUserChange={setUser} />;
  }
  if (path === "/admin" || path === "/admin/" || path === "/admin/settings" || path === "/admin/settings/") {
    if (!user.is_admin) {
      navigate("/", true);
      return <>{children}</>;
    }
    return <CentralAdminSettingsPage user={user} onLogout={logout} />;
  }

  return <>{children}</>;
}
