import { Router, Response } from 'express';
import { nanoid } from 'nanoid';
import db from '../db.js';
import { AuthRequest } from '../middleware/auth.js';
import { buildThreadIds } from '../messageTree.js';
import {
  buildCompactionPrompt,
  SUMMARY_PREFIX,
  SUMMARY_REASK_INSTRUCTION,
} from '../compaction/prompt.js';
import {
  serializeHead,
  validateSummaryTemplate,
  estimateTokens,
  type CompactRow,
} from '../compaction/serialize.js';
import {
  getProviderForModel,
  toUpstreamModelId,
} from '../providers/index.js';
import { getSettingValue } from './settings.js';
import {
  registerTurn,
  findTurnByConversation,
  clearTurn,
} from '../chatTurnRegistry.js';
import { runCompactionSummary } from '../compaction/summarize.js';

const router = Router();

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CONTEXT_EXCEEDED_RE = /context|too long|maximum context/i;

type Terminal =
  | { kind: 'ended'; ended: Record<string, unknown> }
  | { kind: 'failed'; code: string; reason: string };

interface InFlightEntry {
  requestId: string | null;
  promise: Promise<Terminal>;
  compactionId: string;
}

// Single-process reality, same as chatTurnRegistry.
const inFlightByConversation = new Map<string, InFlightEntry>();
const inFlightByRequest = new Map<string, InFlightEntry>();

function requestKey(conversationId: string, requestId: string): string {
  return `${conversationId}\0${requestId}`;
}

function sseHeaders(res: Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
}

function writeStarted(res: Response, compactionId: string, conversationId: string): void {
  res.write(`event: compaction.started\ndata: ${JSON.stringify({ compaction_id: compactionId, conversation_id: conversationId })}\n\n`);
}
function writeEnded(res: Response, ended: Record<string, unknown>): void {
  res.write(`event: compaction.ended\ndata: ${JSON.stringify(ended)}\n\n`);
}
function writeFailed(res: Response, conversationId: string, code: string, reason: string): void {
  res.write(`event: compaction.failed\ndata: ${JSON.stringify({ conversation_id: conversationId, code, reason })}\n\n`);
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { name?: string }).name === 'AbortError';
}

function summarizeCode(err: unknown): string | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as { code?: unknown }).code;
  return typeof code === 'string' ? code : null;
}

function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message.slice(0, 500);
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string' && m) return m.slice(0, 500);
    const t = (err as { errorText?: unknown }).errorText;
    if (typeof t === 'string' && t) return t.slice(0, 500);
  }
  return fallback;
}

function toCompactRow(r: Record<string, unknown>): CompactRow {
  return {
    id: String(r.id),
    role: String(r.role),
    content: (r.content as unknown) ?? '',
    tool_call_id: (r.tool_call_id as string | null) ?? null,
    tool_calls: (r.tool_calls as string | null) ?? null,
    annotations: (r.annotations as string | null) ?? null,
    reasoning_content: (r.reasoning_content as string | null) ?? null,
    attachments: (r.attachments as string | null) ?? null,
    turn_id: (r.turn_id as string | null) ?? null,
  };
}

