import * as React from 'react';

/**
 * Dark is the product's default look. Light is a preference someone opts
 * into, so only that choice is persisted — there is nothing to store for
 * "use the default".
 */
export type Theme = 'dark' | 'light';

const STORAGE_KEY = 'avcrm.theme';

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

function readStored(): Theme {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'light' ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

function apply(theme: Theme): void {
  if (theme === 'light') document.documentElement.dataset.theme = 'light';
  else delete document.documentElement.dataset.theme;
}

export function ThemeProvider({ children }: { children: React.ReactNode }): JSX.Element {
  const [theme, setTheme] = React.useState<Theme>(readStored);

  React.useEffect(() => {
    apply(theme);
    try {
      if (theme === 'light') localStorage.setItem(STORAGE_KEY, 'light');
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // A private window can refuse storage; the theme still applies for
      // this load, it just will not be remembered for the next one.
    }
  }, [theme]);

  const toggle = React.useCallback(() => {
    setTheme((current) => (current === 'dark' ? 'light' : 'dark'));
  }, []);

  const value = React.useMemo(() => ({ theme, toggle }), [theme, toggle]);

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = React.useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within a ThemeProvider');
  return ctx;
}
