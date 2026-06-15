import { Bot, MessageSquare, Wrench, Plug, Users, type LucideIcon } from 'lucide-react';
import type { View } from '../types';

export type NavView = Extract<View, 'chat' | 'agents' | 'councils' | 'tools' | 'mcp'>;

export interface NavItem {
  id: NavView;
  label: string;
  icon: LucideIcon;
}

/** Primary sections — shared by the desktop Sidebar rail and the mobile BottomNav. */
export const navItems: NavItem[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'agents', label: 'Agents', icon: Bot },
  { id: 'councils', label: 'Councils', icon: Users },
  { id: 'tools', label: 'Tools', icon: Wrench },
  { id: 'mcp', label: 'MCP', icon: Plug },
];
