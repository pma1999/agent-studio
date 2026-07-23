import path from 'node:path';

const readPathsByConversation = new Map<string, Set<string>>();

function normalizePath(rawPath: string): string {
  return path.posix.normalize(rawPath.trim().replace(/\\/g, '/'));
}

export function markPathRead(conversationId: string, rawPath: string): void {
  let paths = readPathsByConversation.get(conversationId);
  if (!paths) {
    paths = new Set<string>();
    readPathsByConversation.set(conversationId, paths);
  }
  paths.add(normalizePath(rawPath));
}

export function hasPathBeenRead(conversationId: string, rawPath: string): boolean {
  return readPathsByConversation.get(conversationId)?.has(normalizePath(rawPath)) ?? false;
}