router.post('/:id/compact', async (req: AuthRequest, res: Response): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  const conversationId = req.params.id;
  const body = (req.body ?? {}) as { focus?: unknown; keep_tokens?: unknown; request_id?: unknown; model?: unknown };

  // --- param validation (no claim yet) ---
  let requestId: string | null = null;
  if (body.request_id !== undefined && body.request_id !== null) {
    if (typeof body.request_id !== 'string' || !REQUEST_ID_RE.test(body.request_id)) {
      res.status(400).json({ code: 'invalid_request_id', error: 'request_id must match /^[A-Za-z0-9_-]{1,64}$/' });
      return;
    }
    requestId = body.request_id;
  }
  // `keep_tokens` is accepted (and still type-validated) for wire
  // compatibility, but a checkpoint now archives the whole visible slice: no
  // verbatim tail is kept, so there is no budget to spend. Meta records 0.
  if (body.keep_tokens !== undefined && body.keep_tokens !== null) {
    if (typeof body.keep_tokens !== 'number' || !Number.isFinite(body.keep_tokens)) {
      res.status(400).json({ code: 'invalid_keep_tokens', error: 'keep_tokens must be a number' });
      return;
    }
  }
  let focus: string | null = null;
  if (body.focus !== undefined && body.focus !== null) {
    if (typeof body.focus !== 'string') {
      res.status(400).json({ code: 'invalid_focus', error: 'focus must be a string' });
      return;
    }
    const trimmed = body.focus.trim();
    focus = trimmed ? trimmed : null;
  }
  let messageModel: string | null = null;
  if (body.model !== undefined && body.model !== null) {
    if (typeof body.model !== 'string' || !body.model.trim()) {
      res.status(400).json({ code: 'invalid_model', error: 'model must be a non-empty string' });
      return;
    }
    messageModel = body.model;
  }

  const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) as
    | { id: string; user_id: string; agent_id: string | null; title: string; model: string | null; codex_thread_id: string | null; active_leaf_id: string | null; active_turn_id: string | null }
    | undefined;
  if (!conversation) {
    res.status(404).json({ error: 'Conversation not found' });
    return;
  }

  // --- completed request_id replay (no LLM, no claim) ---
  if (requestId) {
    const hit = db.prepare(
      `SELECT id, compaction_meta FROM messages WHERE conversation_id = ? AND role = 'compaction' AND compaction_meta LIKE '%"request_id":"' || ? || '"%'`,
    ).get(conversationId, requestId) as { id: string; compaction_meta: string | null } | undefined;
    if (hit?.compaction_meta) {
      try {
        const meta = JSON.parse(hit.compaction_meta) as Record<string, unknown>;
        if (meta?.request_id === requestId) {
          sseHeaders(res);
          // flushHeaders before any async work (precedent chat.ts:730-737).
          res.flushHeaders();
          writeStarted(res, hit.id, conversationId);
          writeEnded(res, {
            compaction_id: hit.id,
            conversation_id: conversationId,
            tail_message_ids: meta.tail_message_ids ?? [],
            tokens_before: meta.tokens_before ?? 0,
            tokens_after: meta.tokens_after ?? 0,
            messages_compacted:
              typeof meta.messages_compacted === 'number' && Number.isFinite(meta.messages_compacted)
                ? meta.messages_compacted
                : null,
            pre_compact_leaf_id: meta.pre_compact_leaf_id ?? null,
            model: meta.model ?? null,
            focus: meta.focus ?? null,
          });
          res.end();
          return;
        }
      } catch {
        // fall through to fresh execution
      }
    }
    // --- in-flight attach (same conversation + same request_id) ---
    const inflight = inFlightByConversation.get(conversationId);
    if (inflight && inflight.requestId === requestId) {
      sseHeaders(res);
      res.flushHeaders();
      writeStarted(res, inflight.compactionId, conversationId);
      // Attached waiters never abort the owner's controller on disconnect.
      const terminal = await inflight.promise;
      if (terminal.kind === 'ended') writeEnded(res, terminal.ended);
      else writeFailed(res, conversationId, terminal.code, terminal.reason);
      res.end();
      return;
    }
  }

  // --- different compact in-flight on the same conversation ---
  if (inFlightByConversation.has(conversationId)) {
    res.status(409).json({ code: 'compact_in_progress', error: 'A compaction is already running in this conversation' });
    return;
  }
  // --- live chat turn ---
  const liveCheck = db.prepare('SELECT active_turn_id FROM conversations WHERE id = ?').get(conversationId) as
    | { active_turn_id: string | null }
    | undefined;
  if (liveCheck?.active_turn_id) {
    res.status(409).json({ code: 'turn_live', error: 'A response is already being generated in this conversation' });
    return;
  }
  if (findTurnByConversation(conversationId)) {
    res.status(409).json({ code: 'turn_live', error: 'A response is already being generated in this conversation' });
    return;
  }

  // --- load visible thread ---
  const leafRow = db.prepare('SELECT active_leaf_id, codex_thread_id FROM conversations WHERE id = ?').get(conversationId) as
    | { active_leaf_id: string | null; codex_thread_id: string | null }
    | undefined;
  const codexThreadId = leafRow?.codex_thread_id ?? null;
  const threadIds = buildThreadIds(conversationId, leafRow?.active_leaf_id ?? null);
  const allRows = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(conversationId) as Record<string, unknown>[];
  const byId = new Map<string, Record<string, unknown>>(allRows.map((r) => [String(r.id), r]));
  const threadRows = threadIds.map((id) => byId.get(id)).filter((r): r is Record<string, unknown> => !!r);
  let lastCompIdx = -1;
  for (let i = 0; i < threadRows.length; i++) {
    if (threadRows[i]!['role'] === 'compaction') lastCompIdx = i;
  }
  const priorRow = lastCompIdx >= 0 ? threadRows[lastCompIdx]! : null;
  const supersedes = priorRow ? String(priorRow['id']) : null;
  let priorSummary: string | null = null;
  if (priorRow) {
    const content = String(priorRow['content'] ?? '');
    priorSummary = content.startsWith(SUMMARY_PREFIX) ? content.slice(SUMMARY_PREFIX.length) : content;
  }
  const visibleDbRows = lastCompIdx >= 0 ? threadRows.slice(lastCompIdx + 1) : threadRows;
  // Nothing to compact = no user turn since the previous checkpoint. With the
  // whole slice archived, this is the ONLY vacuous case left: any slice with a
  // user turn produces a non-empty head, so no post-summary emptiness check is
  // needed (and compacting twice in a row lands here instead of burning a
  // summary call on an empty head).
  const userTurns = visibleDbRows.filter((r) => r['role'] === 'user');
  if (userTurns.length === 0) {
    res.status(400).json({
      code: 'nothing_to_compact',
      error: 'Nothing new to compact — no messages since the last checkpoint.',
    });
    return;
  }
  const preCompactLeafId = threadIds.length > 0 ? threadIds[threadIds.length - 1]! : null;

  // --- agent + effective model (same precedence as chat) ---
  let agent: { id: string; system_prompt: string; model: string } | undefined;
  if (conversation.agent_id) {
    const row = db.prepare('SELECT * FROM agents WHERE id = ? AND user_id = ?').get(conversation.agent_id, userId) as
      | { id: string; system_prompt: string; model: string }
      | undefined;
    if (!row) {
      res.status(404).json({ error: 'Agent not found' });
      return;
    }
    agent = row;
  } else {
    // General-chat fallback mirrors server/routes/chat.ts loadGeneralChatSettings/
    // createGeneralChatAgent defaults (those helpers are module-private in
    // chat.ts, so the route reads the same settings keys directly).
    const generalModel = getSettingValue(userId, 'general_chat_model') || 'openrouter/auto';
    const generalPrompt =
      getSettingValue(userId, 'general_chat_system_prompt') ||
      'You are a helpful AI assistant. You provide thoughtful, well-structured responses.';
    agent = { id: 'general', system_prompt: generalPrompt, model: generalModel };
  }
  const effectiveModel = messageModel || conversation.model || agent.model;
  if (!effectiveModel) {
    res.status(400).json({ code: 'invalid_model', error: 'No model resolved for this conversation' });
    return;
  }
  const provider = getProviderForModel(effectiveModel);
  void toUpstreamModelId(effectiveModel);

  // --- head = the WHOLE visible slice ---
  // The checkpoint row is inserted at the END of the thread (parent_id =
  // pre-compact leaf) and the chat builder cuts everything up to and including
  // it (G10 `selectModelView`). So anything left out of the head here is lost
  // from the model view entirely: it is neither summarized nor replayed. The
  // head is therefore every visible row since the previous ON-THREAD
  // checkpoint (whose own summary travels as `priorSummary`) — the user's last
  // turn and its answer included. No verbatim tail is kept.
  //
  // Deliberately NO cross-branch exclusion by `archived_message_ids`: rows
  // archived by an abandoned checkpoint (Undo moved the leaf before it) are
  // live in the model view again, so they must be re-summarized or their
  // content vanishes. An exclusion scoped to on-thread ancestors would be a
  // no-op anyway — the `lastCompIdx` slice above already drops those rows.
  const compactRows = visibleDbRows.map(toCompactRow);
  const headRows = compactRows;
  const archivedMessageIds = headRows.map((r) => r.id);
  const serializedHead = serializeHead(headRows);
  const tokensBefore = estimateTokens(serializedHead);
  const messagesCompacted = headRows.length;
  const compactedAtBase = new Date().toISOString();

  // --- atomic claim (precedent chat.ts:386-392) ---
  const compactTurnId = nanoid();
  const compactionId = compactTurnId;
  const claim = db
    .prepare('UPDATE conversations SET active_turn_id = ? WHERE id = ? AND user_id = ? AND active_turn_id IS NULL')
    .run(compactTurnId, conversationId, userId);
  if (claim.changes === 0) {
    const inflight = inFlightByConversation.get(conversationId);
    if (inflight) {
      if (requestId && inflight.requestId === requestId) {
        sseHeaders(res);
        res.flushHeaders();
        writeStarted(res, inflight.compactionId, conversationId);
        const terminal = await inflight.promise;
        if (terminal.kind === 'ended') writeEnded(res, terminal.ended);
        else writeFailed(res, conversationId, terminal.code, terminal.reason);
        res.end();
        return;
      }
      res.status(409).json({ code: 'compact_in_progress', error: 'A compaction is already running in this conversation' });
      return;
    }
    res.status(409).json({ code: 'turn_live', error: 'A response is already being generated in this conversation' });
    return;
  }

  // Register the live turn so Stop / orphan-timeout / shutdown can reach it.
  // Own AbortController; onAbort records the reason and does NO draft writes.
  let abortReason: 'stop' | 'orphan-timeout' | 'shutdown' | null = null;
  const controller = new AbortController();
  registerTurn({
    turnId: compactTurnId,
    userId,
    conversationId,
    controller,
    onAbort: (reason) => {
      abortReason = reason;
    },
  });

  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    try {
      controller.abort();
    } catch {
      // ignore
    }
  }, 120_000);

  let resolveTerminal!: (t: Terminal) => void;
  const terminalPromise = new Promise<Terminal>((resolve) => {
    resolveTerminal = resolve;
  });
  const entry: InFlightEntry = { requestId, promise: terminalPromise, compactionId };
  inFlightByConversation.set(conversationId, entry);
  if (requestId) inFlightByRequest.set(requestKey(conversationId, requestId), entry);

  const cleanup = () => {
    clearTimeout(timeout);
    clearTurn(compactTurnId);
    if (inFlightByConversation.get(conversationId) === entry) inFlightByConversation.delete(conversationId);
    if (requestId && inFlightByRequest.get(requestKey(conversationId, requestId)) === entry) {
      inFlightByRequest.delete(requestKey(conversationId, requestId));
    }
  };
  const releaseClaim = () => {
    db.prepare('UPDATE conversations SET active_turn_id = NULL WHERE id = ? AND active_turn_id = ?').run(conversationId, compactTurnId);
  };

  // SSE headers flushed BEFORE the summary call (precedent chat.ts:730-737).
  sseHeaders(res);
  res.flushHeaders();
  let terminalSent = false;
  res.on('close', () => {
    // Client disconnect cancels compact work, but NEVER writes partial state.
    if (!terminalSent) {
      try {
        controller.abort();
      } catch {
        // ignore
      }
    }
  });
  writeStarted(res, compactionId, conversationId);

  const buildPrompt = (head: string): string =>
    buildCompactionPrompt({
      serializedHead: head,
      priorSummary,
      focus,
      conversationId,
      modelId: effectiveModel,
      provider: provider.id,
      compactedAtIso: compactedAtBase,
      messagesCompacted,
      tokensBefore,
    });

  const mapAbort = (): { code: string; reason: string } => {
    if (abortReason === 'stop' || abortReason === 'orphan-timeout' || abortReason === 'shutdown') {
      return { code: 'stopped', reason: 'Compaction was stopped' };
    }
    if (timedOut) return { code: 'summary_failed', reason: 'Summary timed out after 120s' };
    // Client disconnect (res closed, no registry reason): report stopped so
    // attached waiters see a terminal state; the disconnected socket writes nothing.
    return { code: 'stopped', reason: 'Compaction was aborted' };
  };

  try {
    let headForCall = serializedHead;
    let prompt = buildPrompt(headForCall);
    let summary = '';
    try {
      const out = await runCompactionSummary({
        userId,
        conversationId,
        codexThreadId,
        systemPrompt: agent.system_prompt,
        prompt,
        effectiveModel,
        signal: controller.signal,
      });
      summary = out.text ?? '';
    } catch (err) {
      if (isAbortError(err) || controller.signal.aborted) {
        const mapped = mapAbort();
        throw { code: mapped.code, reason: mapped.reason };
      }
      const status = (err as { status?: unknown }).status;
      const errorText = `${String((err as { message?: unknown }).message ?? '')}\n${String((err as { errorText?: unknown }).errorText ?? '')}`;
      if (status === 400 && CONTEXT_EXCEEDED_RE.test(errorText)) {
        headForCall = headForCall.slice(0, Math.floor(headForCall.length / 2));
        prompt = buildPrompt(headForCall);
        try {
          const retry = await runCompactionSummary({
            userId,
            conversationId,
            codexThreadId,
            systemPrompt: agent.system_prompt,
            prompt,
            effectiveModel,
            signal: controller.signal,
          });
          summary = retry.text ?? '';
        } catch (err2) {
          if (isAbortError(err2) || controller.signal.aborted) {
            const mapped = mapAbort();
            throw { code: mapped.code, reason: mapped.reason };
          }
          throw { code: 'summary_failed', reason: errorMessage(err2, 'Summary failed') };
        }
      } else {
        const code = summarizeCode(err);
        if (code === 'no_api_key' || code === 'unsupported_model') {
          throw { code, reason: errorMessage(err, code) };
        }
        throw { code: 'summary_failed', reason: errorMessage(err, 'Summary failed') };
      }
    }

    // Template validation with exactly one re-ask on the SAME head.
    if (!summary?.trim() || !validateSummaryTemplate(summary).ok) {
      const reaskPrompt = `${prompt}\n\n${SUMMARY_REASK_INSTRUCTION}`;
      try {
        const out = await runCompactionSummary({
          userId,
          conversationId,
          codexThreadId,
          systemPrompt: agent.system_prompt,
          prompt: reaskPrompt,
          effectiveModel,
          signal: controller.signal,
        });
        summary = out.text ?? '';
      } catch (err) {
        if (isAbortError(err) || controller.signal.aborted) {
          const mapped = mapAbort();
          throw { code: mapped.code, reason: mapped.reason };
        }
        const code = summarizeCode(err);
        if (code === 'no_api_key' || code === 'unsupported_model') {
          throw { code, reason: errorMessage(err, code) };
        }
        throw { code: 'summary_failed', reason: errorMessage(err, 'Summary failed') };
      }
      if (!summary?.trim() || !validateSummaryTemplate(summary).ok) {
        throw { code: 'template_invalid', reason: 'Summary did not follow the required template' };
      }
    }

    // Nothing is kept verbatim, so the post-compaction view is exactly the
    // stored checkpoint content.
    const tokensAfter = estimateTokens(SUMMARY_PREFIX + summary);
    const compactedAt = new Date().toISOString();
    const meta = {
      v: 1,
      model: effectiveModel,
      provider: provider.id,
      focus,
      keep_tokens: 0,
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      messages_compacted: messagesCompacted,
      // Always empty now (no verbatim tail); kept in the payload so the
      // documented SSE/meta shape does not change under old readers.
      tail_message_ids: [] as string[],
      archived_message_ids: archivedMessageIds,
      pre_compact_leaf_id: preCompactLeafId,
      supersedes,
      compacted_at: compactedAt,
      request_id: requestId,
    };

    // ONE better-sqlite3 transaction: summary row + leaf flip + codex NULL + claim release.
    const persist = db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, parent_id, turn_id, variant_seq, compaction_meta, model)
         VALUES (?, ?, 'compaction', ?, ?, ?, 1, ?, ?)`,
      ).run(compactionId, conversationId, SUMMARY_PREFIX + summary, preCompactLeafId, compactionId, JSON.stringify(meta), effectiveModel);
      db.prepare(
        `UPDATE conversations SET active_leaf_id = ?, codex_thread_id = NULL, active_turn_id = NULL, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
      ).run(compactionId, conversationId, userId);
    });
    persist();
    clearTurn(compactTurnId);

    const ended = {
      compaction_id: compactionId,
      conversation_id: conversationId,
      tail_message_ids: [] as string[],
      tokens_before: tokensBefore,
      tokens_after: tokensAfter,
      messages_compacted: messagesCompacted,
      pre_compact_leaf_id: preCompactLeafId,
      model: effectiveModel,
      focus,
    };
    resolveTerminal({ kind: 'ended', ended });
    if (!res.writableEnded && !controller.signal.aborted) {
      terminalSent = true;
      writeEnded(res, ended);
      res.end();
    } else if (!res.writableEnded) {
      // Aborted after persist (e.g. disconnect raced commit): still resolve
      // waiters, but never write partial state to a dead socket.
      terminalSent = true;
      try {
        res.end();
      } catch {
        // ignore
      }
    } else {
      terminalSent = true;
    }
  } catch (err) {
    const code = typeof (err as { code?: unknown }).code === 'string' ? String((err as { code: string }).code) : 'summary_failed';
    const reason =
      typeof (err as { reason?: unknown }).reason === 'string'
        ? String((err as { reason: string }).reason)
        : errorMessage(err, 'Summary failed');
    releaseClaim();
    clearTurn(compactTurnId);
    resolveTerminal({ kind: 'failed', code, reason });
    if (!res.writableEnded && !res.destroyed) {
      // Client disconnect: the socket is dead; resolve waiters but write nothing.
      if (controller.signal.aborted && res.closed) {
        terminalSent = true;
      } else {
        terminalSent = true;
        writeFailed(res, conversationId, code, reason);
        res.end();
      }
    } else {
      terminalSent = true;
    }
  } finally {
    cleanup();
  }
});

