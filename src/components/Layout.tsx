import React from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { IconButton } from './ui/IconButton';
import { useIsMobile } from '../utils/breakpoints';
import { useStore } from '../stores/store';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const isMobile = useIsMobile();
  const setSidebarMobileOpen = useStore((s) => s.setSidebarMobileOpen);
  const menuOpen = useStore((s) => s.sidebarMobileOpen);

  return (
    <div className="app-shell">
      <Sidebar />
      <main style={{
        flex: 1,
        minWidth: 0,
        overflow: 'hidden',
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
      }}>
        {isMobile && (
          <div style={{
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            padding: '12px var(--content-padding-x)',
            borderBottom: '1px solid var(--border)',
            background: 'var(--bg-base)',
            minHeight: 44,
          }}>
            <IconButton
              id="sidebar-open-menu-btn"
              label="Open menu"
              size="lg"
              onClick={() => setSidebarMobileOpen(true)}
              aria-expanded={menuOpen}
              style={{ marginLeft: -6 }}
            >
              <Menu size={22} />
            </IconButton>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
