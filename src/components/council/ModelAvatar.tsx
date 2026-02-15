import React from 'react';
import { Cpu, Sparkles, Zap, Brain, Bot } from 'lucide-react';

interface ModelAvatarProps {
  modelId: string;
  size?: 'sm' | 'md' | 'lg';
  status?: 'pending' | 'running' | 'success' | 'error' | 'timeout';
  showGlow?: boolean;
}

const PROVIDER_CONFIG: Record<string, { color: string; icon: React.ReactNode; name: string }> = {
  anthropic: {
    color: '#d4a557',
    icon: <Sparkles size={16} />,
    name: 'Anthropic',
  },
  openai: {
    color: '#7ab88f',
    icon: <Zap size={16} />,
    name: 'OpenAI',
  },
  google: {
    color: '#6b9dc9',
    icon: <Brain size={16} />,
    name: 'Google',
  },
  'meta-llama': {
    color: '#a78bfa',
    icon: <Bot size={16} />,
    name: 'Meta',
  },
  meta: {
    color: '#a78bfa',
    icon: <Bot size={16} />,
    name: 'Meta',
  },
  default: {
    color: '#c9956b',
    icon: <Cpu size={16} />,
    name: 'AI',
  },
};

export function ModelAvatar({ modelId, size = 'md', status, showGlow }: ModelAvatarProps) {
  const provider = modelId.split('/')[0]?.toLowerCase() || 'default';
  const config = PROVIDER_CONFIG[provider] || PROVIDER_CONFIG.default;

  const sizeStyles = {
    sm: { width: 28, height: 28, fontSize: 12 },
    md: { width: 36, height: 36, fontSize: 14 },
    lg: { width: 48, height: 48, fontSize: 18 },
  };

  const s = sizeStyles[size];

  const getStatusStyles = () => {
    switch (status) {
      case 'running':
        return {
          borderColor: config.color,
          boxShadow: `0 0 0 2px ${config.color}40`,
          animation: 'councilPulse 2s ease-in-out infinite',
        };
      case 'success':
        return {
          borderColor: '#7ab88f',
          boxShadow: '0 0 0 2px rgba(122, 184, 143, 0.3)',
        };
      case 'error':
        return {
          borderColor: '#c96b6b',
          boxShadow: '0 0 0 2px rgba(201, 107, 107, 0.3)',
        };
      case 'timeout':
        return {
          borderColor: '#d4a557',
          boxShadow: '0 0 0 2px rgba(212, 165, 87, 0.3)',
        };
      default:
        return {
          borderColor: 'var(--border)',
          boxShadow: showGlow ? `0 0 20px ${config.color}30` : 'none',
        };
    }
  };

  return (
    <div
      style={{
        width: s.width,
        height: s.height,
        borderRadius: '50%',
        background: `linear-gradient(135deg, ${config.color}20 0%, ${config.color}08 100%)`,
        border: '2px solid',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: config.color,
        flexShrink: 0,
        transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
        ...getStatusStyles(),
      }}
    >
      {React.cloneElement(config.icon as React.ReactElement, { size: s.fontSize })}
    </div>
  );
}

export function getProviderColor(modelId: string): string {
  const provider = modelId.split('/')[0]?.toLowerCase() || 'default';
  return PROVIDER_CONFIG[provider]?.color || PROVIDER_CONFIG.default.color;
}

export function getProviderName(modelId: string): string {
  const provider = modelId.split('/')[0]?.toLowerCase() || 'default';
  return PROVIDER_CONFIG[provider]?.name || PROVIDER_CONFIG.default.name;
}

export function getModelDisplayName(modelId: string): string {
  const parts = modelId.split('/');
  const name = parts[parts.length - 1] || modelId;
  // Clean up common suffixes
  return name
    .replace(/-instruct$/, '')
    .replace(/-preview$/, '')
    .replace(/-latest$/, '')
    .replace(/-exp$/, '')
    .replace(/-fast$/, '');
}
