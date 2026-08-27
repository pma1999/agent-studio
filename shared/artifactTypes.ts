export const ARTIFACT_KINDS = ['html', 'code', 'svg', 'mermaid'] as const;
export type ArtifactKind = typeof ARTIFACT_KINDS[number];
export const MAX_ARTIFACT_CONTENT_CHARS = 400_000;
export const MAX_ARTIFACT_TITLE_CHARS = 120;

export interface ChatArtifact {
  id: string;
  conversation_id: string;
  message_id: string | null;
  kind: ArtifactKind;
  title: string;
  language?: string | null;
  content: string;
  version: number;
  created_at: string;
  updated_at: string;
}
export interface ConversationArtifactsResponse { artifacts: ChatArtifact[] }
