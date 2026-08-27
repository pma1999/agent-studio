import React, { useState } from 'react';
import { Copy, Check } from 'lucide-react';
import type { ChatArtifact } from '../../types';

export function ArtifactCodeView({ artifact }: { artifact: ChatArtifact }): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const language = (artifact.language || 'text').toLowerCase();
  const className = language !== 'text' ? `language-${language}` : undefined;

  const handleCopy = () => {
    const text = artifact.content ?? '';
    void navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="artifact-code">
      <div className="artifact-code-header">
        <span className="artifact-code-lang">{language}</span>
        <button
          type="button"
          onClick={handleCopy}
          className="artifact-code-copy"
          data-copied={copied}
          aria-label={copied ? 'Copied' : 'Copy code'}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="artifact-code-pre">
        <code className={className ? `hljs ${className}` : 'hljs'}>{artifact.content}</code>
      </pre>
    </div>
  );
}
