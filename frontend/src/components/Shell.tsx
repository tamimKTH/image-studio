import { useEffect, useState, type ReactNode } from "react";
import { NavLink } from "react-router-dom";
import { Activity, Check, Images, Monitor, Moon, Sparkles, Sun, Workflow } from "lucide-react";
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

const THEMES: { value: Theme; label: string; icon: typeof Monitor }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

export function Shell({ children }: { children: ReactNode }) {
  const active = useActiveCount();

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
        <ThemeSwitch />
      </nav>
      <main className={s.main}>{children}</main>
    </div>
  );
}

/** The operating system's own light/dark setting, kept live. */
function useSystemDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return dark;
}

/** System follows macOS or Windows live; Light and Dark force a theme. */
function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(loadTheme);
  const systemDark = useSystemDark();
  const pop = usePopover();
  useEffect(() => applyTheme(theme), [theme]);
  const current = THEMES.find((t) => t.value === theme) ?? THEMES[0];

  return (
    <>
      <IconButton ref={pop.anchor} label={`Theme: ${current.label}`} active={pop.open} onClick={pop.toggle}>
        <current.icon size={18} />
      </IconButton>
      <Popover anchor={pop.anchor} open={pop.open} onClose={pop.close} placement="top-start" title="Theme" width={220}>
        <div role="menu" aria-label="Theme">
          {THEMES.map((t) => (
            <button
              key={t.value}
              type="button"
              role="menuitemradio"
              aria-checked={theme === t.value}
              className={cx(s.themeItem, theme === t.value && s.themeOn)}
              onClick={() => {
                setTheme(t.value);
                pop.close();
              }}
            >
              <t.icon size={16} />
              <span className={s.themeLabel}>
                {t.label}
                {t.value === "system" && <span className={s.themeHint}>{systemDark ? "Dark" : "Light"} on this computer</span>}
              </span>
              {theme === t.value && <Check size={16} className={s.themeCheck} />}
            </button>
          ))}
        </div>
      </Popover>
    </>
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
