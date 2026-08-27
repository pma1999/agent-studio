import React from 'react';
import type { ChatArtifact } from '../../types';
import { HtmlPreviewFrame } from './HtmlPreviewFrame';
import { SanitizedSvg } from './SanitizedSvg';
import { MermaidDiagram } from './MermaidDiagram';
import { ArtifactCodeView } from './ArtifactCodeView';

export type ArtifactViewMode = 'rendered' | 'code';

export function ArtifactViewer({
  artifact,
  mode,
  dark,
}: {
  artifact: ChatArtifact;
  mode: ArtifactViewMode;
  dark?: boolean;
}): React.JSX.Element {
  if (mode === 'code') {
    return <ArtifactCodeView artifact={artifact} />;
  }

  switch (artifact.kind) {
    case 'html':
      return <HtmlPreviewFrame source={artifact.content} />;
    case 'svg':
      return <SanitizedSvg svg={artifact.content} />;
    case 'mermaid':
      return <MermaidDiagram code={artifact.content} dark={Boolean(dark)} />;
    case 'code':
      return <ArtifactCodeView artifact={artifact} />;
    default:
      return <ArtifactCodeView artifact={artifact} />;
  }
}
