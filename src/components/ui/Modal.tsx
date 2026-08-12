import React, { useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X } from 'lucide-react';
import { useIsMobile, usePrefersReducedMotion } from '../../utils/breakpoints';
import { useBodyScrollLock } from '../../hooks/useBodyScrollLock';

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  maxWidth?: string;
  /** Optional sticky footer (e.g. primary actions). Pins to the bottom, full-bleed on mobile. */
  footer?: React.ReactNode;
}

export function Modal({ isOpen, onClose, title, children, maxWidth = '560px', footer }: ModalProps) {
  const contentRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const prefersReducedMotion = usePrefersReducedMotion();

  useBodyScrollLock(isOpen);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (isOpen) {
      document.addEventListener('keydown', handleKeyDown);
    }
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  // On mobile the dialog becomes a full-screen sheet that slides up; on desktop
  // it keeps the original centered pop. Reduced motion → simple fade.
  const panelMotion = prefersReducedMotion
    ? { initial: { opacity: 0 }, animate: { opacity: 1 }, exit: { opacity: 0 } }
    : isMobile
      ? { initial: { y: '100%' }, animate: { y: 0 }, exit: { y: '100%' } }
      : { initial: { opacity: 0, scale: 0.95, y: 10 }, animate: { opacity: 1, scale: 1, y: 0 }, exit: { opacity: 0, scale: 0.95, y: 10 } };

  // Ownership rule: the modal panel owns its entire React subtree. Clicks that
  // propagate through the panel's React tree — including clicks on React portals
  // rendered inside the modal (e.g. the mobile model/provider picker sheets that
  // portal to document.body) — are "inside" clicks and are stopped here, so they
  // never reach the overlay's outside-click handler below. Only clicks whose
  // target is the overlay itself (never entered the panel's subtree) close the
  // modal. React events on portaled children still bubble through the fiber
  // tree, which is what makes this work where physical DOM containment fails.
  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: prefersReducedMotion ? 0 : 0.2 }}
          onClick={(e) => {
            // Defensive: after the panel stops propagation this handler can only
            // see clicks on the overlay itself, but keep the containment check as
            // a safeguard against content mounted outside the React tree.
            if (contentRef.current && !contentRef.current.contains(e.target as Node)) {
              onClose();
            }
          }}
          className="modal-overlay"
          style={{
            position: 'fixed',
            inset: 0,
            display: 'flex',
            alignItems: isMobile ? 'stretch' : 'center',
            justifyContent: 'center',
            background: 'rgba(0, 0, 0, 0.7)',
            backdropFilter: 'blur(4px)',
            zIndex: 1000,
          }}
        >
          <motion.div
            ref={contentRef}
            className={isMobile ? 'modal-panel-mobile' : undefined}
            initial={panelMotion.initial}
            animate={panelMotion.animate}
            exit={panelMotion.exit}
            transition={{ duration: prefersReducedMotion ? 0 : (isMobile ? 0.32 : 0.25), ease: [0.4, 0, 0.2, 1] }}
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--bg-base)',
              border: isMobile ? 'none' : '1px solid var(--border)',
              borderRadius: isMobile ? 0 : 'var(--radius-lg)',
              width: '100%',
              maxWidth: isMobile ? '100%' : maxWidth,
              height: isMobile ? '100dvh' : undefined,
              maxHeight: isMobile ? '100dvh' : '85vh',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: 'var(--shadow-lg)',
              overflow: 'hidden',
            }}
          >
            {title && (
              <div
                className="modal-header"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  borderBottom: '1px solid var(--border)',
                  flexShrink: 0,
                }}
              >
                <h3 style={{
                  fontFamily: 'var(--font-display)',
                  fontSize: '1.35rem',
                  fontWeight: 500,
                  color: 'var(--text-primary)',
                }}>
                  {title}
                </h3>
                <button
                  onClick={onClose}
                  aria-label="Close"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: isMobile ? '40px' : '32px',
                    height: isMobile ? '40px' : '32px',
                    background: 'transparent',
                    border: 'none',
                    color: 'var(--text-muted)',
                    cursor: 'pointer',
                    borderRadius: 'var(--radius-sm)',
                    transition: 'all var(--transition-fast)',
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = 'var(--bg-hover)';
                    e.currentTarget.style.color = 'var(--text-primary)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = 'transparent';
                    e.currentTarget.style.color = 'var(--text-muted)';
                  }}
                >
                  <X size={18} />
                </button>
              </div>
            )}
            <div className="modal-body" style={{ overflowY: 'auto', flex: 1, minHeight: 0 }}>
              {children}
            </div>
            {footer && <div className="modal-footer">{footer}</div>}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
