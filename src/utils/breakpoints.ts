import { useState, useEffect } from 'react';

/**
 * Breakpoints (px) for responsive behavior.
 * xs: 0-479, sm: 480-767, md: 768-1023, lg: 1024-1279, xl: 1280+
 */
export const BREAKPOINTS = {
  sm: 480,
  md: 768,
  lg: 1024,
  xl: 1280,
} as const;

export const MOBILE_MAX = BREAKPOINTS.md - 1; // 767px — sidebar becomes drawer below md

const mobileQuery = `(max-width: ${MOBILE_MAX}px)`;

export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia(mobileQuery).matches : false
  );
  useEffect(() => {
    const mql = window.matchMedia(mobileQuery);
    const handler = () => setIsMobile(mql.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return isMobile;
}
