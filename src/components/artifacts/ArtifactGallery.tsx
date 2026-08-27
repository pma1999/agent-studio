import React, { useMemo, useState, useEffect, useRef } from 'react';
import { Layers, Braces, Code, Image as ImageIcon, BarChart3, Search, X } from 'lucide-react';
import { useStore } from '../../stores/store';
import { useIsMobile } from '../../utils/breakpoints';
import { Sheet } from '../ui/Sheet';
import { Modal } from '../ui/Modal';
import { Badge } from '../ui/Badge';
import { Segmented } from '../ui/Segmented';
import {
  sortArtifactsByUpdatedAt,
  filterArtifactsByKind,
  searchArtifactsByTitle,
  truncateTitle,
  formatRelativeTime,
} from '../../utils/artifactWiring';
import type { ChatArtifact, ArtifactKind } from '../../types';

function KindIcon({ kind }: { kind: ArtifactKind }) {
  const iconProps = { size: 16, strokeWidth: 1.8 } as const;
  switch (kind) {
    case 'html':
      return <Layers {...iconProps} />;
    case 'code':
      return <Braces {...iconProps} />;
    case 'svg':
      return <ImageIcon {...iconProps} />;
    case 'mermaid':
      return <BarChart3 {...iconProps} />;
    default:
      return <Code {...iconProps} />;
  }
}

export function ArtifactGallery(props: {
  conversationId: string;
  isOpen: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const { conversationId, isOpen, onClose } = props;
  const isMobile = useIsMobile();

  const bucket = useStore((s) => s.artifactsByConversation[conversationId]);
  const setActiveArtifact = useStore((s) => s.setActiveArtifact);

  const [kindFilter, setKindFilter] = useState<ArtifactKind | 'all'>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Reset filters when conversation changes
  useEffect(() => {
    setKindFilter('all');
    setSearchQuery('');
  }, [conversationId]);

  // Sorting ASC (server order) via T2 helper
  const sorted: ChatArtifact[] = useMemo(() => {
    const arr = bucket ? (Object.values(bucket) as ChatArtifact[]) : [];
    return sortArtifactsByUpdatedAt(arr, 'asc');
  }, [bucket]);

  const filtered: ChatArtifact[] = useMemo(() => {
    const byKind = filterArtifactsByKind(sorted, kindFilter);
    return searchArtifactsByTitle(byKind, searchQuery);
  }, [sorted, kindFilter, searchQuery]);

  const totalCount = sorted.length;
  const filteredCount = filtered.length;

  // Focus restore to trigger on close (a11y)
  const prevActiveRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (isOpen) {
      prevActiveRef.current = document.activeElement as HTMLElement | null;
    } else if (prevActiveRef.current) {
      const el = prevActiveRef.current;
      prevActiveRef.current = null;
      // restore after exit animation
      requestAnimationFrame(() => el.focus?.());
    }
  }, [isOpen]);

  const handleOpen = (id: string) => {
    onClose();
    // Delay viewer open until gallery Sheet exit (0.32s) on mobile to avoid double useBodyScrollLock overlap (GC8).
    // Desktop dock has no scroll lock, so rAF is enough there.
    if (isMobile) {
      setTimeout(() => setActiveArtifact(conversationId, id), 350);
    } else {
      requestAnimationFrame(() => setActiveArtifact(conversationId, id));
    }
  };

  if (!conversationId) return null;

  const kindOptions: { value: ArtifactKind | 'all'; label: string }[] = [
    { value: 'all', label: 'All' },
    { value: 'html', label: 'HTML' },
    { value: 'code', label: 'Code' },
    { value: 'svg', label: 'SVG' },
    { value: 'mermaid', label: 'Mermaid' },
  ];

  const content = (
    <div className="artifact-gallery">
      {/* Filters */}
      <div className="artifact-gallery-filters">
        <Segmented
          ariaLabel="Filtrar por tipo"
          value={kindFilter}
          onChange={(v) => setKindFilter(v as ArtifactKind | 'all')}
          options={kindOptions}
        />
        <div className="artifact-gallery-search-wrap">
          <Search
            size={14}
            aria-hidden="true"
            style={{
              position: 'absolute',
              left: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--text-muted)',
              pointerEvents: 'none',
            }}
          />
          <input
            type="search"
            className="artifact-gallery-search"
            placeholder="Buscar por título..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            aria-label="Buscar artifacts por título"
          />
          {searchQuery && (
            <button
              type="button"
              className="artifact-gallery-search-clear"
              onClick={() => setSearchQuery('')}
              aria-label="Clear search"
            >
              <X size={14} />
            </button>
          )}
        </div>
        <div className="artifact-gallery-count" aria-live="polite">
          {filteredCount === totalCount ? `${totalCount} artifacts` : `${filteredCount} de ${totalCount}`}
        </div>
      </div>

      {/* Empty: 0 artifacts */}
      {totalCount === 0 ? (
        <div className="artifact-gallery-empty" role="status" aria-live="polite">
          <div className="artifact-gallery-empty-icon" aria-hidden="true">
            <Layers size={80} strokeWidth={1.15} />
          </div>
          <p className="artifact-gallery-empty-title">Aún no hay artifacts</p>
          <p className="artifact-gallery-empty-copy">
            pide al agente que cree uno: html / svg / mermaid / code
          </p>
          <p className="artifact-gallery-empty-hint">
            Ej: “crea una landing html” · “genera un diagrama mermaid” · “dibuja un icono svg” · “escribe un script code”
          </p>
        </div>
      ) : filteredCount === 0 ? (
        <div className="artifact-gallery-empty" role="status">
          <p className="artifact-gallery-empty-title" style={{ fontSize: '0.9375rem' }}>
            No se encontraron artifacts
          </p>
          <p className="artifact-gallery-empty-copy">Prueba con otro término o cambia el filtro.</p>
          <button
            type="button"
            className="artifact-gallery-empty-clear"
            onClick={() => {
              setKindFilter('all');
              setSearchQuery('');
            }}
          >
            Limpiar filtros
          </button>
        </div>
      ) : (
        <div className="artifact-gallery-grid" role="list">
          {filtered.map((art) => {
            const truncated = truncateTitle(art.title, 64);
            const relative = formatRelativeTime(art.updated_at);
            return (
              <button
                key={art.id}
                type="button"
                className="artifact-gallery-card"
                role="button"
                aria-label={`Open ${art.title}`}
                title={art.title}
                onClick={() => handleOpen(art.id)}
              >
                <div className="artifact-gallery-card-top">
                  <span className="artifact-gallery-card-icon" aria-hidden="true">
                    <KindIcon kind={art.kind} />
                  </span>
                  <span className="artifact-gallery-card-title" title={art.title}>
                    {truncated}
                  </span>
                </div>
                <div className="artifact-gallery-card-meta">
                  <Badge tone="neutral" variant="soft">
                    {art.kind}
                  </Badge>
                  <Badge tone="mono" variant="soft">
                    v{art.version}
                  </Badge>
                  {relative && <span className="artifact-gallery-card-time">{relative}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );

  const titleLabel = `Artifacts (${filteredCount === totalCount ? totalCount : filteredCount})`;

  if (isMobile) {
    return (
      <Sheet isOpen={isOpen} onClose={onClose} title={titleLabel} maxHeight="88dvh">
        {content}
      </Sheet>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={titleLabel} maxWidth="720px">
      {content}
    </Modal>
  );
}
