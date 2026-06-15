import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useDragControls, type PanInfo } from 'framer-motion';
import { X } from 'lucide-react';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { usePrefersReducedMotion } from '../../utils/breakpoints';
import { shouldDismiss } from '../../utils/gestures';

interface SheetProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  /** Sticky footer slot for primary actions. */
  footer?: React.ReactNode;
  /** Max panel height. Defaults to 85% of the dynamic viewport. */
  maxHeight?: string;
}

/**
 * Mobile bottom sheet. Rendered via a portal to `document.body` so it escapes
 * the per-view `transform` wrappers in App.tsx (a fixed child of a transformed
 * ancestor would otherwise be mispositioned). Drag-to-dismiss is started only
 * from the header/grab zone via dragControls, so it never hijacks body scroll.
 *
 * This component has zero desktop footprint: callers only mount it when
 * `useIsMobile()` is true.
 */
export function Sheet({ isOpen, onClose, title, children, footer, maxHeight = '85dvh' }: SheetProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const dragControls = useDragControls();

  useBodyScrollLock(isOpen);
  useFocusTrap(panelRef, isOpen);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  const handleDragEnd = (_: unknown, info: PanInfo) => {
    if (shouldDismiss(info, 'y', 1)) onClose();
  };

  const startDrag = (e: React.PointerEvent) => {
    if (!prefersReducedMotion) dragControls.start(e);
  };

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          className="sheet-scrim"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={panelRef}
            className="sheet-panel"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            style={{ maxHeight }}
            initial={prefersReducedMotion ? { opacity: 0 } : { y: '100%' }}
            animate={prefersReducedMotion ? { opacity: 1 } : { y: 0 }}
            exit={prefersReducedMotion ? { opacity: 0 } : { y: '100%' }}
            transition={{ duration: prefersReducedMotion ? 0 : 0.32, ease: [0.32, 0.72, 0, 1] }}
            drag={prefersReducedMotion ? false : 'y'}
            dragListener={false}
            dragControls={dragControls}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.5 }}
            onDragEnd={handleDragEnd}
          >
            <div className="sheet-drag-zone" onPointerDown={startDrag}>
              <div className="sheet-grab" aria-hidden="true" />
              {title && (
                <div className="sheet-header">
                  <h3 className="sheet-title">{title}</h3>
                  <button type="button" className="sheet-close" onClick={onClose} aria-label="Close">
                    <X size={18} />
                  </button>
                </div>
              )}
            </div>
            <div className="sheet-body">{children}</div>
            {footer && <div className="sheet-footer">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
