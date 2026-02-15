import { useEffect, useRef, useState, useCallback } from 'react';

const BOTTOM_THRESHOLD_PX = 80;

export function useAutoScroll(dependency: unknown) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const lastScrollWasProgrammaticRef = useRef(false);

  const scrollToBottom = useCallback((behavior: 'smooth' | 'auto' = 'smooth') => {
    const el = containerRef.current;
    if (!el) return;
    lastScrollWasProgrammaticRef.current = true;
    el.scrollTo({
      top: el.scrollHeight,
      behavior,
    });
  }, []);

  useEffect(() => {
    if (isAtBottom) {
      scrollToBottom('smooth');
    }
  }, [dependency, isAtBottom, scrollToBottom]);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    if (lastScrollWasProgrammaticRef.current) {
      lastScrollWasProgrammaticRef.current = false;
      const { scrollTop, scrollHeight, clientHeight } = el;
      const atBottom = scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX;
      setIsAtBottom(atBottom);
      setShowScrollButton(!atBottom);
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = el;
    const atBottom = scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX;
    setIsAtBottom(atBottom);
    setShowScrollButton(!atBottom);
  }, []);

  // ResizeObserver: when content grows and user is at bottom, keep scroll at bottom (instant)
  useEffect(() => {
    const container = containerRef.current;
    const content = container?.firstElementChild;
    if (!container || !content) return;

    const ro = new ResizeObserver(() => {
      if (!containerRef.current) return;
      const { scrollTop, scrollHeight, clientHeight } = containerRef.current;
      const atBottom = scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX;
      if (atBottom) {
        lastScrollWasProgrammaticRef.current = true;
        containerRef.current.scrollTop =
          containerRef.current.scrollHeight - containerRef.current.clientHeight;
      }
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, [dependency]);

  return { containerRef, scrollToBottom, showScrollButton, handleScroll };
}
