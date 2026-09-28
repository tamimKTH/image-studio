import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Activity, Images, Monitor, Moon, Sparkles, Sun, Workflow } from "lucide-react";
import { api, type Status } from "../lib/api";
import { useActiveCount, useLive } from "../lib/events";
import { applyTheme, loadTheme, type Theme } from "../lib/prefs";
import { IconButton, Popover, cx, usePopover } from "./ui";
import s from "./Shell.module.css";

const NAV = [
  { to: "/", label: "Create", icon: Sparkles, end: true },
  { to: "/workflows", label: "Workflows", icon: Workflow, end: false },
  { to: "/activity", label: "Activity", icon: Activity, end: false },
  { to: "/library", label: "Library", icon: Images, end: false },
];

const THEME_NEXT: Record<Theme, Theme> = { system: "light", light: "dark", dark: "system" };
const THEME_ICON = { system: Monitor, light: Sun, dark: Moon };

export function Shell({ children }: { children: ReactNode }) {
  const active = useActiveCount();
  const [theme, setTheme] = useState<Theme>(loadTheme);
  useEffect(() => applyTheme(theme), [theme]);
  const ThemeIcon = THEME_ICON[theme];

  return (
    <div className={s.shell}>
      <nav className={s.rail} aria-label="Main">
        <div className={s.logo} aria-hidden>
          <Sparkles size={20} />
        </div>
        {NAV.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cx(s.item, isActive && s.active)}>
            <Icon size={20} strokeWidth={1.9} />
            {label}
            {to === "/activity" && active > 0 && <span className={s.badge}>{active}</span>}
          </NavLink>
        ))}
        <div className={s.spacer} />
        <EngineIndicator />
        <IconButton label={`Theme: ${theme}`} onClick={() => setTheme(THEME_NEXT[theme])}>
          <ThemeIcon size={18} />
        </IconButton>
      </nav>
      <main className={s.main}>{children}</main>
    </div>
  );
}

function EngineIndicator() {
  const engine = useLive((st) => st.engine);
  const connected = useLive((st) => st.connected);
  const pop = usePopover();
  const [status, setStatus] = useState<Status | null>(null);

  useEffect(() => {
    if (pop.open) api.status().then(setStatus).catch(() => setStatus(null));
  }, [pop.open]);

  const online = connected && engine?.online;
  const busy = online && (engine?.queue ?? 0) > 0;
  const label = !connected ? "App offline" : !online ? "Engine offline" : busy ? "Generating" : "Engine ready";
  const models = status?.models;

  return (
    <>
      <button ref={pop.anchor} className={s.engineButton} onClick={pop.toggle} aria-label={label} title={label}>
        <span className={cx(s.dot, busy ? s.busy : online ? s.online : s.offline)} />
      </button>
      <Popover anchor={pop.anchor} open={pop.open} onClose={pop.close} placement="top-start" width={300}>
        <div className={s.enginePanel}>
          <div className={s.engineTitle}>
            <span className={cx(s.dot, busy ? s.busy : online ? s.online : s.offline)} />
            {label}
          </div>
          {online ? (
            <div>
              Qwen-Image 2.1 on this Mac ({engine?.device === "mps" ? "Apple GPU" : engine?.device}).{" "}
              {engine?.queue ? `${engine.queue} in the queue.` : "Nothing in the queue."}
            </div>
          ) : (
            <>
              <div>{connected ? "The local engine is not running. Start it from the project folder:" : "Can't reach the app."}</div>
              <div className={s.fix}>./studio start</div>
            </>
          )}
          {models && (
            <div>
              {(
                [
                  ["Image model", models.generator],
                  ["Text encoder", models.textEncoder],
                  ["VAE", models.vae],
                  ["Prompt improver", models.enhancerT2I && models.enhancerI2I],
                ] as const
              ).map(([name, ok]) => (
                <div key={name} className={s.modelRow}>
                  <span>{name}</span>
                  <span className={ok ? s.ok : s.missing}>{ok ? "Ready" : "Missing"}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </Popover>
    </>
  );
}
