import { useState } from 'react';
import { Menu, Plus, Share2 } from 'lucide-react';
import { useStore } from '../../stores/store';
import { useChat } from '../../hooks/useChat';
import { useIsMobile } from '../../utils/breakpoints';
import { IconButton } from '../ui/IconButton';
import { ShareDialog } from '../ShareDialog';
import { navItems } from '../navItems';

/**
 * Sticky mobile top app bar. Always present at the top of <main> (flex-shrink:0,
 * never scrolls away) so the menu control is always reachable — fixing the
 * "hamburger becomes inaccessible" complaint. Shows a context title and, in the
 * chat view, a quick New-chat action. Desktop never mounts it.
 */
export function MobileTopBar() {
  const isMobile = useIsMobile();
  const currentView = useStore((s) => s.currentView);
  const setSidebarMobileOpen = useStore((s) => s.setSidebarMobileOpen);
  const sidebarMobileOpen = useStore((s) => s.sidebarMobileOpen);
  const conversations = useStore((s) => s.conversations);
  const activeConversationId = useStore((s) => s.activeConversationId);
  const authRequired = useStore((s) => s.authRequired);
  const { startGeneralChat } = useChat();
  const [shareOpen, setShareOpen] = useState(false);

  if (!isMobile) return null;

  const navLabel = navItems.find((n) => n.id === currentView)?.label;
  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const title =
    currentView === 'chat' ? activeConv?.title || 'New chat' : navLabel ?? 'Agent Studio';

  return (
    <header className="mobile-topbar">
      <IconButton
        id="sidebar-open-menu-btn"
        label="Open menu"
        size="lg"
        onClick={() => setSidebarMobileOpen(true)}
        aria-expanded={sidebarMobileOpen}
      >
        <Menu size={22} />
      </IconButton>
      <h1 className="mobile-topbar-title">{title}</h1>
      {currentView === 'chat' && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
          <IconButton
            label="Share conversation"
            title={
              !authRequired
                ? 'Sharing requires accounts (hosted deployments)'
                : !activeConversationId
                  ? 'Open a conversation to share it'
                  : undefined
            }
            disabled={!authRequired || !activeConversationId}
            onClick={() => setShareOpen(true)}
          >
            <Share2 size={22} />
          </IconButton>
          <IconButton label="New chat" size="lg" onClick={() => startGeneralChat()}>
            <Plus size={22} />
          </IconButton>
          {activeConversationId && (
            <ShareDialog
              isOpen={shareOpen}
              conversationId={activeConversationId}
              onClose={() => setShareOpen(false)}
            />
          )}
        </div>
      )}
    </header>
  );
}
