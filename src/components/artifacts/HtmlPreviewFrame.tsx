import React, { useEffect, useRef, useState, useMemo } from 'react';
import {
  IFRAME_SANDBOX_TOKENS as SANDBOX_TOKENS,
  buildBootstrapWrappedHtml,
  clampHeight,
} from './htmlFrame';

export { IFRAME_SANDBOX_TOKENS } from './htmlFrame';
export { buildBootstrapWrappedHtml, clampHeight, RESIZE_BOOTSTRAP_SCRIPT } from './htmlFrame';
export const IFRAME_SANDBOX_TOKENS_ALIAS = SANDBOX_TOKENS;

export function HtmlPreviewFrame({ source }: { source: string }): React.JSX.Element {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(320);

  const srcDoc = useMemo(() => buildBootstrapWrappedHtml(source), [source]);

  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      // GC4: origin serialises as "null" under sandbox; filter by window identity.
      if (e.source !== iframeRef.current?.contentWindow) return;
      const data = e.data as { type?: string; height?: unknown } | null;
      if (data?.type !== 'artifact-resize') return;
      const raw = typeof data.height === 'number' ? data.height : Number(data.height);
      setHeight(clampHeight(raw));
    };
    window.addEventListener('message', onMsg);
    return () => window.removeEventListener('message', onMsg);
  }, []);

  return (
    <iframe
      ref={iframeRef}
      title="Vista previa del artifact"
      sandbox={SANDBOX_TOKENS}
      srcDoc={srcDoc}
      className="artifact-frame"
      style={{ height }}
      loading="lazy"
    />
  );
}
