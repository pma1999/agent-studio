// Leaf constants module — zero runtime deps (no db/storage) so server/db.ts can
// import it synchronously without creating a circular dependency.
// server/tools/artifactsTool.ts re-exports these same objects (GC3 single source);
// registry.ts may import via artifactsTool.ts re-export, db.ts imports directly here.
export const CREATE_ARTIFACT_DESCRIPTION =
  "Create a rendered artifact the user can view in an interactive panel beside the chat. Use when you generate substantial standalone content worth displaying interactively rather than as plain text: complete HTML pages/apps/demos (kind='html'), SVG graphics (kind='svg'), Mermaid diagrams (kind='mermaid', the mermaid source without fences), or self-contained code files (kind='code') such as scripts or small programs the user may want to copy. Content must be COMPLETE and self-contained. Returns JSON {ok, artifactId, version, kind}. To revise it later call update_artifact with the returned artifact_id.";

export const CREATE_ARTIFACT_SCHEMA: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] } = {
  type: 'object',
  properties: {
    kind: { type: 'string', description: "Artifact kind: 'html' (complete HTML document), 'svg' (SVG markup), 'mermaid' (mermaid diagram source without fences), or 'code' (self-contained code file)" },
    title: { type: 'string', description: 'Short human title shown as tab label (max 120 chars)' },
    content: { type: 'string', description: 'Full file contents. For html: complete <!DOCTYPE html> document; svg: complete <svg> markup; mermaid: mermaid source without fences; code: full file content' },
    language: { type: 'string', description: 'Programming language hint for code highlighting (kind=code only), e.g. python, typescript' },
  },
  required: ['kind', 'title', 'content'],
};

export const UPDATE_ARTIFACT_DESCRIPTION =
  "Replace the full contents of an existing artifact created earlier in this conversation via create_artifact. Pass artifact_id and the COMPLETE new content (not a diff). Creates a new version visible to the user immediately. Use iteratively while refining a demo/diagram/app.";

export const UPDATE_ARTIFACT_SCHEMA: { type: 'object'; properties: Record<string, { type: string; description?: string }>; required: string[] } = {
  type: 'object',
  properties: {
    artifact_id: { type: 'string', description: 'id returned by create_artifact' },
    title: { type: 'string', description: 'Optional new title (max 120 chars)' },
    content: { type: 'string', description: 'FULL replacement contents (not a diff).' },
  },
  required: ['artifact_id', 'content'],
};
