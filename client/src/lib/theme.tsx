import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@databricks/appkit-ui/react";

// Appearance preference for LensIQ. AppKit UI darkens Card / Button / etc.
// via `.dark` on the document element (and via prefers-color-scheme when
// neither `.dark` nor `.light` is set). Pages still use a lot of hardcoded
// `bg-white` / `text-slate-900` utilities, so we always resolve the
// preference to an explicit `.light` or `.dark` class and remap those
// utilities under `html.dark` in index.css. That keeps the shell and
// AppKit components from fighting when the OS is in dark mode.

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "lensiq-theme";

type ThemeContextValue = {
  preference: ThemePreference;
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

function _readStored(): ThemePreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === "light" || raw === "dark" || raw === "system") return raw;
  } catch {
    // private mode / blocked storage - fall through to system
  }
  return "system";
}

function _systemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? _systemTheme() : preference;
}

/** Apply the resolved class on <html>. Always set one of .light / .dark so
 *  AppKit's media-query fallback never fights an explicit user choice. */
export function applyThemeClass(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.classList.toggle("light", resolved === "light");
  root.style.colorScheme = resolved;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(() => _readStored());
  const [resolved, setResolved] = useState<ResolvedTheme>(() => resolveTheme(_readStored()));

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // ignore
    }
    const nextResolved = resolveTheme(next);
    setResolved(nextResolved);
    applyThemeClass(nextResolved);
  }, []);

  useEffect(() => {
    const nextResolved = resolveTheme(preference);
    setResolved(nextResolved);
    applyThemeClass(nextResolved);

    if (preference !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      const sys = resolveTheme("system");
      setResolved(sys);
      applyThemeClass(sys);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [preference]);

  return (
    <ThemeContext.Provider value={{ preference, resolved, setPreference }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within ThemeProvider");
  return ctx;
}

const OPTIONS: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];

/** Header control: System / Light / Dark. Defaults to System. */
export function ThemeToggle() {
  const { preference, setPreference } = useTheme();
  const ActiveIcon = OPTIONS.find((o) => o.value === preference)?.icon ?? Monitor;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-2"
          aria-label={`Theme: ${preference}`}
          title="Appearance"
        >
          <ActiveIcon className="w-4 h-4" />
          <span className="hidden sm:inline capitalize">{preference}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {OPTIONS.map(({ value, label, icon: Icon }) => (
          <DropdownMenuItem
            key={value}
            onClick={() => setPreference(value)}
            className="gap-2"
          >
            <Icon className="w-4 h-4" />
            {label}
            {preference === value ? (
              <span className="ml-auto text-xs text-muted-foreground">active</span>
            ) : null}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
