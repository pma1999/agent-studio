import fs from 'node:fs';
import express, { type NextFunction, type Request, type Response } from 'express';
import { validateAgentToken } from '../agentRelay/protocol.js';
import {
  MAX_SEND_FILE_BYTES,
  getActiveAgentFile,
  saveAgentFile,
} from '../agentFiles/storage.js';

interface AgentFileUploadRequest extends Request {
  agentIdentity?: {
    userId: string;
    agentId: string;
  };
}

const agentFilesRouter = express.Router();

function authenticateAgent(req: AgentFileUploadRequest, res: Response, next: NextFunction): void {
  const authorization = req.headers.authorization;
  const token = authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
  const identity = validateAgentToken(token);
  if (!identity) {
    res.status(401).json({ error: 'Invalid or missing agent token' });
    return;
  }
  req.agentIdentity = identity;
  next();
}

function sanitizeFilename(encodedFilename: string): string {
  const decoded = Buffer.from(encodedFilename, 'base64').toString('utf8');
  const sanitized = decoded.replace(/[\/\\\x00-\x1f]/g, '').trim().slice(0, 255);
  return sanitized || 'file';
}

agentFilesRouter.post(
  '/upload',
  authenticateAgent,
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  (req: AgentFileUploadRequest, res: Response) => {
    const encodedFilename = req.get('X-File-Name-B64');
    if (!encodedFilename) {
      res.status(400).json({ error: 'X-File-Name-B64 header is required' });
      return;
    }

    const content = req.body;
    if (!Buffer.isBuffer(content) || content.length === 0) {
      res.status(400).json({ error: 'A non-empty binary body is required' });
      return;
    }
    if (content.length > MAX_SEND_FILE_BYTES) {
      res.status(413).json({ error: 'File exceeds the 100 MiB size limit' });
      return;
    }

    try {
      const stored = saveAgentFile({
        userId: req.agentIdentity!.userId,
        agentId: req.agentIdentity!.agentId,
        filename: sanitizeFilename(encodedFilename),
        content,
      });
      res.status(201).json({
        fileId: stored.id,
        filename: stored.filename,
        mimeType: stored.mimeType,
        sizeBytes: stored.sizeBytes,
        expiresAt: stored.expiresAt,
      });
    } catch {
      res.status(500).json({ error: 'Failed to store file' });
    }
  },
);

agentFilesRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (
    typeof err === 'object'
    && err !== null
    && 'type' in err
    && err.type === 'entity.too.large'
  ) {
    res.status(413).json({ error: 'File exceeds the 100 MiB size limit' });
    return;
  }
  next(err);
});

agentFilesRouter.get('/:fileId/download', (req, res) => {
  const stored = getActiveAgentFile(req.params.fileId);
  if (!stored || !fs.existsSync(stored.storagePath)) {
    res.status(404).json({ error: 'File not found or expired' });
    return;
  }

  const asciiFallback = stored.filename.replace(/[^\x20-\x7e]|"/g, '_');
  const encodedFilename = encodeURIComponent(stored.filename)
    .replace(/[!'()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  res.setHeader('Content-Type', stored.mimeType);
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encodedFilename}`,
  );
  res.setHeader('Content-Length', String(stored.sizeBytes));
  const stream = fs.createReadStream(stored.storagePath);
  stream.on('error', (error) => {
    console.error('[Agent Studio] Failed to stream agent file:', error);
    if (!res.headersSent) {
      res.removeHeader('Content-Type');
      res.removeHeader('Content-Disposition');
      res.removeHeader('Content-Length');
      res.status(500).json({ error: 'Failed to read file' });
      return;
    }
    res.destroy(error);
  });
  stream.pipe(res);
});

export default agentFilesRouter;
