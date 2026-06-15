import React, { useRef } from 'react';
import { Sidebar } from './Sidebar';
import { MobileTopBar } from './mobile/MobileTopBar';
import { BottomNav } from './mobile/BottomNav';
import { useIsMobile } from '../utils/breakpoints';
import { useStore } from '../stores/store';

interface LayoutProps {
  children: React.ReactNode;
}

export function Layout({ children }: LayoutProps) {
  const isMobile = useIsMobile();
  const setSidebarMobileOpen = useStore((s) => s.setSidebarMobileOpen);

  // Open the drawer with a swipe that starts at the very left edge. No blocking
  // overlay — handlers live on the content wrapper so taps still pass through.
  const edgeStart = useRef<{ x: number; y: number } | null>(null);
  const onContentTouchStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    edgeStart.current = t.clientX <= 24 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onContentTouchEnd = (e: React.TouchEvent) => {
    const start = edgeStart.current;
    edgeStart.current = null;
    if (!start) return;
    const dx = e.changedTouches[0].clientX - start.x;
    const dy = e.changedTouches[0].clientY - start.y;
    if (dx > 50 && Math.abs(dx) > Math.abs(dy)) setSidebarMobileOpen(true);
  };

  return (
    <div className="app-shell">
      <Sidebar />
      <main
        style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {isMobile ? (
          <>
            <MobileTopBar />
            <div
              className="mobile-main-content"
              onTouchStart={onContentTouchStart}
              onTouchEnd={onContentTouchEnd}
            >
              {children}
            </div>
            <BottomNav />
          </>
        ) : (
          children
        )}
      </main>
    </div>
  );
}
