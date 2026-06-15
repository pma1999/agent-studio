import { AnimatePresence, motion } from 'framer-motion';
import { useStore } from '../../stores/store';
import { useIsMobile, usePrefersReducedMotion } from '../../utils/breakpoints';
import { useVisualViewport } from '../../hooks/useVisualViewport';
import { navItems } from '../navItems';

/**
 * Mobile bottom tab bar for the five primary sections. Rendered in-flow at the
 * bottom of <main> (so it never overlaps content) and slides away while the
 * user is composing / the keyboard is up / the drawer is open. Desktop never
 * mounts it (returns null).
 */
export function BottomNav() {
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();
  const currentView = useStore((s) => s.currentView);
  const setCurrentView = useStore((s) => s.setCurrentView);
  const composerFocused = useStore((s) => s.composerFocused);
  const sidebarMobileOpen = useStore((s) => s.sidebarMobileOpen);
  const { keyboardOpen } = useVisualViewport();

  if (!isMobile) return null;

  const hidden = composerFocused || keyboardOpen || sidebarMobileOpen;

  return (
    <AnimatePresence initial={false}>
      {!hidden && (
        <motion.nav
          className="bottom-nav"
          aria-label="Primary"
          initial={prefersReducedMotion ? { opacity: 0 } : { y: '100%' }}
          animate={prefersReducedMotion ? { opacity: 1 } : { y: 0 }}
          exit={prefersReducedMotion ? { opacity: 0 } : { y: '100%' }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.25, ease: [0.4, 0, 0.2, 1] }}
        >
          {navItems.map((item) => {
            const isActive = currentView === item.id;
            const Icon = item.icon;
            return (
              <button
                key={item.id}
                type="button"
                className={`bottom-nav-item ${isActive ? 'bottom-nav-item-active' : ''}`}
                onClick={() => setCurrentView(item.id)}
                aria-label={item.label}
                aria-current={isActive ? 'page' : undefined}
              >
                <Icon size={20} />
                <span className="bottom-nav-label">{item.label}</span>
              </button>
            );
          })}
        </motion.nav>
      )}
    </AnimatePresence>
  );
}
