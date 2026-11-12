import { useState } from "react";
import AIOrbScene from "./AIOrbScene";

const A = import.meta.env.DEV ? "/src/assets" : "/assets";

type Page =
  | "Dashboard"
  | "AI Assistant"
  | "Vision"
  | "Music"
  | "Navigation"
  | "Weather"
  | "Notifications"
  | "Device"
  | "Settings"
  | "Profile";

const navItems: { label: Page; icon: string; badge?: string }[] = [
  { label: "Dashboard", icon: "bc0e2.svg" },
  { label: "AI Assistant", icon: "362e6.svg" },
  { label: "Vision", icon: "e2679.svg" },
  { label: "Music", icon: "c2fa8.svg" },
  { label: "Navigation", icon: "5331f.svg" },
  { label: "Weather", icon: "23d58.svg" },
  { label: "Notifications", icon: "c8c91.svg", badge: "2" },
  { label: "Device", icon: "e2011.svg" },
  { label: "Settings", icon: "3ed27.svg" },
  { label: "Profile", icon: "c901f.svg" },
];

const pageDescriptions: Record<Page, string> = {
  Dashboard: "A calm overview of your connected world",
  "AI Assistant": "Personal intelligence, always within reach",
  Vision: "See, understand and remember what matters",
  Music: "Immersive audio for your spatial world",
  Navigation: "Quiet guidance, precisely when you need it",
  Weather: "Conditions around you, beautifully distilled",
  Notifications: "The signals that deserve your attention",
  Device: "Visionary One health and connection",
  Settings: "Shape your personal spatial experience",
  Profile: "Your identity and private workspace",
};

function Icon({ file, className = "" }: { file: string; className?: string }) {
  return <img className={`icon ${className}`} src={`${A}/${file}`} alt="" />;
}

function Panel({
  children,
  className = "",
  as: Tag = "section",
}: {
  children: React.ReactNode;
  className?: string;
  as?: "section" | "article" | "div";
}) {
  return <Tag className={`panel ${className}`}>{children}</Tag>;
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="eyebrow">{children}</p>;
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: () => void; label: string }) {
  return (
    <button
      className={`toggle ${on ? "is-on" : ""}`}
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={onChange}
    >
      <span />
    </button>
  );
}

function Orb({ compact = false, listening = false }: { compact?: boolean; listening?: boolean }) {
  return (
    <div className={`orb-stage ${compact ? "compact" : ""} ${listening ? "listening" : ""}`}>
      <div className="orb-aura" />
      <img src={`${A}/ba6b2.png`} alt="Nexus AI" />
      <div className="orb-shadow" />
    </div>
  );
}

function MiniDevice({ connected }: { connected: boolean }) {
  return (
    <Panel className="context-card device-mini">
      <div className="row between">
        <Eyebrow>Your device</Eyebrow>
        <span className="status">
          <i /> {connected ? "Connected" : "Not connected"}
        </span>
      </div>
      <div className="card-title-row">
        <div>
          <h3>Smart glasses</h3>
          <p>{connected ? "Synced to your workspace" : "Ready when your glasses are paired"}</p>
        </div>
        <span className="arrow">↗</span>
      </div>
      <div className="hairline" />
      <div className="row between meta">
        <span className="row">
          <Icon file="73050.svg" /> Device
        </span>
        <span>{connected ? "Device linked" : "Open Device to pair"}</span>
      </div>
    </Panel>
  );
}

function WeatherMini() {
  return (
    <Panel className="context-card weather-mini">
      <div className="row between">
        <Eyebrow>San Francisco</Eyebrow>
        <span className="arrow">↗</span>
      </div>
      <div className="temperature-line">
        <strong>18°</strong>
        <span>
          Mostly clear
          <br />
          <small>H: 20° L: 14°</small>
        </span>
        <Icon file="5b051.svg" />
      </div>
      <p>A clear evening for your walk home.</p>
    </Panel>
  );
}

