import { useEffect } from 'react';

/**
 * Locks `document.body` scrolling while `active` is true, restoring the
 * previous value on cleanup. Extracted from the duplicated logic that used
 * to live in Modal and Sidebar so overlays share one implementation.
 */
let lockCount = 0;
let previousOverflow: string | null = null;

export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) {
      previousOverflow = document.body.style.overflow;
      document.body.style.overflow = 'hidden';
    }
    lockCount++;
    return () => {
      lockCount--;
      if (lockCount === 0 && previousOverflow !== null) {
        document.body.style.overflow = previousOverflow;
        previousOverflow = null;
      }
      if (lockCount < 0) lockCount = 0;
    };
  }, [active]);
}
