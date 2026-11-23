'use client';

import { useEffect, useState } from 'react';
import { Moon, Sun } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { applyTheme, currentTheme, type Theme } from '@/lib/client/theme';
import { messages } from '@/lib/i18n/messages';

/** Light/dark switch. Until the browser reports the theme, it renders a neutral icon. */
export function ThemeToggle() {
  const t = messages.en;
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => { setTheme(currentTheme()); }, []);
  const label = theme === 'dark' ? t.themeToLight : t.themeToDark;
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      onClick={() => {
        const next: Theme = (theme ?? currentTheme()) === 'dark' ? 'light' : 'dark';
        applyTheme(next);
        setTheme(next);
      }}
    >
      {theme === 'dark' ? <Sun className="size-5" /> : <Moon className="size-5" />}
    </Button>
  );
}
