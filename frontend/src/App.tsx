import {
  CSSProperties,
  FormEvent,
  PointerEvent,
  ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Album,
  api,
  Asset,
  ContextFilters,
  defaultContext,
  defaultOverlay,
  defaultSlideshow,
  Frame,
  getOrCreateDeviceKey,
  KioskConfig,
  OverlayCorner,
  OverlayScale,
  OverlaySettings,
  OVERLAY_FONT_OPTIONS,
  OVERLAY_SCALE_OPTIONS,
  Person,
  PersonRef,
  PhotoSource,
  clearFrameToken,
  rememberFrameToken,
  rememberedFrameToken,
  AdminUser,
  ServerSettings,
  SlideshowSettings,
  User,
  Weather,
} from "./api";
import {
  advancePlaylist,
  buildPlaylist,
  retreatPlaylist,
} from "./playlist";

function defaultFrameName(user: { name?: string; email?: string }): string {
  const raw = (user.name || "").trim() || (user.email || "").split("@")[0].trim();
  const first = raw.split(/\s+/)[0] || "My";
  return `${first}'s Frame`;
}

const emptyFrame: Omit<Frame, "id" | "token"> = {
  name: "My Frame",
  source: { type: "library" },
  interval_seconds: 15,
  image_fit: "contain",
  show_clock: true,
  show_photo_date: true,
  show_photo_location: true,
  show_weather: false,
  weather_location: null,
  allow_photo_actions: false,
  seasonal_strength: 3,
  overlay: { ...defaultOverlay },
  context: { ...defaultContext },
  slideshow: { ...defaultSlideshow },
  configured: false,
};

const SEASONAL_STRENGTH_LABELS = [
  "Off",
  "Subtle",
  "Light",
  "Balanced",
  "Strong",
  "Mostly seasonal",
] as const;

type DisplayPlacement = OverlayCorner | "hidden";

const PLACEMENT_OPTIONS: { value: DisplayPlacement; label: string }[] = [
  { value: "top-left", label: "Top left" },
  { value: "top-right", label: "Top right" },
  { value: "bottom-left", label: "Bottom left" },
  { value: "bottom-right", label: "Bottom right" },
  { value: "hidden", label: "Don't display" },
];

function frameOverlay(frame: Pick<Frame, "overlay"> | Frame): OverlaySettings {
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
    weather_scale: raw.weather_scale || legacy || defaultOverlay.weather_scale,
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
}

function ScaleSelect({
  value,
  onChange,
}: {
  value: OverlayScale;
  onChange: (value: OverlayScale) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as OverlayScale)}
    >
      {OVERLAY_SCALE_OPTIONS.map((option) => (
        <option value={option.value} key={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

function withOverlay(
  frame: Frame,
  patch: Partial<OverlaySettings>,
): Frame {
  return {
    ...frame,
    overlay: { ...frameOverlay(frame), ...patch },
  };
}

function frameContext(frame: Pick<Frame, "context"> | Frame): ContextFilters {
  const context = { ...defaultContext, ...(frame.context || {}) };
  return {
    exclude_people: context.exclude_people || [],
    prefer_people: context.prefer_people || [],
    prefer_strength: Math.max(
      0,
      Math.min(5, Number(context.prefer_strength ?? 3)),
    ),
  };
}

function withContext(frame: Frame, patch: Partial<ContextFilters>): Frame {
  return {
    ...frame,
    context: { ...frameContext(frame), ...patch },
  };
}

function frameSlideshow(
  frame: Pick<Frame, "slideshow"> | Frame,
): SlideshowSettings {
  return { ...defaultSlideshow, ...(frame.slideshow || {}) };
}

function withSlideshow(
  frame: Frame,
  patch: Partial<SlideshowSettings>,
): Frame {
  return {
    ...frame,
    slideshow: { ...frameSlideshow(frame), ...patch },
  };
}

function normalizeFrame(frame: Frame): Frame {
  const legacy = frame as Frame & { seasonal_weighting?: boolean };
  const strength =
    typeof frame.seasonal_strength === "number"
      ? frame.seasonal_strength
      : legacy.seasonal_weighting === false
        ? 0
        : 3;
  return {
    ...frame,
    allow_photo_actions: Boolean(frame.allow_photo_actions),
    configured: frame.configured !== false,
    seasonal_strength: Math.max(0, Math.min(5, strength)),
    overlay: frameOverlay(frame),
    context: frameContext(frame),
    slideshow: frameSlideshow(frame),
  };
}

const TRANSITION_MS: Record<SlideshowSettings["transition_speed"], number> = {
  fast: 450,
  medium: 900,
  slow: 1500,
};

type PersonMode = "off" | "exclude" | "prefer";

function personMode(context: ContextFilters, personId: string): PersonMode {
  if (context.exclude_people.some((person) => person.id === personId)) {
    return "exclude";
  }
  if (context.prefer_people.some((person) => person.id === personId)) {
    return "prefer";
  }
  return "off";
}

function placementSelect(
  value: DisplayPlacement,
  onChange: (value: DisplayPlacement) => void,
) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as DisplayPlacement)}
    >
      {PLACEMENT_OPTIONS.map((option) => (
        <option value={option.value} key={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
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

function navigate(path: string, replace = false) {
  if (replace) {
    window.history.replaceState({}, "", path);
  } else {
    window.history.pushState({}, "", path);
  }
  window.dispatchEvent(new PopStateEvent("popstate"));
}

type ControlView =
  | { kind: "frames" }
  | { kind: "frame"; id: number }
  | { kind: "account" }
  | { kind: "admin-settings" }
  | { kind: "admin-users" };

function parseControlView(path: string): ControlView {
  if (path === "/account" || path === "/account/") return { kind: "account" };
  if (path === "/admin" || path === "/admin/" || path === "/admin/settings") {
    return { kind: "admin-settings" };
  }
  if (path === "/admin/users" || path === "/admin/users/") {
    return { kind: "admin-users" };
  }
  const frameMatch = path.match(/^\/frames\/(\d+)\/?$/);
  if (frameMatch) return { kind: "frame", id: Number(frameMatch[1]) };
  return { kind: "frames" };
}

function App() {
  const path = usePath();
  const tokenInPath = path.match(/^\/frame\/([^/]+)$/);
  const frameExact = path === "/frame" || path === "/frame/";
  const setupMatch = path.match(/^\/setup\/?$/);

  // Legacy / recovery: /frame/<token> → store locally and open opaque /frame
  if (tokenInPath) {
    return <ClaimFrameToken token={decodeURIComponent(tokenInPath[1])} />;
  }

  if (frameExact) {
    return <BoundKiosk />;
  }

  if (setupMatch) {
    return <SetupPage />;
  }

  return <ControlApp view={parseControlView(path)} />;
}

function ClaimFrameToken({ token }: { token: string }) {
  useEffect(() => {
    rememberFrameToken(token);
    navigate("/frame", true);
  }, [token]);

  return <KioskMessage title="Opening frame…" />;
}

function BoundKiosk() {
  const token = rememberedFrameToken();

  useEffect(() => {
    if (!token) {
      navigate("/setup", true);
    }
  }, [token]);

  if (!token) {
    return <KioskMessage title="Redirecting to setup…" />;
  }

  return <Kiosk token={token} />;
}

function ControlApp({ view }: { view: ControlView }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .me()
      .then(setUser)
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    if (
      (view.kind === "admin-settings" || view.kind === "admin-users") &&
      !user.is_admin
    ) {
      navigate("/", true);
    }
  }, [user, view]);

  if (loading) {
    return <KioskMessage title="Loading…" />;
  }

  if (!user) {
    return (
      <LoginPage
        onLoggedIn={setUser}
        error={error}
        setError={setError}
      />
    );
  }

  const onLogout = async () => {
    await api.logout().catch(() => undefined);
    setUser(null);
  };

  if (
    (view.kind === "admin-settings" || view.kind === "admin-users") &&
    !user.is_admin
  ) {
    return <FramesPage user={user} onLogout={onLogout} onUserChange={setUser} />;
  }

  if (view.kind === "admin-settings") {
    return <AdminSettingsPage user={user} onLogout={onLogout} />;
  }

  if (view.kind === "admin-users") {
    return (
      <AdminUsersPage
        user={user}
        onLogout={onLogout}
        onUserChange={setUser}
      />
    );
  }

  if (view.kind === "account") {
    return (
      <AccountPage user={user} onLogout={onLogout} onUserChange={setUser} />
    );
  }

  if (view.kind === "frame") {
    return (
      <FrameDetailPage
        frameId={view.id}
        user={user}
        onLogout={onLogout}
        onUserChange={setUser}
      />
    );
  }

  return (
    <FramesPage user={user} onLogout={onLogout} onUserChange={setUser} />
  );
}

function ControlShell({
  user,
  active,
  title,
  eyebrow,
  onLogout,
  children,
}: {
  user: User;
  active: "frames" | "account" | "admin-settings" | "admin-users";
  title: string;
  eyebrow: string;
  onLogout: () => Promise<void>;
  children: ReactNode;
}) {
  return (
    <div className="admin-shell">
      <header>
        <div>
          <span className="eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          <p className="muted header-user">
            Signed in as {user.name || user.email}
          </p>
        </div>
        <div className="section-actions">
          <nav className="control-nav" aria-label="Control pages">
            <a
              className={
                active === "frames"
                  ? "secondary button-link active-nav"
                  : "secondary button-link"
              }
              href="/"
              onClick={(event) => {
                event.preventDefault();
                navigate("/");
              }}
            >
              Frames
            </a>
            <a
              className={
                active === "account"
                  ? "secondary button-link active-nav"
                  : "secondary button-link"
              }
              href="/account"
              onClick={(event) => {
                event.preventDefault();
                navigate("/account");
              }}
            >
              Account
            </a>
            {user.is_admin && (
              <>
                <a
                  className={
                    active === "admin-settings"
                      ? "secondary button-link active-nav"
                      : "secondary button-link"
                  }
                  href="/admin/settings"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate("/admin/settings");
                  }}
                >
                  Settings
                </a>
                <a
                  className={
                    active === "admin-users"
                      ? "secondary button-link active-nav"
                      : "secondary button-link"
                  }
                  href="/admin/users"
                  onClick={(event) => {
                    event.preventDefault();
                    navigate("/admin/users");
                  }}
                >
                  Users
                </a>
              </>
            )}
          </nav>
          <button
            className="secondary"
            type="button"
            onClick={() => void onLogout()}
          >
            Log out
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

function LoginPage({
  onLoggedIn,
  error,
  setError,
}: {
  onLoggedIn: (user: User) => void;
  error: string;
  setError: (value: string) => void;
}) {
  const [mode, setMode] = useState<"password" | "api-key">("password");
  const [immichUrl, setImmichUrl] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.publicConfig().then((config) => {
      setImmichUrl(config.default_immich_url || "");
    });
  }, []);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      const user =
        mode === "password"
          ? await api.loginPassword(immichUrl, email, password)
          : await api.loginApiKey(immichUrl, apiKey);
      onLoggedIn(user);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="admin-shell narrow">
      <header>
        <div>
          <span className="eyebrow">IMMICH PHOTO FRAME</span>
          <h1>Sign in</h1>
        </div>
      </header>

      <section className="panel">
        <p className="muted">
          Connect with your Immich account. Frame settings stay on this server,
          so logging out later will not reset your frames.
        </p>

        <div className="mode-tabs">
          <button
            type="button"
            className={mode === "password" ? "secondary active-tab" : "secondary"}
            onClick={() => setMode("password")}
          >
            Immich login
          </button>
          <button
            type="button"
            className={mode === "api-key" ? "secondary active-tab" : "secondary"}
            onClick={() => setMode("api-key")}
          >
            API key
          </button>
        </div>

        {error && <div className="notice error">{error}</div>}

        <form className="form-grid" onSubmit={onSubmit}>
          <label>
            Immich URL
            <input
              value={immichUrl}
              onChange={(e) => setImmichUrl(e.target.value)}
                placeholder="https://immich.example.com"
              required
            />
          </label>

          {mode === "password" ? (
            <>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <label>
              API key
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste a dedicated Immich API key"
                required
              />
            </label>
          )}

          <button className="primary" type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="muted setup-hint">
          Setting up a new Raspberry Pi? Open{" "}
          <a href="/setup">/setup</a> on the device.
        </p>
      </section>
    </div>
  );
}

async function loadAccessibleFrames(user: User): Promise<Frame[]> {
  const list = user.is_admin ? await api.adminFrames() : await api.frames();
  return list.map(normalizeFrame);
}

function frameSourceLabel(frame: Frame): string {
  return frame.source.type === "library" ? "Entire library" : "Album";
}

function openFrameKiosk(frame: Frame) {
  rememberFrameToken(frame.token);
  window.open(
    `${window.location.origin}/frame`,
    "_blank",
    "noopener,noreferrer",
  );
}

function AccountPage({
  user,
  onLogout,
  onUserChange,
}: {
  user: User;
  onLogout: () => Promise<void>;
  onUserChange: (user: User) => void;
}) {
  const [immichUrl, setImmichUrl] = useState(user.immich_url || "");
  const [immichKey, setImmichKey] = useState("");
  const [defaultUrl, setDefaultUrl] = useState("");
  const [keyConfigured, setKeyConfigured] = useState(user.api_key_configured);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getImmichSettings()
      .then((settings) => {
        setImmichUrl(settings.immich_url || settings.default_immich_url || "");
        setDefaultUrl(settings.default_immich_url || "");
        setKeyConfigured(settings.api_key_configured);
      })
      .catch(() => undefined);
  }, []);

  async function saveImmich(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const saved = await api.saveImmichSettings(
        immichUrl || defaultUrl,
        immichKey,
      );
      await api.testImmich();
      setImmichKey("");
      setKeyConfigured(saved.api_key_configured);
      setImmichUrl(saved.immich_url);
      onUserChange({
        ...user,
        immich_url: saved.immich_url,
        api_key_configured: saved.api_key_configured,
      });
      setMessage("Immich API key saved and tested.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <ControlShell
      user={user}
      active="account"
      eyebrow="YOUR ACCOUNT"
      title="Account"
      onLogout={onLogout}
    >
      <main className="admin-stack">
        <section className="panel">
          <h2>Immich API key</h2>
          <p className="muted">
            Your personal Immich key for loading photos into your frames. The
            shared Immich server address is set by a server admin. Keys stay on
            this frame server — never on the Pis.
            {keyConfigured
              ? " A key is already saved for this account."
              : " Add a key so your frames can load photos."}
          </p>
          {(message || error) && (
            <div className={error ? "notice error" : "notice"}>
              {error || message}
            </div>
          )}
          <form className="form-grid two-column" onSubmit={saveImmich}>
            <label className="span-2">
              Immich server
              <input
                value={immichUrl}
                onChange={(e) => setImmichUrl(e.target.value)}
                placeholder={defaultUrl || "https://immich.example.com"}
              />
              <span className="field-hint">
                Usually the server default
                {defaultUrl ? ` (${defaultUrl})` : ""}. Change only if your
                account uses a different Immich URL.
              </span>
            </label>
            <label className="span-2">
              API key
              <input
                type="password"
                value={immichKey}
                onChange={(e) => setImmichKey(e.target.value)}
                placeholder={
                  keyConfigured
                    ? "Paste a new key to rotate"
                    : "Paste your Immich API key"
                }
                required
              />
            </label>
            <div className="span-2 form-actions-row">
              <button className="primary" type="submit" disabled={busy}>
                {busy ? "Saving…" : "Save Immich API key"}
              </button>
              <button
                className="secondary"
                type="button"
                onClick={() => navigate("/")}
              >
                Back to frames
              </button>
            </div>
          </form>
        </section>
      </main>
    </ControlShell>
  );
}

