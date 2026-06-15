import { useEffect } from 'react';

/**
 * Locks `document.body` scrolling while `active` is true, restoring the
 * previous value on cleanup. Extracted from the duplicated logic that used
 * to live in Modal and Sidebar so overlays share one implementation.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [active]);
}
