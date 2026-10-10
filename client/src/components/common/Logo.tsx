import { useCurrentTheme } from '@/hooks/useCurrentTheme';

interface LogoProps {
  className?: string;
  alt?: string;
}

/**
 * Oblihub wordmark that swaps with the active theme.
 *   - `logo.svg`          → hub in white, sized for dark themes.
 *   - `logo-daylight.svg` → hub in black, sized for the Obli Daylight light theme.
 * Both share the same viewBox so they are drop-in interchangeable.
 * The test below is a whitelist of LIGHT themes: every other theme, including
 * the mid-dark Obli Dim, gets the white wordmark.
 */
export function Logo({ className, alt = 'Oblihub' }: LogoProps) {
  const theme = useCurrentTheme();
  const src = theme === 'obli-daylight' ? '/logo-daylight.svg' : '/logo.svg';
  return <img src={src} alt={alt} className={className} />;
}