function FramesPage({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => Promise<void>;
  onUserChange?: (user: User) => void;
}) {
  const [frames, setFrames] = useState<Frame[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function refreshFrames() {
    setFrames(await loadAccessibleFrames(user));
  }

  useEffect(() => {
    setLoading(true);
    loadAccessibleFrames(user)
      .then(setFrames)
      .catch((err) => setError(String(err)))
      .finally(() => setLoading(false));
  }, [user.is_admin, user.id]);

  async function addFrame() {
    try {
      const frame = await api.createFrame({
        ...emptyFrame,
        name: defaultFrameName(user),
      });
      await refreshFrames();
      setMessage("Frame created.");
      setError("");
      navigate(`/frames/${frame.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function deleteFrame(frame: Frame) {
    const ownerBit =
      user.is_admin && frame.owner_user_id !== user.id
        ? ` (owned by ${frame.owner_name || frame.owner_email || "another user"})`
        : "";
    const confirmed = window.confirm(
      `Delete “${frame.name}”${ownerBit}? Bound devices will need setup again. Photos in Immich are not affected.`,
    );
    if (!confirmed) return;

    try {
      await api.deleteFrame(frame.id);
      setFrames((current) => current.filter((item) => item.id !== frame.id));
      setMessage(`Deleted “${frame.name}”.`);
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ControlShell
      user={user}
      active="frames"
      eyebrow="IMMICH PHOTO FRAME"
      title="Frames"
      onLogout={onLogout}
    >
      {(message || error) && (
        <div className={error ? "notice error" : "notice"}>
          {error || message}
        </div>
      )}

      <main className="frames-home">
        <section className="frames-toolbar">
          <div>
            <h2>{user.is_admin ? "All frames" : "Your frames"}</h2>
            <p className="muted">
              {user.is_admin
                ? "Open any frame to change its settings. End users only see their own frames."
                : "Create frames, open the kiosk preview, or dive into settings."}
            </p>
          </div>
          <div className="frames-toolbar-actions">
            <button className="primary" type="button" onClick={addFrame}>
              + New frame
            </button>
          </div>
        </section>

        {!user.api_key_configured && (
          <section className="notice frames-banner">
            Connect your Immich API key so frames can load photos.{" "}
            <a
              href="/account"
              onClick={(event) => {
                event.preventDefault();
                navigate("/account");
              }}
            >
              Open account settings
            </a>
          </section>
        )}

        {loading ? (
          <section className="panel empty-state">
            <h2>Loading frames…</h2>
          </section>
        ) : frames.length === 0 ? (
          <section className="panel empty-state frames-empty">
            <h2>No frames yet</h2>
            <p>
              Create a frame profile here, then open{" "}
              <code>/setup</code> on the Raspberry Pi (or a fresh browser) to
              bind a device.
            </p>
            <div className="frames-empty-actions">
              <button className="primary" type="button" onClick={addFrame}>
                Create first frame
              </button>
              {!user.api_key_configured && (
                <button
                  className="secondary"
                  type="button"
                  onClick={() => navigate("/account")}
                >
                  Add Immich API key
                </button>
              )}
            </div>
          </section>
        ) : (
          <div className="frame-card-grid" role="list">
            {frames.map((frame) => {
              const ownerLabel = frame.owner_name || frame.owner_email;
              const showOwner =
                Boolean(user.is_admin) &&
                Boolean(ownerLabel) &&
                frame.owner_user_id !== user.id;
              return (
                <article
                  key={frame.id}
                  className="frame-card"
                  role="listitem"
                >
                  <button
                    type="button"
                    className="frame-card-main"
                    onClick={() => navigate(`/frames/${frame.id}`)}
                  >
                    <span className="status-dot" aria-hidden="true" />
                    <span className="frame-card-copy">
                      <span className="frame-card-name">{frame.name}</span>
                      <span className="frame-card-meta">
                        {frame.configured === false
                          ? "Setup incomplete · waiting for first save"
                          : `${frameSourceLabel(frame)} · every ${frame.interval_seconds}s${
                              frame.show_weather ? " · Weather" : ""
                            }${
                              frame.allow_photo_actions
                                ? " · Photo actions"
                                : ""
                            }`}
                      </span>
                      {showOwner && (
                        <span className="frame-card-owner">
                          Owned by {ownerLabel}
                        </span>
                      )}
                    </span>
                  </button>
                  <div className="frame-card-actions">
                    <button
                      type="button"
                      className="primary compact"
                      onClick={() => navigate(`/frames/${frame.id}`)}
                    >
                      Settings
                    </button>
                    <button
                      type="button"
                      className="secondary compact"
                      onClick={() => openFrameKiosk(frame)}
                    >
                      Open kiosk
                    </button>
                    <button
                      type="button"
                      className="danger compact"
                      onClick={() => void deleteFrame(frame)}
                    >
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </main>
    </ControlShell>
  );
}

function FrameDetailPage({
  frameId,
  user,
  onLogout,
}: {
  frameId: number;
  user: User;
  onLogout: () => Promise<void>;
  onUserChange?: (user: User) => void;
}) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [weatherConfigured, setWeatherConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    Promise.all([
      loadAccessibleFrames(user),
      api.getWeatherSettings().catch(() => null),
    ])
      .then(async ([frameList, weather]) => {
        if (!active) return;
        const found = frameList.find((item) => item.id === frameId) || null;
        setFrame(found);
        if (weather) setWeatherConfigured(weather.api_key_configured);
        if (!found) {
          setError("Frame not found.");
          return;
        }
        try {
          const [nextAlbums, nextPeople] = await Promise.all([
            api.frameAlbums(frameId),
            api.framePeople(frameId),
          ]);
          if (!active) return;
          setAlbums(nextAlbums);
          setPeople(nextPeople);
        } catch {
          if (!active) return;
          setAlbums([]);
          setPeople([]);
        }
      })
      .catch((err) => {
        if (active) setError(String(err));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [frameId, user.id, user.is_admin, user.api_key_configured]);

  async function saveFrame(next: Frame) {
    if (saving) return;
    if (next.source.type === "album" && !next.source.album_id) {
      setError(
        "Choose an album for this frame, or switch to Entire Immich library.",
      );
      return;
    }

    setSaving(true);
    try {
      const wasPending = next.configured === false;
      const saved = normalizeFrame(await api.updateFrame(next));
      setFrame(saved);
      setMessage(
        wasPending
          ? "Setup complete. The frame will start the slideshow shortly."
          : "Frame saved.",
      );
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function deleteFrame(next: Frame) {
    const confirmed = window.confirm(
      `Delete “${next.name}”? Bound devices will need setup again. Photos in Immich are not affected.`,
    );
    if (!confirmed) return;

    try {
      await api.deleteFrame(next.id);
      navigate("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ControlShell
      user={user}
      active="frames"
      eyebrow="FRAME SETTINGS"
      title={frame?.name || "Frame"}
      onLogout={onLogout}
    >
      {(message || error) && (
        <div className={error ? "notice error" : "notice"}>
          {error || message}
        </div>
      )}

      <main className="admin-stack frame-detail">
        <div className="detail-back-row">
          <button
            type="button"
            className="secondary compact"
            onClick={() => navigate("/")}
          >
            ← Back to frames
          </button>
          {!user.api_key_configured && (
            <button
              type="button"
              className="secondary compact"
              onClick={() => navigate("/account")}
            >
              Add Immich API key
            </button>
          )}
        </div>

        {loading ? (
          <section className="panel empty-state">
            <h2>Loading frame…</h2>
          </section>
        ) : frame ? (
          <>
            {frame.configured === false && (
              <section className="notice frames-banner">
                Finish setup by choosing photos and options below, then save.
                Linked displays stay on “Setup in progress” until then.
              </section>
            )}
            <FrameEditor
              frame={frame}
              albums={albums}
              people={people}
              weatherConfigured={weatherConfigured}
              showOwner={Boolean(user.is_admin)}
              saving={saving}
              onChange={setFrame}
              onSave={(next) => void saveFrame(next)}
              onDelete={deleteFrame}
            />
          </>
        ) : (
          <section className="panel empty-state">
            <h2>Frame not found</h2>
            <p>It may have been deleted, or you don’t have access.</p>
            <button
              type="button"
              className="secondary"
              onClick={() => navigate("/")}
            >
              Back to frames
            </button>
          </section>
        )}
      </main>
    </ControlShell>
  );
}

function AdminSettingsPage({
  user,
  onLogout,
}: {
  user: User;
  onLogout: () => Promise<void>;
}) {
  const [defaultImmichUrl, setDefaultImmichUrl] = useState("");
  const [weatherKey, setWeatherKey] = useState("");
  const [weatherUnits, setWeatherUnits] = useState<"imperial" | "metric">(
    "imperial",
  );
  const [weatherConfigured, setWeatherConfigured] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .getServerSettings()
      .then((server: ServerSettings) => {
        setDefaultImmichUrl(server.default_immich_url);
        setWeatherConfigured(server.weather_api_key_configured);
        setWeatherUnits(server.weather_units);
      })
      .catch((err) => setError(String(err)));
  }, []);

  async function saveServerSettings(event: FormEvent) {
    event.preventDefault();
    setError("");
    setMessage("");

    try {
      const saved = await api.saveServerSettings({
        default_immich_url: defaultImmichUrl,
        weather_api_key: weatherKey,
        weather_units: weatherUnits,
      });
      if (saved.weather_api_key_configured) {
        await api.testWeather();
      }
      setWeatherConfigured(saved.weather_api_key_configured);
      setWeatherUnits(saved.weather_units);
      setDefaultImmichUrl(saved.default_immich_url);
      setWeatherKey("");
      setMessage(
        saved.weather_api_key_configured
          ? "Server settings saved. Weather API tested."
          : "Server settings saved. Add an OpenWeather API key to enable forecasts.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ControlShell
      user={user}
      active="admin-settings"
      eyebrow="SERVER ADMIN"
      title="Settings"
      onLogout={onLogout}
    >
      {(message || error) && (
        <div className={error ? "notice error" : "notice"}>
          {error || message}
        </div>
      )}

      <main className="admin-stack">
        <section className="panel">
          <h2>Server settings</h2>
          <p className="muted">
            Shared Immich server address and weather for everyone using this
            frame server. Users manage their own Immich API keys under Account.
            {weatherConfigured
              ? " OpenWeather API key is configured."
              : " No OpenWeather API key yet."}
          </p>
          <form className="form-grid two-column" onSubmit={saveServerSettings}>
            <label className="span-2">
              Immich server address
              <input
                value={defaultImmichUrl}
                onChange={(e) => setDefaultImmichUrl(e.target.value)}
                placeholder="https://immich.example.com"
              />
              <span className="field-hint">
                Public Immich URL used for login and device setup. Users still
                authenticate with their own Immich API keys.
              </span>
            </label>
            <label>
              OpenWeather API key
              <input
                type="password"
                value={weatherKey}
                onChange={(e) => setWeatherKey(e.target.value)}
                placeholder={
                  weatherConfigured
                    ? "Paste a new key to rotate"
                    : "Paste your OpenWeather API key"
                }
              />
            </label>
            <label>
              Units
              <select
                value={weatherUnits}
                onChange={(e) =>
                  setWeatherUnits(e.target.value as "imperial" | "metric")
                }
              >
                <option value="imperial">Fahrenheit</option>
                <option value="metric">Celsius</option>
              </select>
            </label>
            <div className="span-2">
              <button className="primary" type="submit">
                Save server settings
              </button>
            </div>
          </form>
        </section>
      </main>
    </ControlShell>
  );
}

function AdminUsersPage({
  user,
  onLogout,
  onUserChange,
}: {
  user: User;
  onLogout: () => Promise<void>;
  onUserChange: (user: User) => void;
}) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    api
      .adminUsers()
      .then(setUsers)
      .catch((err) => setError(String(err)));
  }, []);

  async function toggleAdmin(target: AdminUser) {
    const next = !target.is_admin;
    const confirmed = window.confirm(
      next
        ? `Grant admin access to ${target.name || target.email}?`
        : `Remove admin access from ${target.name || target.email}?`,
    );
    if (!confirmed) return;

    try {
      const updated = await api.adminUpdateUser(target.id, { is_admin: next });
      setUsers((current) =>
        current.map((item) => (item.id === updated.id ? updated : item)),
      );
      if (updated.id === user.id) {
        onUserChange({ ...user, is_admin: updated.is_admin });
      }
      setMessage(
        updated.is_admin
          ? `${updated.name} is now an admin.`
          : `${updated.name} is no longer an admin.`,
      );
      setError("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <ControlShell
      user={user}
      active="admin-users"
      eyebrow="SERVER ADMIN"
      title="Users"
      onLogout={onLogout}
    >
      {(message || error) && (
        <div className={error ? "notice error" : "notice"}>
          {error || message}
        </div>
      )}

      <main className="admin-stack">
        <section className="panel">
          <h2>Users</h2>
          <p className="muted">
            People who have signed in. Server admins can edit server settings
            and any frame.
          </p>
          {users.length === 0 ? (
            <p className="muted">No users yet.</p>
          ) : (
            <div className="user-list" role="list">
              {users.map((row) => (
                <div key={row.id} className="user-row" role="listitem">
                  <div className="user-row-text">
                    <strong>{row.name || row.email}</strong>
                    <span className="muted">
                      {row.email}
                      {row.is_admin ? " · Admin" : ""}
                      {" · "}
                      {row.frame_count} frame
                      {row.frame_count === 1 ? "" : "s"}
                      {row.api_key_configured
                        ? " · Immich key set"
                        : " · No Immich key"}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="secondary compact"
                    disabled={
                      row.is_admin &&
                      users.filter((item) => item.is_admin).length <= 1
                    }
                    onClick={() => void toggleAdmin(row)}
                  >
                    {row.is_admin ? "Remove admin" : "Make admin"}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </main>
    </ControlShell>
  );
}

function SetupPage() {
  const params = new URLSearchParams(window.location.search);
  const codeFromUrl = (params.get("code") || "").toUpperCase();

  const [deviceKey] = useState(() => getOrCreateDeviceKey());
  const [setupCode, setSetupCode] = useState(codeFromUrl);
  const [defaultUrl, setDefaultUrl] = useState("");
  const [immichUrl, setImmichUrl] = useState("");
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
          const status = await api.setupStatus(codeFromUrl);
          if (!active) return;
          setSetupCode(status.setup_code);
          setDefaultUrl(status.default_immich_url);
          setImmichUrl(status.default_immich_url);
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

        const started = await api.setupStart(deviceKey);
        if (!active) return;
        setDefaultUrl(started.default_immich_url);
        setImmichUrl(started.default_immich_url);
        if (started.bound && started.frame_token) {
          rememberFrameToken(started.frame_token);
          navigate("/frame", true);
          return;
        }
        setSetupCode(started.setup_code);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : String(err));
      }
    }

    bootstrap();
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
        // keep polling
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
          ? await api.setupCompletePassword({
              setup_code: setupCode,
              immich_url: immichUrl || defaultUrl,
              email,
              password,
              frame_name: frameName.trim() || undefined,
            })
          : await api.setupCompleteApiKey({
              setup_code: setupCode,
              immich_url: immichUrl || defaultUrl,
              immich_api_key: apiKey,
              frame_name: frameName.trim() || undefined,
            });
      rememberFrameToken(result.frame_token);
      // Phone: finish configuration in the control UI. Pi: waiting room on /frame
      // until settings are saved (here or on the phone).
      if (phoneMode) {
        navigate(`/frames/${result.frame.id}`, true);
      } else {
        navigate("/frame", true);
      }
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
          Sign in with your Immich account to link this device. You&apos;ll choose
          photos and overlays next — the frame waits until those settings are
          saved.
        </p>

        {setupCode && !phoneMode && (
          <div className="setup-code-block">
            <div className="setup-qr-card">
              <QRCodeSVG
                value={phoneUrl}
                size={220}
                level="M"
                includeMargin
                bgColor="#ffffff"
                fgColor="#0b0d10"
              />
              <p className="muted setup-qr-caption">
                Scan with your phone to finish setup more easily
              </p>
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
          <button
            type="button"
            className={mode === "password" ? "secondary active-tab" : "secondary"}
            onClick={() => setMode("password")}
          >
            Immich login
          </button>
          <button
            type="button"
            className={mode === "api-key" ? "secondary active-tab" : "secondary"}
            onClick={() => setMode("api-key")}
          >
            API key
          </button>
        </div>

        <form className="form-grid" onSubmit={complete}>
          <label>
            Frame name
            <input
              value={frameName}
              onChange={(e) => setFrameName(e.target.value)}
              placeholder="Leave blank for Firstname's Frame"
            />
            <span className="field-hint">
              Defaults to your Immich first name, like “Alex&apos;s Frame”.
            </span>
          </label>
          <label>
            Immich URL
            <input
              value={immichUrl}
              onChange={(e) => setImmichUrl(e.target.value)}
              placeholder={defaultUrl || "https://immich.example.com"}
              required
            />
          </label>

          {mode === "password" ? (
            <>
              <label>
                Email
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </label>
              <label>
                Password
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <label>
              API key
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
              />
            </label>
          )}

          <button className="primary" type="submit" disabled={busy || !setupCode}>
            {busy
              ? "Connecting…"
              : phoneMode
                ? "Connect and continue setup"
                : "Connect this device"}
          </button>
          {phoneMode && (
            <p className="field-hint">
              After connecting, configure the frame here. The display will leave
              “setup in progress” as soon as you save.
            </p>
          )}
        </form>
      </section>
    </div>
  );
}

function sourceSummary(frame: Frame, albums: Album[]): string {
  if (frame.source.type === "library") return "Entire library";
  const albumId = frame.source.album_id;
  const album = albums.find((item) => item.id === albumId);
  return album?.albumName || "Album";
}

function FrameEditor({
  frame,
  albums,
  people,
  weatherConfigured,
  showOwner = false,
  saving = false,
  onChange,
  onSave,
  onDelete,
}: {
  frame: Frame;
  albums: Album[];
  people: Person[];
  weatherConfigured: boolean;
  showOwner?: boolean;
  saving?: boolean;
  onChange: (frame: Frame) => void;
  onSave: (frame: Frame) => void;
  onDelete: (frame: Frame) => void;
}) {
  const kioskUrl = `${window.location.origin}/frame`;
  const ownerLabel = frame.owner_name || frame.owner_email;

  function openKioskOnThisBrowser() {
    rememberFrameToken(frame.token);
    window.open(kioskUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <section className="panel frame-editor-panel">
      <div className="section-heading">
        <div>
          <span className="eyebrow">FRAME PROFILE</span>
          <h2>{frame.name}</h2>
          <p className="muted frame-subtitle">
            {sourceSummary(frame, albums)}
            {showOwner && ownerLabel ? ` · ${ownerLabel}` : ""}
          </p>
        </div>
        <div className="section-actions">
          <button
            type="button"
            className="secondary"
            onClick={openKioskOnThisBrowser}
            disabled={saving}
          >
            Open kiosk
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => onDelete(frame)}
            disabled={saving}
          >
            Delete frame
          </button>
        </div>
      </div>

      <FrameFields
        frame={frame}
        albums={albums}
        people={people}
        personThumbnailUrl={(personId) =>
          api.framePersonThumbnailUrl(frame.id, personId)
        }
        weatherConfigured={weatherConfigured}
        onChange={onChange}
      />

      <div className="kiosk-url">
        <span className="muted">Device kiosk</span>
        <code>{kioskUrl}</code>
        <p className="field-hint">
          Bound Pis open this page and use a stored frame token (not shown in
          the URL). Opening kiosk here binds this browser to this frame.
        </p>
      </div>

      <div className="editor-actions">
        <button
          className="primary"
          type="button"
          onClick={() => onSave(frame)}
          disabled={saving}
          aria-busy={saving}
        >
          {saving ? "Saving…" : "Save frame"}
        </button>
      </div>
    </section>
  );
}

function FrameFields({
  frame,
  albums,
  people = [],
  personThumbnailUrl,
  onChange,
  weatherConfigured = true,
}: {
  frame: Frame;
  albums: Album[];
  people?: Person[];
  personThumbnailUrl?: (personId: string) => string;
  onChange: (frame: Frame) => void;
  weatherConfigured?: boolean;
}) {
  const overlay = frameOverlay(frame);
  const context = frameContext(frame);
  const clockPlacement: DisplayPlacement = frame.show_clock
    ? overlay.clock_corner
    : "hidden";
  const photoInfoVisible =
    frame.show_photo_date || frame.show_photo_location !== false;
  const photoInfoPlacement: DisplayPlacement = photoInfoVisible
    ? overlay.photo_meta_corner
    : "hidden";
  const weatherPlacement: DisplayPlacement = frame.show_weather
    ? overlay.weather_corner
    : "hidden";
  const clockTimeValue = `${overlay.clock_format}${
    overlay.clock_show_seconds ? "+s" : ""
  }`;

  function setClockPlacement(value: DisplayPlacement) {
    if (value === "hidden") {
      onChange({ ...frame, show_clock: false });
      return;
    }
    onChange(
      withOverlay({ ...frame, show_clock: true }, { clock_corner: value }),
    );
  }

  function setPhotoInfoPlacement(value: DisplayPlacement) {
    if (value === "hidden") {
      onChange({
        ...frame,
        show_photo_date: false,
        show_photo_location: false,
      });
      return;
    }
    const restoring = !photoInfoVisible;
    onChange(
      withOverlay(
        {
          ...frame,
          show_photo_date: restoring ? true : frame.show_photo_date,
          show_photo_location: restoring
            ? true
            : frame.show_photo_location !== false,
        },
        { photo_meta_corner: value },
      ),
    );
  }

  function setWeatherPlacement(value: DisplayPlacement) {
    if (value === "hidden") {
      onChange({ ...frame, show_weather: false });
      return;
    }
    onChange(
      withOverlay({ ...frame, show_weather: true }, { weather_corner: value }),
    );
  }

  function setClockTimeStyle(value: string) {
    const showSeconds = value.endsWith("+s");
    const format = value.replace("+s", "") as OverlaySettings["clock_format"];
    onChange(
      withOverlay(frame, {
        clock_format: format,
        clock_show_seconds: showSeconds,
      }),
    );
  }

  const settingsTabs = [
    { id: "photos", label: "Photos" },
    { id: "display", label: "Display" },
    { id: "look", label: "Look" },
    { id: "motion", label: "Motion" },
    { id: "people", label: "People" },
  ] as const;
  type SettingsTab = (typeof settingsTabs)[number]["id"];
  const [tab, setTab] = useState<SettingsTab>("photos");

  return (
    <div className="frame-fields">
      <div className="settings-tabs" role="tablist" aria-label="Frame settings">
        {settingsTabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`settings-tab${tab === item.id ? " active" : ""}`}
            onClick={() => setTab(item.id)}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="settings-tab-panel" role="tabpanel">
        {tab === "photos" && (
          <section className="settings-section">
            <div className="form-grid two-column compact">
              <label>
                Name
                <input
                  value={frame.name}
                  inputMode="text"
                  enterKeyHint="done"
                  autoComplete="off"
                  onChange={(e) => onChange({ ...frame, name: e.target.value })}
                />
              </label>

              <label>
                Photo source
                <select
                  value={frame.source.type}
                  onChange={(e) => {
                    const type = e.target.value as PhotoSource["type"];
                    const source: PhotoSource =
                      type === "library"
                        ? { type: "library" }
                        : {
                            type: "album",
                            album_id:
                              frame.source.type === "album"
                                ? frame.source.album_id
                                : albums[0]?.id || "",
                          };
                    onChange({ ...frame, source });
                  }}
                >
                  <option value="library">Entire Immich library</option>
                  <option value="album">Single album</option>
                </select>
              </label>

              {frame.source.type === "album" && (
                <label className="span-2">
                  Album
                  <select
                    value={frame.source.album_id}
                    onChange={(e) =>
                      onChange({
                        ...frame,
                        source: { type: "album", album_id: e.target.value },
                      })
                    }
                  >
                    <option value="">Choose an album</option>
                    {albums.map((album) => (
                      <option value={album.id} key={album.id}>
                        {album.albumName} ({album.assetCount})
                      </option>
                    ))}
                  </select>
                </label>
              )}

              <label>
                Change every
                <div className="inline-field">
                  <input
                    type="number"
                    inputMode="numeric"
                    min={3}
                    value={frame.interval_seconds}
                    onChange={(e) =>
                      onChange({
                        ...frame,
                        interval_seconds: Number(e.target.value),
                      })
                    }
                  />
                  <span>sec</span>
                </div>
              </label>

              <label>
                Photo fit
                <select
                  value={frame.image_fit}
                  onChange={(e) =>
                    onChange({
                      ...frame,
                      image_fit: e.target.value as "contain" | "cover",
                    })
                  }
                >
                  <option value="contain">Contain</option>
                  <option value="cover">Fill / crop</option>
                </select>
              </label>

              <label className="span-2">
                Seasonal weighting
                <div className="slider-field">
                  <input
                    type="range"
                    min={0}
                    max={5}
                    step={1}
                    value={Math.max(0, Math.min(5, frame.seasonal_strength ?? 3))}
                    onChange={(e) =>
                      onChange({
                        ...frame,
                        seasonal_strength: Number(e.target.value),
                      })
                    }
                  />
                  <div className="slider-meta">
                    <span className="slider-ends">
                      <span>Off</span>
                      <span>Mostly seasonal</span>
                    </span>
                    <span className="slider-value">
                      {
                        SEASONAL_STRENGTH_LABELS[
                          Math.max(0, Math.min(5, frame.seasonal_strength ?? 3))
                        ]
                      }
                    </span>
                  </div>
                  <span className="field-hint">
                    Boosts photos from around today&apos;s date in past years.
                    Turn up for holidays; turn down when the season matters less.
                  </span>
                </div>
              </label>
            </div>
          </section>
        )}

        {tab === "display" && (
          <section className="settings-section">
            <div className="form-grid two-column compact">
              <label>
                Clock
                {placementSelect(clockPlacement, setClockPlacement)}
              </label>

              {frame.show_clock && (
                <>
                  <label>
                    Clock size
                    <ScaleSelect
                      value={overlay.clock_scale}
                      onChange={(clock_scale) =>
                        onChange(withOverlay(frame, { clock_scale }))
                      }
                    />
                  </label>
                  <label>
                    Clock style
                    <select
                      value={clockTimeValue}
                      onChange={(e) => setClockTimeStyle(e.target.value)}
                    >
                      <option value="12h">12-hour</option>
                      <option value="12h+s">12-hour with seconds</option>
                      <option value="24h">24-hour</option>
                      <option value="24h+s">24-hour with seconds</option>
                    </select>
                  </label>
                  <label>
                    Date under clock
                    <select
                      value={overlay.clock_date_format}
                      onChange={(e) =>
                        onChange(
                          withOverlay(frame, {
                            clock_date_format: e.target
                              .value as OverlaySettings["clock_date_format"],
                          }),
                        )
                      }
                    >
                      <option value="long">Monday, August 10</option>
                      <option value="short">Aug 10</option>
                      <option value="weekday">Weekday only</option>
                      <option value="none">Hidden</option>
                    </select>
                  </label>
                </>
              )}

              <label>
                Photo info
                {placementSelect(photoInfoPlacement, setPhotoInfoPlacement)}
              </label>

              {photoInfoVisible && (
                <>
                  <label>
                    Photo info size
                    <ScaleSelect
                      value={overlay.photo_meta_scale}
                      onChange={(photo_meta_scale) =>
                        onChange(withOverlay(frame, { photo_meta_scale }))
                      }
                    />
                  </label>
                  <label>
                    Show in photo info
                    <div className="check-row">
                      <label className="check-item">
                        <input
                          type="checkbox"
                          checked={frame.show_photo_date}
                          onChange={(e) => {
                            const show_photo_date = e.target.checked;
                            const show_photo_location =
                              frame.show_photo_location !== false;
                            if (!show_photo_date && !show_photo_location) {
                              onChange({
                                ...frame,
                                show_photo_date: false,
                                show_photo_location: false,
                              });
                              return;
                            }
                            onChange({ ...frame, show_photo_date });
                          }}
                        />
                        Date
                      </label>
                      <label className="check-item">
                        <input
                          type="checkbox"
                          checked={frame.show_photo_location !== false}
                          onChange={(e) => {
                            const show_photo_location = e.target.checked;
                            if (!frame.show_photo_date && !show_photo_location) {
                              onChange({
                                ...frame,
                                show_photo_date: false,
                                show_photo_location: false,
                              });
                              return;
                            }
                            onChange({ ...frame, show_photo_location });
                          }}
                        />
                        Location
                      </label>
                    </div>
                  </label>
                  {frame.show_photo_date && (
                    <label>
                      Photo date format
                      <select
                        value={overlay.photo_date_format}
                        onChange={(e) =>
                          onChange(
                            withOverlay(frame, {
                              photo_date_format: e.target
                                .value as OverlaySettings["photo_date_format"],
                            }),
                          )
                        }
                      >
                        <option value="long">August 10, 2024</option>
                        <option value="short">Aug 10, 2024</option>
                        <option value="numeric">8/10/2024</option>
                      </select>
                    </label>
                  )}
                </>
              )}

              <label>
                Weather
                {placementSelect(weatherPlacement, setWeatherPlacement)}
              </label>

              {frame.show_weather && (
                <>
                  <label>
                    Weather size
                    <ScaleSelect
                      value={overlay.weather_scale}
                      onChange={(weather_scale) =>
                        onChange(withOverlay(frame, { weather_scale }))
                      }
                    />
                  </label>
                  <label className="span-2">
                    Weather location
                    <input
                      value={frame.weather_location || ""}
                      onChange={(e) =>
                        onChange({ ...frame, weather_location: e.target.value })
                      }
                      placeholder="Raleigh, NC"
                      inputMode="text"
                      enterKeyHint="done"
                      autoComplete="off"
                      autoCorrect="off"
                      spellCheck={false}
                    />
                    <span className="field-hint">
                      {weatherConfigured
                        ? "City or city, region. On a Pi kiosk, enable the OS on-screen keyboard if tapping this field does nothing."
                        : "Ask a server admin to add an OpenWeather API key first."}
                    </span>
                  </label>
                </>
              )}
            </div>
          </section>
        )}

        {tab === "look" && (
          <section className="settings-section">
            <div className="form-grid two-column compact">
              <label className="span-2">
                Font
                <select
                  value={overlay.font}
                  onChange={(e) =>
                    onChange(
                      withOverlay(frame, {
                        font: e.target.value as OverlaySettings["font"],
                      }),
                    )
                  }
                >
                  {OVERLAY_FONT_OPTIONS.map((option) => (
                    <option value={option.value} key={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>

              <label>
                Text color
                <select
                  value={overlay.text_color}
                  onChange={(e) =>
                    onChange(
                      withOverlay(frame, {
                        text_color: e.target
                          .value as OverlaySettings["text_color"],
                      }),
                    )
                  }
                >
                  <option value="white">White</option>
                  <option value="warm">Warm white</option>
                  <option value="amber">Amber LCD</option>
                  <option value="mint">Mint LCD</option>
                  <option value="soft">Soft gray</option>
                </select>
              </label>

              <label>
                Contrast
                <select
                  value={overlay.contrast}
                  onChange={(e) =>
                    onChange(
                      withOverlay(frame, {
                        contrast: e.target.value as OverlaySettings["contrast"],
                      }),
                    )
                  }
                >
                  <option value="none">None</option>
                  <option value="soft">Soft shadow</option>
                  <option value="heavy">Heavy shadow</option>
                  <option value="pill">Scrim pill</option>
                  <option value="bar">Glass bar</option>
                </select>
              </label>

              <label className="span-2">
                Text &amp; icon opacity
                <div className="slider-field">
                  <input
                    type="range"
                    min={40}
                    max={100}
                    step={5}
                    value={overlay.opacity}
                    onChange={(e) =>
                      onChange(
                        withOverlay(frame, {
                          opacity: Number(e.target.value),
                        }),
                      )
                    }
                  />
                  <div className="slider-meta">
                    <span className="slider-ends">
                      <span>Let photo win</span>
                      <span>Solid</span>
                    </span>
                    <span className="slider-value">{overlay.opacity}%</span>
                  </div>
                </div>
              </label>

              {(overlay.contrast === "pill" || overlay.contrast === "bar") && (
                <label className="span-2">
                  Background opacity
                  <div className="slider-field">
                    <input
                      type="range"
                      min={0}
                      max={100}
                      step={5}
                      value={overlay.scrim_opacity}
                      onChange={(e) =>
                        onChange(
                          withOverlay(frame, {
                            scrim_opacity: Number(e.target.value),
                          }),
                        )
                      }
                    />
                    <div className="slider-meta">
                      <span className="slider-ends">
                        <span>Clear</span>
                        <span>Solid</span>
                      </span>
                      <span className="slider-value">{overlay.scrim_opacity}%</span>
                    </div>
                    <span className="field-hint">
                      Only affects the pill / glass bar behind the text.
                    </span>
                  </div>
                </label>
              )}
            </div>
          </section>
        )}

        {tab === "motion" && (
          <SlideshowFields frame={frame} onChange={onChange} />
        )}

        {tab === "people" && (
          <PeopleFilters
            frame={frame}
            context={context}
            people={people}
            personThumbnailUrl={personThumbnailUrl}
            onChange={onChange}
          />
        )}
      </div>
    </div>
  );
}

function SlideshowFields({
  frame,
  onChange,
}: {
  frame: Frame;
  onChange: (frame: Frame) => void;
}) {
  const slideshow = frameSlideshow(frame);

  return (
    <section className="settings-section">
      <div className="form-grid two-column compact">
        <label>
          Transition
          <select
            value={slideshow.transition}
            onChange={(e) =>
              onChange(
                withSlideshow(frame, {
                  transition: e.target
                    .value as SlideshowSettings["transition"],
                }),
              )
            }
          >
            <option value="none">None (hard cut)</option>
            <option value="fade">Soft fade</option>
            <option value="crossfade">Crossfade</option>
          </select>
        </label>

        {slideshow.transition !== "none" && (
          <label>
            Transition speed
            <select
              value={slideshow.transition_speed}
              onChange={(e) =>
                onChange(
                  withSlideshow(frame, {
                    transition_speed: e.target
                      .value as SlideshowSettings["transition_speed"],
                  }),
                )
              }
            >
              <option value="fast">Fast</option>
              <option value="medium">Medium</option>
              <option value="slow">Slow</option>
            </select>
          </label>
        )}

        <label>
          Pan &amp; zoom
          <select
            value={slideshow.pan}
            onChange={(e) =>
              onChange(
                withSlideshow(frame, {
                  pan: e.target.value as SlideshowSettings["pan"],
                }),
              )
            }
          >
            <option value="off">Off</option>
            <option value="subtle">Subtle</option>
            <option value="medium">Medium</option>
            <option value="strong">Strong</option>
            <option value="dramatic">Dramatic</option>
          </select>
        </label>

        <label>
          Backdrop
          <select
            value={slideshow.backdrop}
            onChange={(e) =>
              onChange(
                withSlideshow(frame, {
                  backdrop: e.target.value as SlideshowSettings["backdrop"],
                }),
              )
            }
          >
            <option value="black">Solid black</option>
            <option value="blur">Blurred photo</option>
            <option value="glow">Soft color wash</option>
          </select>
        </label>

        <label className="span-2 checkbox">
          <input
            type="checkbox"
            checked={frame.allow_photo_actions}
            onChange={(e) =>
              onChange({
                ...frame,
                allow_photo_actions: e.target.checked,
              })
            }
          />
          Allow photo actions (swipe down to rotate / archive)
        </label>
      </div>
      <p className="field-hint">
        Blurred backdrops look best with Contain photo fit. Pan is disabled when
        the system asks for reduced motion. Photo actions write back to Immich
        using this frame&apos;s owner account.
      </p>
    </section>
  );
}

function PersonThumb({ url }: { url?: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (!url) {
      setSrc(null);
      return;
    }
    let objectUrl: string | null = null;
    let cancelled = false;
    fetch(url, { credentials: "include" })
      .then((response) => (response.ok ? response.blob() : null))
      .then((blob) => {
        if (!blob || cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) setSrc(null);
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (!src) return <div className="person-thumb placeholder" aria-hidden />;
  return <img className="person-thumb" src={src} alt="" />;
}

function PeopleFilters({
  frame,
  context,
  people,
  personThumbnailUrl,
  onChange,
}: {
  frame: Frame;
  context: ContextFilters;
  people: Person[];
  personThumbnailUrl?: (personId: string) => string;
  onChange: (frame: Frame) => void;
}) {
  const [query, setQuery] = useState("");
  const selectedKey = [
    ...context.exclude_people.map((person) => person.id),
    ...context.prefer_people.map((person) => person.id),
  ]
    .sort()
    .join(",");

  const catalog = useMemo(() => {
    const byId = new Map(people.map((person) => [person.id, person]));
    // Keep saved people visible even if Immich list is temporarily empty.
    for (const person of [...context.exclude_people, ...context.prefer_people]) {
      if (!byId.has(person.id)) {
        byId.set(person.id, { id: person.id, name: person.name || "Person" });
      }
    }
    return Array.from(byId.values()).sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [people, context.exclude_people, context.prefer_people]);

  const filtered = useMemo(() => {
    const selectedIds = new Set(selectedKey.split(",").filter(Boolean));
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? catalog.filter((person) => person.name.toLowerCase().includes(needle))
      : catalog;
    // Selected people first, then alphabetical (catalog already sorted).
    return [...matched].sort((a, b) => {
      const aSelected = selectedIds.has(a.id) ? 0 : 1;
      const bSelected = selectedIds.has(b.id) ? 0 : 1;
      if (aSelected !== bSelected) return aSelected - bSelected;
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
  }, [catalog, query, selectedKey]);

  function setMode(person: Person | PersonRef, mode: PersonMode) {
    const ref: PersonRef = {
      id: person.id,
      name: person.name || "Person",
    };
    const exclude_people = context.exclude_people.filter((item) => item.id !== ref.id);
    const prefer_people = context.prefer_people.filter((item) => item.id !== ref.id);
    if (mode === "exclude") exclude_people.push(ref);
    if (mode === "prefer") prefer_people.push(ref);
    onChange(withContext(frame, { exclude_people, prefer_people }));
  }

  return (
    <section className="settings-section">
      <p className="field-hint people-help">
        Exclude hides photos of that person. Prefer soft-boosts photos that
        include them (without hiding everyone else).
      </p>

      <label>
        Search people
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type a name…"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </label>

      {context.prefer_people.length > 0 && (
        <label>
          Prefer strength
          <div className="slider-field">
            <input
              type="range"
              min={1}
              max={5}
              step={1}
              value={Math.max(1, Math.min(5, context.prefer_strength || 3))}
              onChange={(e) =>
                onChange(
                  withContext(frame, {
                    prefer_strength: Number(e.target.value),
                  }),
                )
              }
            />
            <div className="slider-meta">
              <span className="slider-ends">
                <span>Subtle</span>
                <span>Strong</span>
              </span>
              <span className="slider-value">
                {
                  SEASONAL_STRENGTH_LABELS[
                    Math.max(1, Math.min(5, context.prefer_strength || 3))
                  ]
                }
              </span>
            </div>
          </div>
        </label>
      )}

      {!catalog.length ? (
        <p className="field-hint">
          No named people found in Immich yet. Name faces in Immich, then reopen
          settings.
        </p>
      ) : (
        <div className="people-list">
          {filtered.slice(0, 80).map((person) => {
            const mode = personMode(context, person.id);
            const thumb = personThumbnailUrl?.(person.id);
            return (
              <div
                className={`person-row mode-${mode}`}
                key={person.id}
              >
                <PersonThumb url={thumb} />
                <div className="person-name">{person.name || "Unnamed"}</div>
                <select
                  className="person-mode"
                  value={mode}
                  onChange={(e) =>
                    setMode(person, e.target.value as PersonMode)
                  }
                >
                  <option value="off">Off</option>
                  <option value="exclude">Exclude</option>
                  <option value="prefer">Prefer</option>
                </select>
              </div>
            );
          })}
          {filtered.length > 80 && (
            <p className="field-hint">
              Showing 80 of {filtered.length}. Refine the search to find others.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function Kiosk({ token }: { token: string }) {
  const [config, setConfig] = useState<KioskConfig | null>(null);
  const [playlist, setPlaylist] = useState<Asset[]>([]);
  const [index, setIndex] = useState(0);
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [now, setNow] = useState(new Date());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [guideOpen, setGuideOpen] = useState(false);
  const [guideFading, setGuideFading] = useState(false);
  const [actionBusy, setActionBusy] = useState(false);
  const [rotations, setRotations] = useState<Record<string, number>>({});
  const [draft, setDraft] = useState<Frame | null>(null);
  const guideTimer = useRef<number | null>(null);
  const guideFadeTimer = useRef<number | null>(null);
  const guideOpenRef = useRef(false);
  const guideFadingRef = useRef(false);

  useEffect(() => {
    guideOpenRef.current = guideOpen;
  }, [guideOpen]);
  useEffect(() => {
    guideFadingRef.current = guideFading;
  }, [guideFading]);
  const [albums, setAlbums] = useState<Album[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [settingsMessage, setSettingsMessage] = useState("");
  const [settingsError, setSettingsError] = useState("");
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [advanceKey, setAdvanceKey] = useState(0);
  const [hint, setHint] = useState<string | null>(null);
  const hintTimer = useRef<number | null>(null);
  const playlistRef = useRef<Asset[]>([]);
  const indexRef = useRef(0);
  const recentIdsRef = useRef<string[]>([]);
  const retryAttempt = useRef(0);
  const retryTimer = useRef<number | null>(null);

  useEffect(() => {
    playlistRef.current = playlist;
  }, [playlist]);
  useEffect(() => {
    indexRef.current = index;
  }, [index]);
  useEffect(() => {
    recentIdsRef.current = recentIds;
  }, [recentIds]);

  async function load(options?: { preservePosition?: boolean }) {
    const next = await api.kiosk(token);
    const nextPlaylist = buildPlaylist(next.assets, recentIdsRef.current);
    setConfig({
      ...next,
      frame: { ...next.frame, overlay: frameOverlay(next.frame) },
    });
    setDraft({ ...next.frame, overlay: frameOverlay(next.frame) });
    setPlaylist(nextPlaylist);
    playlistRef.current = nextPlaylist;

    if (!options?.preservePosition) {
      setIndex(0);
      indexRef.current = 0;
      if (nextPlaylist[0]) {
        const nextRecent = [nextPlaylist[0].id, ...recentIdsRef.current]
          .filter((id, pos, arr) => arr.indexOf(id) === pos)
          .slice(0, 25);
        setRecentIds(nextRecent);
        recentIdsRef.current = nextRecent;
      }
    } else if (indexRef.current >= nextPlaylist.length) {
      setIndex(0);
      indexRef.current = 0;
    }

    setError("");
    retryAttempt.current = 0;
  }

  useEffect(() => {
    let active = true;

    async function boot() {
      try {
        await load();
      } catch (err) {
        if (!active) return;
        const message = err instanceof Error ? err.message : String(err);
        if (
          /missing frame token|frame not found|HTTP 401|HTTP 404/i.test(message)
        ) {
          clearFrameToken();
          navigate("/setup", true);
          return;
        }
        setError(message);
        scheduleRetry();
      }
    }

    function scheduleRetry() {
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
      const attempt = retryAttempt.current;
      const delay = Math.min(60_000, 2000 * 2 ** attempt);
      retryAttempt.current = attempt + 1;
      retryTimer.current = window.setTimeout(() => {
        if (!active) return;
        load().catch((err) => {
          if (!active) return;
          setError(err instanceof Error ? err.message : String(err));
          scheduleRetry();
        });
      }, delay);
    }

    boot();
    return () => {
      active = false;
      if (retryTimer.current) window.clearTimeout(retryTimer.current);
    };
  }, [token]);

  useEffect(() => {
    // While waiting for first settings save, poll often so the slideshow starts
    // soon after configure-on-phone. Afterwards, refresh periodically.
    const refreshMs =
      config?.frame.configured === false ? 5_000 : 5 * 60 * 1000;
    const refresh = window.setInterval(() => {
      if (!settingsOpen) {
        load({ preservePosition: true }).catch(() => undefined);
      }
    }, refreshMs);
    return () => window.clearInterval(refresh);
  }, [token, settingsOpen, config?.frame.configured]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(new Date()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (
      !config ||
      playlist.length === 0 ||
      settingsOpen ||
      actionsOpen ||
      guideOpen
    ) {
      return;
    }

    const timer = window.setInterval(() => {
      const next = advancePlaylist(
        playlistRef.current,
        indexRef.current,
        recentIdsRef.current,
      );
      setPlaylist(next.playlist);
      setIndex(next.index);
      setRecentIds(next.recentIds);
      playlistRef.current = next.playlist;
      indexRef.current = next.index;
      recentIdsRef.current = next.recentIds;
    }, config.frame.interval_seconds * 1000);

    return () => window.clearInterval(timer);
  }, [config, playlist.length, settingsOpen, actionsOpen, guideOpen, advanceKey]);

  useEffect(() => {
    return () => {
      if (hintTimer.current) window.clearTimeout(hintTimer.current);
      if (guideTimer.current) window.clearTimeout(guideTimer.current);
      if (guideFadeTimer.current) window.clearTimeout(guideFadeTimer.current);
    };
  }, []);

  function clearGuideTimers() {
    if (guideTimer.current) {
      window.clearTimeout(guideTimer.current);
      guideTimer.current = null;
    }
    if (guideFadeTimer.current) {
      window.clearTimeout(guideFadeTimer.current);
      guideFadeTimer.current = null;
    }
  }

  function hideGestureGuide() {
    clearGuideTimers();
    setGuideFading(false);
    setGuideOpen(false);
  }

  function beginGuideFade() {
    if (guideTimer.current) {
      window.clearTimeout(guideTimer.current);
      guideTimer.current = null;
    }
    setGuideFading(true);
    guideFadeTimer.current = window.setTimeout(() => {
      setGuideOpen(false);
      setGuideFading(false);
      guideFadeTimer.current = null;
    }, 450);
  }

  function openGestureGuide() {
    clearGuideTimers();
    setGuideFading(false);
    setGuideOpen(true);
    guideTimer.current = window.setTimeout(() => beginGuideFade(), 5000);
  }

  const assetCount = playlist.length;
  const asset = playlist[index % Math.max(assetCount, 1)];

  const nextAsset = useMemo(() => {
    if (playlist.length < 2) return null;
    if (index >= playlist.length - 1) {
      return playlist.find((item) => item.id !== asset?.id) || null;
    }
    return playlist[index + 1];
  }, [playlist, index, asset?.id]);

  function showHint(text: string, ms = 1200) {
    setHint(text);
    if (hintTimer.current) window.clearTimeout(hintTimer.current);
    hintTimer.current = window.setTimeout(() => setHint(null), ms);
  }

  async function rotateCurrent(degrees: 90 | -90) {
    const current = playlistRef.current[indexRef.current];
    if (!current || actionBusy) return;
    setActionBusy(true);
    setActionsOpen(false);
    setRotations((previous) => ({
      ...previous,
      [current.id]: ((previous[current.id] || 0) + degrees + 360) % 360,
    }));
    showHint(degrees > 0 ? "Rotated right" : "Rotated left");
    try {
      await api.kioskRotateAsset(token, current.id, degrees);
    } catch (err) {
      setRotations((previous) => ({
        ...previous,
        [current.id]: ((previous[current.id] || 0) - degrees + 360) % 360,
      }));
      showHint(err instanceof Error ? err.message : String(err), 2800);
    } finally {
      setActionBusy(false);
    }
  }

  async function archiveCurrent() {
    const current = playlistRef.current[indexRef.current];
    if (!current || actionBusy) return;
    setActionBusy(true);
    setActionsOpen(false);

    const list = playlistRef.current.filter((item) => item.id !== current.id);
    const nextIndex =
      list.length === 0 ? 0 : Math.min(indexRef.current, list.length - 1);
    setPlaylist(list);
    setIndex(nextIndex);
    playlistRef.current = list;
    indexRef.current = nextIndex;
    setAdvanceKey((value) => value + 1);
    setRotations((previous) => {
      const next = { ...previous };
      delete next[current.id];
      return next;
    });
    showHint("Archived");

    try {
      await api.kioskArchiveAsset(token, current.id);
    } catch (err) {
      showHint(err instanceof Error ? err.message : String(err), 2800);
      void load({ preservePosition: true }).catch(() => undefined);
    } finally {
      setActionBusy(false);
    }
  }

  function goPrev() {
    if (assetCount < 2) return;
    const next = retreatPlaylist(
      playlistRef.current,
      indexRef.current,
      recentIdsRef.current,
    );
    setPlaylist(next.playlist);
    setIndex(next.index);
    setRecentIds(next.recentIds);
    playlistRef.current = next.playlist;
    indexRef.current = next.index;
    recentIdsRef.current = next.recentIds;
    setAdvanceKey((value) => value + 1);
    showHint("Previous");
  }

  function goNext() {
    if (assetCount < 2) return;
    const next = advancePlaylist(
      playlistRef.current,
      indexRef.current,
      recentIdsRef.current,
    );
    setPlaylist(next.playlist);
    setIndex(next.index);
    setRecentIds(next.recentIds);
    playlistRef.current = next.playlist;
    indexRef.current = next.index;
    recentIdsRef.current = next.recentIds;
    setAdvanceKey((value) => value + 1);
    showHint("Next");
  }

  async function openSettings() {
    setSettingsOpen(true);
    setSettingsMessage("");
    setSettingsError("");
    if (config) setDraft(normalizeFrame(config.frame));
    try {
      const [nextAlbums, nextPeople] = await Promise.all([
        api.kioskAlbums(token),
        api.kioskPeople(token),
      ]);
      setAlbums(nextAlbums);
      setPeople(nextPeople);
    } catch {
      setAlbums([]);
      setPeople([]);
    }
  }

  async function saveSettings() {
    if (!draft || settingsSaving) return;
    if (draft.source.type === "album" && !draft.source.album_id) {
      setSettingsError("Choose an album, or switch to Entire Immich library.");
      return;
    }
    setSettingsSaving(true);
    setSettingsError("");
    try {
      const finishingSetup = draft.configured === false;
      const saved = normalizeFrame(await api.kioskUpdateFrame(token, draft));
      setSettingsMessage("");
      await load();
      setDraft(saved);
      setSettingsOpen(false);
      showHint(finishingSetup ? "Setup complete" : "Settings saved");
    } catch (err) {
      setSettingsError(err instanceof Error ? err.message : String(err));
    } finally {
      setSettingsSaving(false);
    }
  }

  const gestures = useKioskGestures({
    enabled: !settingsOpen && !actionsOpen,
    onPrev: () => {
      hideGestureGuide();
      goPrev();
    },
    onNext: () => {
      hideGestureGuide();
      goNext();
    },
    onOpenSettings: () => {
      hideGestureGuide();
      showHint("Settings");
      void openSettings();
    },
    onOpenActions: config?.frame.allow_photo_actions
      ? () => {
          if (!playlistRef.current[indexRef.current]) return;
          hideGestureGuide();
          setActionsOpen(true);
        }
      : undefined,
    onCenterTap: () => {
      if (guideOpenRef.current && !guideFadingRef.current) {
        beginGuideFade();
        return;
      }
      if (!guideOpenRef.current) {
        openGestureGuide();
      }
    },
  });

  if (error && !config) {
    return (
      <KioskMessage
        title="Unable to load frame"
        detail={`${error} Retrying automatically…`}
      />
    );
  }

  if (!config) {
    return <KioskMessage title="Loading frame…" />;
  }

  if (config.frame.configured === false && !settingsOpen) {
    return (
      <div
        className="kiosk setup-waiting"
        role="button"
        tabIndex={0}
        onClick={() => void openSettings()}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            void openSettings();
          }
        }}
      >
        <div className="setup-waiting-panel">
          <div className="frame-icon">▣</div>
          <h1>Setup in progress</h1>
          <p>
            {config.frame.name} is linked. Finish setup on your phone, or tap
            anywhere here to configure this frame. The slideshow starts
            automatically after settings are saved.
          </p>
          <button type="button" className="primary">
            Configure on this frame
          </button>
        </div>
        {hint && <div className="kiosk-hint">{hint}</div>}
      </div>
    );
  }

  if (!asset && !settingsOpen) {
    return (
      <div className="kiosk" {...gestures}>
        <KioskMessage
          title={config.frame.name}
          detail="Press and hold to open settings and choose photos for this frame."
        />
        {hint && <div className="kiosk-hint">{hint}</div>}
      </div>
    );
  }

  const overlay = frameOverlay(config.frame);
  const taken = asset?.localDateTime || asset?.fileCreatedAt;
  const dateText =
    taken && config.frame.show_photo_date
      ? formatPhotoDate(taken, overlay.photo_date_format)
      : "";
  const locationText =
    config.frame.show_photo_location !== false
      ? asset?.location?.trim() || ""
      : "";
  const showPhotoMeta = Boolean(dateText || locationText);
  const alignEnd = (corner: OverlayCorner) =>
    corner === "top-right" || corner === "bottom-right";

  const slots: Record<OverlayCorner, ReactNode[]> = {
    "top-left": [],
    "top-right": [],
    "bottom-left": [],
    "bottom-right": [],
  };

  if (config.frame.show_clock) {
    slots[overlay.clock_corner].push(
      <ClockOverlay
        key="clock"
        now={now}
        overlay={overlay}
        alignEnd={alignEnd(overlay.clock_corner)}
      />,
    );
  }

  if (showPhotoMeta) {
    slots[overlay.photo_meta_corner].push(
      <div
        className="photo-meta"
        data-scale={overlay.photo_meta_scale}
        key="photo-meta"
      >
        {dateText && <div className="photo-date">{dateText}</div>}
        {locationText && (
          <div className="photo-location">{locationText}</div>
        )}
      </div>,
    );
  }

  if (config.frame.show_weather) {
    slots[overlay.weather_corner].push(
      <WeatherOverlay
        key="weather"
        weather={config.weather}
        locationConfigured={Boolean(config.frame.weather_location)}
        scale={overlay.weather_scale}
      />,
    );
  }

  const slideshow = frameSlideshow(config.frame);

  return (
    <div
      className="kiosk"
      data-font={overlay.font}
      data-color={overlay.text_color}
      data-contrast={overlay.contrast}
      data-backdrop={slideshow.backdrop}
      style={
        {
          "--overlay-opacity": String(overlay.opacity / 100),
          "--overlay-scrim-opacity": String(overlay.scrim_opacity / 100),
        } as CSSProperties
      }
      {...gestures}
    >
      {asset && (
        <KioskStage
          token={token}
          asset={asset}
          nextAsset={nextAsset}
          imageFit={config.frame.image_fit}
          intervalSeconds={config.frame.interval_seconds}
          slideshow={slideshow}
          rotations={rotations}
          onImageError={(assetId) => {
            if (assetId === playlistRef.current[indexRef.current]?.id) {
              goNext();
            }
          }}
        />
      )}

      <div className="shade top" />
      <div className="shade bottom" />

      {(Object.keys(slots) as OverlayCorner[]).map((corner) => {
        const children = slots[corner];
        if (!children.length) return null;
        return (
          <div
            className={`overlay ${corner}${alignEnd(corner) ? " align-end" : ""}`}
            key={corner}
          >
            {children}
          </div>
        );
      })}

      {hint && <div className="kiosk-hint">{hint}</div>}

      {guideOpen && (
        <GestureGuide
          showActions={Boolean(config.frame.allow_photo_actions)}
          fading={guideFading}
          onSettings={() => {
            hideGestureGuide();
            showHint("Settings");
            void openSettings();
          }}
          onPrev={() => {
            hideGestureGuide();
            goPrev();
          }}
          onNext={() => {
            hideGestureGuide();
            goNext();
          }}
          onActions={
            config.frame.allow_photo_actions
              ? () => {
                  if (!playlistRef.current[indexRef.current]) return;
                  hideGestureGuide();
                  setActionsOpen(true);
                }
              : undefined
          }
        />
      )}

      {actionsOpen && asset && (
        <PhotoActionsSheet
          busy={actionBusy}
          onRotateLeft={() => void rotateCurrent(-90)}
          onRotateRight={() => void rotateCurrent(90)}
          onArchive={() => void archiveCurrent()}
          onClose={() => setActionsOpen(false)}
        />
      )}

      {settingsOpen && draft && (
        <KioskSettings
          draft={draft}
          albums={albums}
          people={people}
          token={token}
          message={settingsMessage}
          error={settingsError}
          saving={settingsSaving}
          onChange={setDraft}
          onSave={() => void saveSettings()}
          onClose={() => {
            if (!settingsSaving) setSettingsOpen(false);
          }}
        />
      )}
    </div>
  );
}

function PhotoActionsSheet({
  busy,
  onRotateLeft,
  onRotateRight,
  onArchive,
  onClose,
}: {
  busy: boolean;
  onRotateLeft: () => void;
  onRotateRight: () => void;
  onArchive: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="photo-actions"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        className="photo-actions-backdrop"
        aria-label="Dismiss"
        onClick={onClose}
        disabled={busy}
      />
      <div className="photo-actions-sheet" role="dialog" aria-label="Photo actions">
        <div className="photo-actions-handle" />
        <p className="photo-actions-title">This photo</p>
        <div className="photo-actions-row">
          <button
            type="button"
            className="photo-action"
            onClick={onRotateLeft}
            disabled={busy}
          >
            <span className="photo-action-glyph" aria-hidden="true">
              ↺
            </span>
            Rotate left
          </button>
          <button
            type="button"
            className="photo-action"
            onClick={onRotateRight}
            disabled={busy}
          >
            <span className="photo-action-glyph" aria-hidden="true">
              ↻
            </span>
            Rotate right
          </button>
        </div>
        <button
          type="button"
          className="photo-action photo-action-danger"
          onClick={onArchive}
          disabled={busy}
        >
          Archive in Immich
        </button>
        <button
          type="button"
          className="photo-action photo-action-cancel"
          onClick={onClose}
          disabled={busy}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function KioskSettings({
  draft,
  albums,
  people,
  token,
  message,
  error,
  saving = false,
  onChange,
  onSave,
  onClose,
}: {
  draft: Frame;
  albums: Album[];
  people: Person[];
  token: string;
  message: string;
  error: string;
  saving?: boolean;
  onChange: (frame: Frame) => void;
  onSave: () => void;
  onClose: () => void;
}) {
  return (
    <div
      className="kiosk-settings"
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="kiosk-settings-panel panel">
        <div className="kiosk-settings-header">
          <div>
            <span className="eyebrow">FRAME SETTINGS</span>
            <h2>{draft.name}</h2>
          </div>
          <button
            type="button"
            className="secondary touch-btn"
            onClick={onClose}
            disabled={saving}
          >
            Close
          </button>
        </div>

        <div className="kiosk-settings-body">
          {(message || error) && (
            <div className={error ? "notice error" : "notice"}>
              {error || message}
            </div>
          )}
          <FrameFields
            frame={draft}
            albums={albums}
            people={people}
            personThumbnailUrl={(personId) =>
              api.kioskPersonThumbnailUrl(token, personId)
            }
            onChange={onChange}
          />
        </div>

        <div className="kiosk-settings-footer">
          <button
            className="primary touch-btn"
            type="button"
            onClick={onSave}
            disabled={saving}
            aria-busy={saving}
          >
            {saving ? "Saving…" : "Save settings"}
          </button>
        </div>
      </div>
    </div>
  );
}

function GestureGuide({
  showActions,
  fading,
  onSettings,
  onPrev,
  onNext,
  onActions,
}: {
  showActions: boolean;
  fading: boolean;
  onSettings: () => void;
  onPrev: () => void;
  onNext: () => void;
  onActions?: () => void;
}) {
  function activate(action?: () => void) {
    return (event: PointerEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      event.preventDefault();
      if (fading || !action) return;
      action();
    };
  }

  return (
    <div className={`gesture-guide${fading ? " fading" : ""}`}>
      <button
        type="button"
        className="gesture-guide-slot up"
        aria-label="Open settings"
        disabled={fading}
        onPointerDown={activate(onSettings)}
      >
        <span className="gesture-guide-arrow" aria-hidden="true">
          ↑
        </span>
        <span className="gesture-guide-label">Settings</span>
      </button>
      <button
        type="button"
        className="gesture-guide-slot left"
        aria-label="Previous photo"
        disabled={fading}
        onPointerDown={activate(onPrev)}
      >
        <span className="gesture-guide-arrow" aria-hidden="true">
          ←
        </span>
        <span className="gesture-guide-label">Previous</span>
      </button>
      <button
        type="button"
        className="gesture-guide-slot right"
        aria-label="Next photo"
        disabled={fading}
        onPointerDown={activate(onNext)}
      >
        <span className="gesture-guide-arrow" aria-hidden="true">
          →
        </span>
        <span className="gesture-guide-label">Next</span>
      </button>
      {showActions && onActions ? (
        <button
          type="button"
          className="gesture-guide-slot down"
          aria-label="Photo actions"
          disabled={fading}
          onPointerDown={activate(onActions)}
        >
          <span className="gesture-guide-arrow" aria-hidden="true">
            ↓
          </span>
          <span className="gesture-guide-label">Photo actions</span>
        </button>
      ) : (
        <button
          type="button"
          className="gesture-guide-slot down muted"
          aria-label="Open settings"
          disabled={fading}
          onPointerDown={activate(onSettings)}
        >
          <span className="gesture-guide-label">Hold for settings</span>
        </button>
      )}
    </div>
  );
}

function useKioskGestures({
  enabled,
  onPrev,
  onNext,
  onOpenSettings,
  onOpenActions,
  onCenterTap,
}: {
  enabled: boolean;
  onPrev: () => void;
  onNext: () => void;
  onOpenSettings: () => void;
  onOpenActions?: () => void;
  onCenterTap?: () => void;
}) {
  const start = useRef<{
    x: number;
    y: number;
    time: number;
    pointerId: number;
  } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressFired = useRef(false);
  const moved = useRef(false);

  function clearLongPress() {
    if (longPressTimer.current !== null) {
      window.clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  }

  function onPointerDown(event: PointerEvent<HTMLDivElement>) {
    if (!enabled) return;
    if (event.button !== 0 && event.pointerType === "mouse") return;

    longPressFired.current = false;
    moved.current = false;
    start.current = {
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
      pointerId: event.pointerId,
    };

    clearLongPress();
    longPressTimer.current = window.setTimeout(() => {
      longPressFired.current = true;
      onOpenSettings();
    }, 650);

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch {
      // ignore
    }
  }

  function onPointerMove(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !start.current || start.current.pointerId !== event.pointerId) {
      return;
    }

    const dx = event.clientX - start.current.x;
    const dy = event.clientY - start.current.y;
    if (Math.hypot(dx, dy) > 18) {
      moved.current = true;
      clearLongPress();
    }
  }

  function onPointerUp(event: PointerEvent<HTMLDivElement>) {
    if (!enabled || !start.current || start.current.pointerId !== event.pointerId) {
      return;
    }

    clearLongPress();
    const origin = start.current;
    start.current = null;

    if (longPressFired.current) return;

    const dx = event.clientX - origin.x;
    const dy = event.clientY - origin.y;
    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const width = event.currentTarget.clientWidth || window.innerWidth;

    // Horizontal swipe
    if (absX > 56 && absX > absY * 1.2) {
      if (dx < 0) onNext();
      else onPrev();
      return;
    }

    // Vertical swipe up opens settings (hidden control)
    if (dy < -72 && absY > absX * 1.2) {
      onOpenSettings();
      return;
    }

    // Vertical swipe down opens photo actions (when enabled)
    if (onOpenActions && dy > 72 && absY > absX * 1.2) {
      onOpenActions();
      return;
    }

    // Tap left / right edges to step photos; center shows gesture guide
    if (!moved.current && Date.now() - origin.time < 350) {
      if (origin.x < width * 0.28) onPrev();
      else if (origin.x > width * 0.72) onNext();
      else onCenterTap?.();
    }
  }

  function onPointerCancel() {
    clearLongPress();
    start.current = null;
  }

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
  };
}

type StageLayer = {
  id: string;
  url: string;
  pan: number;
  role: "current" | "outgoing";
};

function pickPanVariant(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return (hash % 4) + 1;
}

function KioskStage({
  token,
  asset,
  nextAsset,
  imageFit,
  intervalSeconds,
  slideshow,
  rotations = {},
  onImageError,
}: {
  token: string;
  asset: Asset;
  nextAsset: Asset | null;
  imageFit: Frame["image_fit"];
  intervalSeconds: number;
  slideshow: SlideshowSettings;
  rotations?: Record<string, number>;
  onImageError?: (assetId: string) => void;
}) {
  const [layers, setLayers] = useState<StageLayer[]>([]);
  const errorSkipRef = useRef<string | null>(null);
  const transitionMs =
    slideshow.transition === "none"
      ? 0
      : TRANSITION_MS[slideshow.transition_speed];
  const reduceMotion =
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const panEnabled = slideshow.pan !== "off" && !reduceMotion;
  const backdropUrl = api.kioskAssetUrl(token, asset.id);
  const currentRotation = rotations[asset.id] || 0;
  const backdropRotateStyle =
    currentRotation % 360 === 0
      ? undefined
      : ({ transform: `rotate(${currentRotation}deg)` } as CSSProperties);

  useEffect(() => {
    errorSkipRef.current = null;
    const url = api.kioskAssetUrl(token, asset.id);
    const nextLayer: StageLayer = {
      id: asset.id,
      url,
      pan: pickPanVariant(asset.id),
      role: "current",
    };

    setLayers((previous) => {
      const current = previous.find((layer) => layer.role === "current");
      if (!current) return [nextLayer];
      if (current.id === asset.id) return previous;

      if (slideshow.transition === "none" || transitionMs <= 0) {
        return [nextLayer];
      }

      return [
        { ...current, role: "outgoing" },
        nextLayer,
      ];
    });
  }, [asset.id, token, slideshow.transition, transitionMs]);

  useEffect(() => {
    if (slideshow.transition === "none" || transitionMs <= 0) return;
    const hasOutgoing = layers.some((layer) => layer.role === "outgoing");
    if (!hasOutgoing) return;
    const timer = window.setTimeout(() => {
      setLayers((previous) =>
        previous.filter((layer) => layer.role === "current"),
      );
    }, transitionMs + 40);
    return () => window.clearTimeout(timer);
  }, [layers, slideshow.transition, transitionMs]);

  function handleImageError(assetId: string) {
    if (errorSkipRef.current === assetId) return;
    errorSkipRef.current = assetId;
    onImageError?.(assetId);
  }

  return (
    <div
      className="kiosk-stage"
      data-transition={slideshow.transition}
      data-pan={panEnabled ? slideshow.pan : "off"}
      style={
        {
          "--transition-ms": `${transitionMs}ms`,
          "--pan-ms": `${Math.max(intervalSeconds, 3) * 1000}ms`,
        } as CSSProperties
      }
    >
      {slideshow.backdrop !== "black" && (
        <div className={`kiosk-backdrop backdrop-${slideshow.backdrop}`}>
          <div className="kiosk-photo-rotate" style={backdropRotateStyle}>
            <img src={backdropUrl} alt="" draggable={false} />
          </div>
        </div>
      )}

      <div className="kiosk-photo-stack">
        {layers.map((layer) => {
          // Look up by layer id (not current asset) so outgoing slides keep
          // their rotation through the crossfade — same idea as pan-on-image.
          const degrees = rotations[layer.id] || 0;
          const layerRotate =
            degrees % 360 === 0
              ? undefined
              : ({ transform: `rotate(${degrees}deg)` } as CSSProperties);
          return (
            <div
              key={layer.id}
              className={`kiosk-photo-layer role-${layer.role}`}
            >
              <div className="kiosk-photo-rotate" style={layerRotate}>
                <img
                  className={`kiosk-photo pan-${layer.pan}`}
                  draggable={false}
                  src={layer.url}
                  style={{ objectFit: imageFit }}
                  alt=""
                  onError={() => {
                    if (layer.role === "current") {
                      handleImageError(layer.id);
                    }
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>

      {nextAsset && (
        <img
          aria-hidden="true"
          className="preload"
          src={api.kioskAssetUrl(token, nextAsset.id)}
        />
      )}
    </div>
  );
}

function formatClockDate(
  date: Date,
  format: OverlaySettings["clock_date_format"],
): string {
  if (format === "none") return "";
  if (format === "weekday") {
    return date.toLocaleDateString(undefined, { weekday: "long" });
  }
  if (format === "short") {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
    });
  }
  return date.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
}

function formatPhotoDate(
  value: string,
  format: OverlaySettings["photo_date_format"],
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  if (format === "numeric") {
    return date.toLocaleDateString(undefined);
  }
  if (format === "short") {
    return date.toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  return date.toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

function ClockOverlay({
  now,
  overlay,
  alignEnd,
}: {
  now: Date;
  overlay: OverlaySettings;
  alignEnd: boolean;
}) {
  const hour12 = overlay.clock_format === "12h";
  const parts = new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    second: overlay.clock_show_seconds ? "2-digit" : undefined,
    hour12,
  }).formatToParts(now);
  const hour = parts.find((p) => p.type === "hour")?.value ?? "";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "";
  const second = parts.find((p) => p.type === "second")?.value;
  const dayPeriod = parts.find((p) => p.type === "dayPeriod")?.value ?? "";
  const dateText = formatClockDate(now, overlay.clock_date_format);
  const timeText =
    overlay.clock_show_seconds && second
      ? `${hour}:${minute}:${second}`
      : `${hour}:${minute}`;

  return (
    <div
      className={alignEnd ? "clock-block align-end" : "clock-block"}
      data-scale={overlay.clock_scale}
      data-seconds={overlay.clock_show_seconds ? "1" : "0"}
    >
      <div className="clock">
        <span className="clock-time">{timeText}</span>
        {hour12 && dayPeriod && (
          <span className="clock-meridiem">{dayPeriod}</span>
        )}
      </div>
      {dateText && <div className="today">{dateText}</div>}
    </div>
  );
}

function WeatherOverlay({
  weather,
  locationConfigured,
  scale = "medium",
}: {
  weather?: Weather | null;
  locationConfigured: boolean;
  scale?: OverlayScale;
}) {
  if (!weather) {
    return (
      <div
        className="weather-panel weather-panel-empty"
        data-scale={scale}
      >
        {locationConfigured ? "Weather unavailable" : "Set a weather location"}
      </div>
    );
  }

  const tempText = `${Math.round(weather.temperature)}°${weather.units}`;
  const wrapAt =
    scale === "quarter" || scale === "huge"
      ? 28
      : scale === "xlarge" || scale === "large"
        ? 24
        : 22;
  const descLines = wrapWeatherDescription(weather.description, wrapAt);
  const iconUrl = weather.icon ? api.weatherIconUrl(weather.icon) : null;

  return (
    <div
      className={
        descLines.length > 1
          ? "weather-panel weather-panel-two-line"
          : "weather-panel weather-panel-one-line"
      }
      data-scale={scale}
    >
      {iconUrl && (
        <img
          className="weather-icon"
          src={iconUrl}
          alt=""
          draggable={false}
        />
      )}
      <div className="weather-copy">
        <div className="weather-temp">{tempText}</div>
        {descLines.map((line) => (
          <div className="weather-desc" key={line}>
            {line}
          </div>
        ))}
      </div>
    </div>
  );
}

/** Wrap weather description at ~22 chars on word boundaries, max 2 lines. */
function wrapWeatherDescription(description: string, wrapAt = 22): string[] {
  const text = description.trim();
  if (!text) return [];
  if (text.length <= wrapAt) return [text];

  const words = text.split(/\s+/);
  let line1 = "";
  let index = 0;
  for (; index < words.length; index += 1) {
    const next = line1 ? `${line1} ${words[index]}` : words[index];
    if (next.length > wrapAt && line1) break;
    line1 = next;
  }
  const line2 = words.slice(index).join(" ");
  return line2 ? [line1, line2] : [line1];
}

function KioskMessage({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <div className="kiosk-message">
      <div>
        <div className="frame-icon">▣</div>
        <h1>{title}</h1>
        {detail && <p>{detail}</p>}
      </div>
    </div>
  );
}

export default App;
