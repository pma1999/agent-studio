import React, { useMemo } from 'react';
import DOMPurify from 'dompurify';

export function SanitizedSvg({ svg }: { svg: string }): React.JSX.Element {
  const clean = useMemo(
    () =>
      DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true },
      }) as string,
    [svg],
  );

  return (
    <div className="artifact-svg-wrap">
      <div className="artifact-svg" dangerouslySetInnerHTML={{ __html: clean }} />
    </div>
  );
}
