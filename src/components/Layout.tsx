import React from 'react';
import { Menu } from 'lucide-react';
import { Sidebar } from './Sidebar';
import { useIsMobile } from '../utils/breakpoints';
import { useStore } from '../stores/store';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const isMobile = useIsMobile();
  const setSidebarMobileOpen = useStore((s) => s.setSidebarMobileOpen);

  return (
    <div style={{
      display: 'flex',
      height: '100vh',
      width: '100vw',
      overflow: 'hidden',
      background: 'var(--bg-deepest)',
    }}>
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
            <button
              type="button"
              onClick={() => setSidebarMobileOpen(true)}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 44,
                height: 44,
                margin: -8,
                marginLeft: -4,
                background: 'transparent',
                border: 'none',
                borderRadius: 'var(--radius-sm)',
                color: 'var(--text-secondary)',
                cursor: 'pointer',
                transition: 'all var(--transition-fast)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = 'var(--bg-hover)';
                e.currentTarget.style.color = 'var(--text-primary)';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = 'transparent';
                e.currentTarget.style.color = 'var(--text-secondary)';
              }}
              aria-label="Open menu"
            >
              <Menu size={22} />
            </button>
          </div>
        )}
        {children}
      </main>
    </div>
  );
}
