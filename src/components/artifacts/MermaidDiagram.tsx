import { useEffect, useState } from 'react';

/**
 * MermaidDiagram — lazy singleton ESM import (never static top-level).
 * Integration recipe §1 literal adaptation (mermaid 11.17.2).
 */

type MermaidApi = typeof import('mermaid')['default'];

let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidDark: boolean | null = null;
let seq = 0;

async function getMermaid(dark: boolean): Promise<MermaidApi> {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => {
      m.default.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        suppressErrorRendering: true,
        theme: dark ? 'dark' : 'default',
      });
      mermaidDark = dark;
      return m.default;
    });
    return mermaidPromise;
  }
  if (mermaidDark !== dark) {
    const m = await mermaidPromise;
    m.initialize({
      startOnLoad: false,
      securityLevel: 'strict',
      suppressErrorRendering: true,
      theme: dark ? 'dark' : 'default',
    });
    mermaidDark = dark;
  }
  return mermaidPromise;
}

export function MermaidDiagram({ code, dark }: { code: string; dark: boolean }): React.JSX.Element {
  const [svg, setSvg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setError(null);

    void (async () => {
      try {
        const mermaid = await getMermaid(dark);
        await mermaid.parse(code);
        const id = `mmd-${++seq}-${Date.now().toString(36)}`;
        const { svg: rendered } = await mermaid.render(id, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setSvg(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [code, dark]);

  if (error) {
    return <div className="artifact-diagram-error">Syntax error: {error}</div>;
  }
  if (!svg) {
    return <div className="artifact-diagram-loading">Cargando diagrama…</div>;
  }
  return <div className="artifact-diagram" dangerouslySetInnerHTML={{ __html: svg }} />;
}
