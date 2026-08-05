import React, { useMemo, useRef, useLayoutEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Copy, Check } from 'lucide-react';

function CodeBlock({ children, className, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
  const [copied, setCopied] = React.useState(false);
  const isInline = !className;

  if (isInline) {
    return <code {...props} className={className}>{children}</code>;
  }

  const language = className?.replace('language-', '') || '';

  const handleCopy = () => {
    const text = String(children).replace(/\n$/, '');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={{ position: 'relative', marginBottom: '12px' }}>
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '8px 14px',
        background: 'var(--bg-elevated)',
        border: '1px solid var(--border)',
        borderBottom: 'none',
        borderRadius: 'var(--radius-md) var(--radius-md) 0 0',
        fontSize: '0.6875rem',
        fontFamily: 'var(--font-mono)',
        color: 'var(--text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
      }}>
        <span>{language || 'code'}</span>
        <button
          onClick={handleCopy}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '4px',
            background: 'transparent',
            border: 'none',
            color: copied ? 'var(--success)' : 'var(--text-muted)',
            cursor: 'pointer',
            fontSize: '0.6875rem',
            fontFamily: 'var(--font-mono)',
            padding: '2px 6px',
            borderRadius: '4px',
            transition: 'all var(--transition-fast)',
          }}
          onMouseEnter={(e) => {
            if (!copied) e.currentTarget.style.color = 'var(--text-primary)';
          }}
          onMouseLeave={(e) => {
            if (!copied) e.currentTarget.style.color = 'var(--text-muted)';
          }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre style={{
        margin: 0,
        borderRadius: '0 0 var(--radius-md) var(--radius-md)',
        borderTop: 'none',
      }}>
        <code className={className} {...props}>
          {children}
        </code>
      </pre>
    </div>
  );
}

function MarkdownTable({ children, ...props }: React.HTMLAttributes<HTMLTableElement>) {
  const wrapRef = useRef<HTMLDivElement>(null);

  // Toggles `data-fade` on the wrapper so the CSS edge fades only appear while
  // there is content beyond the edge: 'right' (more to the right), 'left'
  // (more to the left), 'both', or 'none' when the table fits.
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const updateFade = () => {
      const { scrollLeft, scrollWidth, clientWidth } = el;
      const overflow = scrollWidth - clientWidth;
      if (overflow <= 1) {
        el.dataset.fade = 'none';
      } else if (scrollLeft <= 1) {
        el.dataset.fade = 'right';
      } else if (scrollLeft + clientWidth >= scrollWidth - 1) {
        el.dataset.fade = 'left';
      } else {
        el.dataset.fade = 'both';
      }
    };

    updateFade();
    el.addEventListener('scroll', updateFade, { passive: true });
    const observer = new ResizeObserver(updateFade);
    observer.observe(el);
    return () => {
      el.removeEventListener('scroll', updateFade);
      observer.disconnect();
    };
  }, []);

  return (
    <div ref={wrapRef} className="markdown-table-wrap">
      <table {...props}>{children}</table>
    </div>
  );
}

interface MarkdownContentProps {
  content: string;
}

export function MarkdownContent({ content }: MarkdownContentProps) {
  const components = useMemo(() => ({
    code: CodeBlock as any,
    table: MarkdownTable as any,
  }), []);

  return (
    <div className="markdown-content">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