function NowPlayingMini({
  playing,
  setPlaying,
}: {
  playing: boolean;
  setPlaying: (value: boolean) => void;
}) {
  return (
    <Panel className="context-card now-playing">
      <div className="row between">
        <Eyebrow>Now playing</Eyebrow>
        <Icon file="9c4ed.svg" />
      </div>
      <div className="track">
        <img src={`${A}/2ea1f.png`} alt="Weightless album artwork" />
        <div>
          <h3>Weightless</h3>
          <p>Marconi Union</p>
        </div>
      </div>
      <div className="progress">
        <span style={{ width: "36%" }} />
      </div>
      <div className="row between time">
        <span>2:34</span>
        <span>8:09</span>
      </div>
      <div className="player-controls">
        <button aria-label="Previous track">
          <Icon file="9ebf3.svg" />
        </button>
        <button
          className="play-small"
          aria-label={playing ? "Pause" : "Play"}
          onClick={() => setPlaying(!playing)}
        >
          {playing ? <Icon file="623ca.svg" /> : <span className="play-triangle" />}
        </button>
        <button aria-label="Next track">
          <Icon file="7b982.svg" />
        </button>
      </div>
    </Panel>
  );
}

type Props = {
  setActiveTab: (tab: "dashboard" | "ai" | "vision" | "music" | "weather" | "nav" | "notifications" | "whatsapp" | "calling" | "device" | "settings") => void
  displayName: string
  backendOnline: boolean
  glassesOnline: number
}

export default function SpatialDashboard({ setActiveTab, displayName, backendOnline, glassesOnline }: Props) {
  const [controls, setControls] = useState({ focus: true, audio: true, translate: false });
  return (
    <div className="content-grid dashboard-grid">
      <Panel className="hero-panel dashboard-hero">
        <div className="panel-toolbar">
          <span>
            <Icon file="9c4ed.svg" /> SPATIAL OVERVIEW
          </span>
          <span>LIVE</span>
        </div>
        <div className="dashboard-copy">
          <Eyebrow>Welcome, {displayName}</Eyebrow>
          <h2>Your world is in focus.</h2>
          <p>{glassesOnline > 0 ? "Your glasses are connected. Everything important is within reach." : "Your spatial workspace is ready. Connect your glasses whenever you are ready."}</p>
        </div>
        <AIOrbScene />
        <div className="quick-row">
          <button onClick={() => setActiveTab('ai')}>
            <Icon file="362e6.svg" />
            <span>
              <b>Ask Nexus</b>
              <small>Personal intelligence</small>
            </span>
            <i>↗</i>
          </button>
          <button onClick={() => setActiveTab('vision')}>
            <Icon file="e2679.svg" />
            <span>
              <b>Open vision</b>
              <small>Understand your view</small>
            </span>
            <i>↗</i>
          </button>
          <button onClick={() => setActiveTab('nav')}>
            <Icon file="5331f.svg" />
            <span>
              <b>Take me home</b>
              <small>Open route guidance</small>
            </span>
            <i>↗</i>
          </button>
        </div>
      </Panel>
      <div className="context-column">
        <MiniDevice connected={glassesOnline > 0} />
        <Panel className="context-card activity">
          <div className="row between">
            <Eyebrow>Recent activity</Eyebrow>
            <span className="arrow">↗</span>
          </div>
          {[
            ["362e6.svg", "AI assistant", backendOnline ? "Backend online" : "Backend unavailable"],
            ["e2679.svg", "Vision system", glassesOnline > 0 ? "Glasses linked" : "Ready to connect"],
            ["5331f.svg", "Navigation", "OpenStreetMap + OSRM"],
          ].map(([icon, title, sub]) => (
            <div className="activity-row" key={title}>
              <span className="icon-well">
                <Icon file={icon} />
              </span>
              <div>
                <b>{title}</b>
                <small>{sub}</small>
              </div>
            </div>
          ))}
        </Panel>
        <Panel className="context-card quick-controls">
          <Eyebrow>Quick controls</Eyebrow>
          {[
            ["Focus mode", "focus"],
            ["Spatial audio", "audio"],
            ["Live translate", "translate"],
          ].map(([label, key]) => (
            <div className="setting-row" key={key}>
              <span>{label}</span>
              <Toggle
                label={label}
                on={controls[key as keyof typeof controls]}
                onChange={() =>
                  setControls({ ...controls, [key]: !controls[key as keyof typeof controls] })
                }
              />
            </div>
          ))}
        </Panel>
      </div>
    </div>
  );
}
