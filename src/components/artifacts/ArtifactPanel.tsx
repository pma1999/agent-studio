import React, { useEffect, useMemo, useState } from 'react';
import { X, Maximize2, Minimize2 } from 'lucide-react';
import { useStore } from '../../stores/store';
import { Tabs } from '../ui/Tabs';
import { Segmented } from '../ui/Segmented';
import { Badge } from '../ui/Badge';
import { ArtifactViewer, type ArtifactViewMode } from './ArtifactViewer';
import type { ChatArtifact } from '../../types';

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(() =>
    typeof window !== 'undefined' ? window.matchMedia('(prefers-color-scheme: dark)').matches : true,
  );
  useEffect(() => {
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setDark(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return dark;
}

export function ArtifactPanel({
  conversationId,
  isFullscreen = false,
  onRequestFullscreen,
  onCloseFullscreen,
}: {
  conversationId: string;
  isFullscreen?: boolean;
  onRequestFullscreen?: () => void;
  onCloseFullscreen?: () => void;
}): React.JSX.Element | null {
  const artifactsByConversation = useStore((s) => s.artifactsByConversation[conversationId]);
  const activeArtifactId = useStore((s) => s.activeArtifactId);
  const artifactPanelOpen = useStore((s) => s.artifactPanelOpen);
  const setActiveArtifact = useStore((s) => s.setActiveArtifact);
  const closeArtifactPanel = useStore((s) => s.closeArtifactPanel);
  const dark = usePrefersDark();
  const [viewMode, setViewMode] = useState<ArtifactViewMode>('rendered');

  const artifacts: ChatArtifact[] = useMemo(
    () => (artifactsByConversation ? Object.values(artifactsByConversation) : []),
    [artifactsByConversation],
  );

  const activeArtifact: ChatArtifact | null = useMemo(() => {
    if (!artifactsByConversation || !activeArtifactId) return null;
    return artifactsByConversation[activeArtifactId] ?? null;
  }, [artifactsByConversation, activeArtifactId]);

  // Keep rendered/code coherent: code kind is single-view; others default to rendered on switch
  useEffect(() => {
    if (activeArtifact?.kind === 'code' && viewMode !== 'code') {
      setViewMode('code');
    }
  }, [activeArtifact?.kind, viewMode]);

  if (!artifactPanelOpen || !activeArtifact) return null;
  if (artifacts.length === 0) return null;

  const showSegmented = activeArtifact.kind !== 'code';
  const effectiveMode: ArtifactViewMode = activeArtifact.kind === 'code' ? 'code' : viewMode;

  const tabs = artifacts.map((a) => ({
    value: a.id,
    label: a.title || a.id.slice(0, 8),
  }));

  return (
    <div className="artifact-panel" role="complementary" aria-label="Artifact panel">

      <div className="artifact-panel-header">
        <div className="artifact-panel-title-row">
          <h3 className="artifact-panel-title" title={activeArtifact.title}>
            {activeArtifact.title}
          </h3>
          <Badge tone="mono" variant="soft">
            v{activeArtifact.version}
          </Badge>
          <Badge tone="neutral" variant="soft">
            {activeArtifact.kind}
          </Badge>
        </div>
        {isFullscreen ? (
          <button type="button" className="artifact-panel-close" onClick={onCloseFullscreen} aria-label="Exit artifact fullscreen (Esc)" title="Restaurar (Esc)">
            <Minimize2 size={16} />
          </button>
        ) : onRequestFullscreen ? (
          <button type="button" className="artifact-panel-close" onClick={onRequestFullscreen} aria-label="Enter artifact fullscreen" title="Pantalla completa">
            <Maximize2 size={16} />
          </button>
        ) : null}
        <button type="button" className="artifact-panel-close" onClick={closeArtifactPanel} aria-label="Close artifact panel">
          <X size={16} />
        </button>
      </div>

      {artifacts.length > 1 && (
        <Tabs tabs={tabs} value={activeArtifact.id} onChange={(id) => setActiveArtifact(conversationId, id)} className="artifact-panel-tabs" />
      )}

      {showSegmented && (
        <div className="artifact-panel-switch">
          <Segmented<ArtifactViewMode>
            ariaLabel="Artifact view mode"
            value={effectiveMode}
            onChange={(v) => setViewMode(v)}
            options={[
              { value: 'rendered', label: 'Rendered' },
              { value: 'code', label: 'Code' },
            ]}
          />
        </div>
      )}

      <div className="artifact-panel-body">
        <ArtifactViewer artifact={activeArtifact} mode={effectiveMode} dark={dark} />
      </div>
    </div>
  );
}
