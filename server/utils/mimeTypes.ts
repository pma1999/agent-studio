import path from 'node:path';

const EXTENSION_MIME_MAP: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.bmp': 'image/bmp', '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.csv': 'text/csv', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json',
  '.xml': 'application/xml', '.html': 'text/html', '.htm': 'text/html',
  '.zip': 'application/zip', '.gz': 'application/gzip', '.tar': 'application/x-tar', '.7z': 'application/x-7z-compressed',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm',
  '.log': 'text/plain', '.yaml': 'application/yaml', '.yml': 'application/yaml',
};

export function inferMimeType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return EXTENSION_MIME_MAP[ext] || 'application/octet-stream';
}