router.post('/:id/fork', (req: AuthRequest, res: Response): void => {
  try {
    const userId = req.userId;
    if (!userId) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    const conversationId = req.params.id;
    const labelRaw = (req.body as { label?: unknown } | undefined)?.label;
    if (labelRaw !== undefined && labelRaw !== null && typeof labelRaw !== 'string') {
      res.status(400).json({ code: 'invalid_label', error: 'label must be a string' });
      return;
    }
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ? AND user_id = ?').get(conversationId, userId) as
      | { id: string; user_id: string; agent_id: string | null; title: string; model: string | null; provider_routing: string | null }
      | undefined;
    if (!conversation) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }

    const leafRow = db.prepare('SELECT active_leaf_id FROM conversations WHERE id = ?').get(conversationId) as
      | { active_leaf_id: string | null }
      | undefined;
    const threadIds = buildThreadIds(conversationId, leafRow?.active_leaf_id ?? null);
    const allRows = db.prepare('SELECT * FROM messages WHERE conversation_id = ?').all(conversationId) as Record<string, unknown>[];
    const byId = new Map<string, Record<string, unknown>>(allRows.map((r) => [String(r.id), r]));
    const threadRows = threadIds.map((id) => byId.get(id)).filter((r): r is Record<string, unknown> => !!r);
    let lastCompIdx = -1;
    for (let i = 0; i < threadRows.length; i++) {
      if (threadRows[i]!['role'] === 'compaction') lastCompIdx = i;
    }
    if (lastCompIdx < 0) {
      res.status(400).json({ code: 'nothing_to_fork', error: 'No checkpoint to fork' });
      return;
    }
    const slice = threadRows.slice(lastCompIdx);

    const label = typeof labelRaw === 'string' && labelRaw.trim() ? labelRaw.trim() : null;
    const title = label ?? `${conversation.title} (branch)`;
    const newId = nanoid();

    // Remap turn_ids per copied turn; the compaction copy's turn_id is its own new id.
    const turnMap = new Map<string, string>();
    const copies: Array<{ src: Record<string, unknown>; newId: string; newTurnId: string; newParent: string | null }> = [];
    let prevNewId: string | null = null;
    for (const src of slice) {
      const fresh = nanoid();
      const srcTurn = typeof src['turn_id'] === 'string' && (src['turn_id'] as string) ? String(src['turn_id']) : null;
      let newTurn: string;
      if (src['role'] === 'compaction') {
        newTurn = fresh;
        if (srcTurn) turnMap.set(srcTurn, newTurn);
      } else if (srcTurn) {
        const mapped = turnMap.get(srcTurn);
        if (mapped) newTurn = mapped;
        else {
          newTurn = nanoid();
          turnMap.set(srcTurn, newTurn);
        }
      } else {
        newTurn = nanoid();
      }
      copies.push({ src, newId: fresh, newTurnId: newTurn, newParent: prevNewId });
      prevNewId = fresh;
    }

    const run = db.transaction(() => {
      db.prepare(
        `INSERT INTO conversations (id, user_id, agent_id, title, model, provider_routing) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(newId, userId, conversation.agent_id, title, conversation.model, conversation.provider_routing);
      const insert = db.prepare(
        `INSERT INTO messages (id, conversation_id, role, content, provider_routing, tokens_used, prompt_tokens, completion_tokens, cost, annotations, reasoning_content, reasoning_tokens, cached_tokens, tool_call_id, tool_calls, attachments, model, processed_by_agent_id, processed_by_agent_name, parent_id, turn_id, variant_seq, generation_status, compaction_meta, council_run_id, is_council_synthesis, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
      );
      for (const c of copies) {
        const s = c.src;
        insert.run(
          c.newId,
          newId,
          String(s['role']),
          String(s['content'] ?? ''),
          (s['provider_routing'] as string | null) ?? null,
          (s['tokens_used'] as number | null) ?? 0,
          (s['prompt_tokens'] as number | null) ?? 0,
          (s['completion_tokens'] as number | null) ?? 0,
          (s['cost'] as number | null) ?? 0,
          (s['annotations'] as string | null) ?? null,
          (s['reasoning_content'] as string | null) ?? null,
          (s['reasoning_tokens'] as number | null) ?? 0,
          (s['cached_tokens'] as number | null) ?? 0,
          (s['tool_call_id'] as string | null) ?? null,
          (s['tool_calls'] as string | null) ?? null,
          (s['attachments'] as string | null) ?? null,
          (s['model'] as string | null) ?? null,
          (s['processed_by_agent_id'] as string | null) ?? null,
          (s['processed_by_agent_name'] as string | null) ?? null,
          c.newParent,
          c.newTurnId,
          (s['variant_seq'] as number | null) ?? 1,
          (s['compaction_meta'] as string | null) ?? null,
          (s['council_run_id'] as string | null) ?? null,
          (s['is_council_synthesis'] as number | null) ?? 0,
          (s['created_at'] as string | null) ?? new Date().toISOString(),
        );
      }
      db.prepare(`UPDATE conversations SET active_leaf_id = ?, updated_at = datetime('now') WHERE id = ?`).run(
        copies[copies.length - 1]!.newId,
        newId,
      );
    });
    run();

    const created = db.prepare(
      `SELECT c.*, a.name as agent_name, a.emoji as agent_emoji FROM conversations c LEFT JOIN agents a ON c.agent_id = a.id WHERE c.id = ?`,
    ).get(newId) as Record<string, unknown>;
    res.status(201).json(created);
  } catch (err) {
    console.error('Error forking conversation:', err);
    res.status(500).json({ error: 'Failed to fork conversation' });
  }
});

export default router;
