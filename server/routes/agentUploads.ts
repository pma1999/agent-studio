import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import {
  isAgentConnected,
  sendFileOpRequest,
} from '../agentRelay/registry.js';
import type { AgentToBackendMessage } from '../agentRelay/protocol.js';
import {
  MAX_RECEIVE_FILE_BYTES,
  discardStagedInboundFile,
  stageInboundFile,
} from '../agentFiles/inboundStaging.js';
import type { AuthRequest } from '../middleware/auth.js';
import { parseProviderRoutingConfig } from '../providerRouting.js';
import { inferMimeType } from '../utils/mimeTypes.js';
import { sanitizeFilename } from './agentFiles.js';
import { buildThreadIds } from '../messageTree.js';

export const RECEIVE_FILE_TIMEOUT_MS = 120_000;

type ReceiveFileResponse = Extract<
  AgentToBackendMessage,
  { type: 'receive_file_response' }
>;

function relayErrorMessage(error: unknown): string {
  if (error && typeof error === 'object' && 'error' in error) {
    const message = (error as { error?: unknown }).error;
    if (typeof message === 'string' && message.trim()) return message;
  }
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Failed to deliver file to the local agent';
}

function parseMessageRow(message: Record<string, unknown>) {
  return {
    ...message,
    annotations: message.annotations ? JSON.parse(message.annotations as string) : null,
    tool_calls: message.tool_calls ? JSON.parse(message.tool_calls as string) : null,
    attachments: message.attachments ? JSON.parse(message.attachments as string) : null,
    provider_routing: parseProviderRoutingConfig(message.provider_routing),
  };
}

const agentUploadsRouter = express.Router();

agentUploadsRouter.post(
  '/:id/agent-uploads',
  express.raw({ type: 'application/octet-stream', limit: '100mb' }),
  async (req: AuthRequest, res: Response) => {
    try {
      const userId = req.userId;
      if (!userId) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const conversation = db.prepare(
        'SELECT id, active_leaf_id FROM conversations WHERE id = ? AND user_id = ?',
      ).get(req.params.id, userId) as { id: string; active_leaf_id: string | null } | undefined;
      if (!conversation) {
        res.status(404).json({ error: 'Conversation not found' });
        return;
      }

      if (!isAgentConnected(userId)) {
        res.status(409).json({ error: 'local agent is not connected' });
        return;
      }

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
      if (content.length > MAX_RECEIVE_FILE_BYTES) {
        res.status(413).json({ error: 'File exceeds the 100 MiB size limit' });
        return;
      }

      const filename = sanitizeFilename(encodedFilename);
      const staged = stageInboundFile({
        userId,
        filename,
        mimeType: inferMimeType(filename),
        content,
      });

      let response: ReceiveFileResponse;
      try {
        response = await sendFileOpRequest<ReceiveFileResponse>(
          userId,
          {
            type: 'receive_file_request',
            requestId: `file_op_${nanoid()}`,
            fileId: staged.id,
            filename: staged.filename,
            sizeBytes: staged.content.length,
            mimeType: staged.mimeType,
          },
          RECEIVE_FILE_TIMEOUT_MS,
        );
      } catch (error) {
        discardStagedInboundFile(staged.id);
        res.status(502).json({ error: relayErrorMessage(error) });
        return;
      }

      if (response.ok !== true || !response.writtenPath) {
        discardStagedInboundFile(staged.id);
        res.status(502).json({
          error: response.error ?? 'Failed to deliver file to the local agent',
        });
        return;
      }

      discardStagedInboundFile(staged.id);
      const writtenPath = response.writtenPath;
      const renamed = path.basename(writtenPath) !== filename;
      const notice = renamed
        ? `Sent file "${filename}" to your computer — saved as "${writtenPath}" in your workspace (renamed to avoid overwriting an existing file with the same name).`
        : `Sent file "${filename}" to your computer — now available at "${writtenPath}" in your workspace.`;
      const attachments = JSON.stringify([{ filename, deliveredPath: writtenPath }]);
      const messageId = nanoid();

      // Message-tree: the notice becomes the new active leaf. It is chained to the
      // current leaf (or the last message when the leaf is missing) and joins the
      // turn of the nearest user message walked upward from the leaf (its own id if none).
      const lastMessageId = (db.prepare('SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(req.params.id) as { id: string } | undefined)?.id ?? null;
      const leafId = conversation.active_leaf_id ?? lastMessageId;
      let turnId: string = messageId;
      if (leafId) {
        const chain = buildThreadIds(req.params.id, leafId);
        for (let i = chain.length - 1; i >= 0; i--) {
          const row = db.prepare('SELECT turn_id FROM messages WHERE id = ? AND role = ?').get(chain[i], 'user') as { turn_id: string | null } | undefined;
          if (row?.turn_id) {
            turnId = row.turn_id;
            break;
          }
        }
      }

      db.transaction(() => {
        db.prepare(`
          INSERT INTO messages (id, conversation_id, role, content, attachments, parent_id, turn_id, variant_seq)
          VALUES (?, ?, 'user', ?, ?, ?, ?, 1)
        `).run(messageId, req.params.id, notice, attachments, leafId, turnId);
        db.prepare(
          "UPDATE conversations SET active_leaf_id = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?",
        ).run(messageId, req.params.id, userId);
      })();

      const message = db.prepare(`
        SELECT m.*, a.name as processed_by_agent_name
        FROM messages m
        LEFT JOIN agents a ON m.processed_by_agent_id = a.id
        WHERE m.id = ?
      `).get(messageId) as Record<string, unknown>;
      res.status(200).json({ message: parseMessageRow(message) });
    } catch (error) {
      console.error('Error processing agent file upload:', error);
      res.status(500).json({ error: 'Failed to process file upload' });
    }
  },
);

agentUploadsRouter.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
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

export default agentUploadsRouter;
