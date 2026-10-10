import { useEffect, useState } from 'react';
import type { AppTheme } from '@/utils/theme';

/**
 * Reactively track the active theme by observing `data-theme` on <html>.
 *
 * Theme is applied imperatively via `applyTheme()` (attribute + localStorage), no store.
 * A MutationObserver keeps this decoupled: any caller that flips the theme
 * (ProfilePage live-preview, SSO sync, FOUC guard) is picked up without wiring,
 * so theme-dependent UI (light vs dark logo) updates instantly.
 */
export function useCurrentTheme(): AppTheme {
  const [theme, setTheme] = useState<AppTheme>(
    () => (document.documentElement.dataset.theme as AppTheme) || 'obli-operator',
  );

  useEffect(() => {
    const el = document.documentElement;
    const sync = () => setTheme((el.dataset.theme as AppTheme) || 'obli-operator');
    sync();
    const obs = new MutationObserver(sync);
    obs.observe(el, { attributes: true, attributeFilter: ['data-theme'] });
    return () => obs.disconnect();
  }, []);

  return theme;
}
