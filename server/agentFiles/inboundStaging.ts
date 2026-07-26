import { nanoid } from 'nanoid';

export const MAX_RECEIVE_FILE_BYTES = 100 * 1024 * 1024;
const INBOUND_STAGING_TTL_MS = 5 * 60 * 1000;

export interface StagedInboundFile {
  id: string;
  userId: string;
  filename: string;
  mimeType: string;
  content: Buffer;
}

const stagedInboundFiles = new Map<string, StagedInboundFile>();

export function stageInboundFile(
  params: Omit<StagedInboundFile, 'id'>,
): StagedInboundFile {
  const staged = { id: nanoid(), ...params };
  stagedInboundFiles.set(staged.id, staged);
  setTimeout(() => stagedInboundFiles.delete(staged.id), INBOUND_STAGING_TTL_MS).unref();
  return staged;
}

export function takeStagedInboundFile(
  id: string,
  userId: string,
): StagedInboundFile | undefined {
  const staged = stagedInboundFiles.get(id);
  if (!staged || staged.userId !== userId) return undefined;
  stagedInboundFiles.delete(id);
  return staged;
}

export function discardStagedInboundFile(id: string): void {
  stagedInboundFiles.delete(id);
}
