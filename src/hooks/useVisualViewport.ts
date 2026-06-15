import { useState, useEffect } from 'react';

export interface VisualViewportState {
  /** Heuristic: the on-screen keyboard is shrinking the visual viewport. */
  keyboardOpen: boolean;
  /** Current visual viewport height in px. */
  viewportHeight: number;
}

const KEYBOARD_THRESHOLD = 120;

/**
 * Tracks `window.visualViewport` to detect the mobile on-screen keyboard.
 * Used to hide the bottom navigation while the user is composing so the
 * keyboard + composer get the full screen. Safely inert where the API is
 * unavailable (returns keyboardOpen: false).
 */
export function useVisualViewport(): VisualViewportState {
  const [state, setState] = useState<VisualViewportState>(() => ({
    keyboardOpen: false,
    viewportHeight: typeof window !== 'undefined' ? window.innerHeight : 0,
  }));

  useEffect(() => {
    if (typeof window === 'undefined' || !window.visualViewport) return;
    const vv = window.visualViewport;
    let raf = 0;
    const update = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        setState({
          keyboardOpen: window.innerHeight - vv.height > KEYBOARD_THRESHOLD,
          viewportHeight: vv.height,
        });
      });
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      cancelAnimationFrame(raf);
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return state;
}
